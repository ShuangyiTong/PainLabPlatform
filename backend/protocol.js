/* 
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  created on Apr 15, 2021
*/

const { ipcMain, Debugger } = require('electron');
const { dataHub } = require('./data.js');
const { env } = require('./env.js');

class ProtocolError extends Error {
    constructor(message) {
        super(message);
    }
}

var socketCount = 0;
var sockets = {};
var socketIDDeviceIDMap = {};
var deviceIDSocketIDMap = {};
var waitingReply = {};
var lastSentCommand = {}; // recording purposes
var errorState = {};
var controlDataQueue = {};
var simplifiedReplySockets = {};

/* ===== Round-trip ping =====
   A device that advertises support_rt_ping in its descriptor can be timed with
   a 4-byte "PING" frame — 00 00 00 04 50 49 4E 47 on the wire — which the
   device echoes straight back from its listener thread.

   Deliberately out of band: a ping goes out whether or not a control command is
   still awaiting its reply, and its echo never touches waitingReply or the
   control queue. That is what makes the number answer "how long would a command
   sent right now take", queueing included, rather than "how long does an idle
   link take" — but it is also why the echo cannot be recognised inside the
   waitingReply branch, since the common case is a ping with no command
   outstanding at all. It is matched ahead of that branch instead.

   Two devices never get pinged: one whose socket is in simplifiedReplySockets
   (no data_to_control, so it is acked with a bare byte and has no parser for a
   length-prefixed server frame), and one with a ping already in flight.

   Pings are written straight to the socket rather than through
   dataHub.prepareControlData(), so they stay out of the recording and out of
   the frames_sent count — the stats panel should not inflate itself with the
   traffic it generates. */
const PING_KEYWORD = "PING";
/* socketID : { in_flight, sent_at (hrtime), last_rtt (ms or null) }.

   A ping is never given up on and never resent. On a live TCP connection the
   frame arrives and the echo comes back, however late; if the connection is
   gone instead, that is a disconnect, and a reconnect allocates a new socketID
   with a new entry here — so there is nothing for a timeout to recover. What a
   timeout would add is a second ping alive at once, and since the echo is a
   fixed keyword carrying no identity, two in flight cannot be told apart: the
   overdue one gets credited against the newer one's send time and reports a
   few milliseconds after a spin of several seconds. One outstanding ping per
   socket makes every echo unambiguous by construction.

   The trade is that a device which accepts a ping and never echoes it leaves
   the panel waiting for the life of that connection. That reads correctly — the
   round trip really is unknown — and it is a device-side fault that resending
   would not clear either. */
var pingState = {};

const Buffer = require('buffer').Buffer;

function makeDataHandler(dataHubObj) {

    // Data from renderer
    function sendControlData(socketID) {
        if (controlDataQueue[socketID].length > 0) {
            if (!waitingReply[socketID]) {
                let sendBuf = dataHub.prepareControlData(socketIDDeviceIDMap[socketID], controlDataQueue[socketID][0]);
                sendBuf.writeInt32BE(sendBuf.length - 4);

                waitingReply[socketID] = 1;
                sockets[socketID].write(sendBuf, () => {});
                lastSentCommand[socketID] = controlDataQueue[socketID][0]; // record last send command
                controlDataQueue[socketID].shift();

                sendControlData(socketID);
            }
            else {
                // console.log("reply not received");
            }
        }
    }

    // TODO: only needs to be called once
    ipcMain.on('control-data', (event, arg) => {
        if (!(arg[0] in deviceIDSocketIDMap)) {
            if (arg[0] == 'log') {             
                let logFrame = arg[1];
                logFrame['timestamp'] = Date.now();
                dataHub.writeLog(logFrame);
            } else {
                console.log("Command send to device " + arg[0] + " does not exist! Did you put the wrong device id code?");
            }
        } else {
            let socketID = deviceIDSocketIDMap[arg[0]];
            // push data to the queue
            controlDataQueue[socketID].push(arg[1]);
            // try to send
            sendControlData(socketID);
        }
    });

    // Data from listener
    return { sender: sendControlData,
        listener: (socketID, bufObj) => {
        // already registered
        // console.log('data coming in');
        if (socketID in socketIDDeviceIDMap) {
            let ret = dataHubObj.saveFrame(socketIDDeviceIDMap[socketID], bufObj);
            if (ret != 0)
            {
                return 1;
            }
        } else { // new connection, must be a JSON descriptor
            let descriptor = JSON.parse(bufObj.toString());
            if (!'device_id' in descriptor) {
                console.log("descriptor sent by " + socketID + " doesn't have a device_id field");
                return 1;
            }
            socketIDDeviceIDMap[socketID] = descriptor['device_id'];
            deviceIDSocketIDMap[descriptor['device_id']] = socketID;
            if (env.winRef) {
                env.winRef.webContents.send('connected', socketIDDeviceIDMap[socketID]);
            }
        
            let ret = dataHubObj.registerDescriptor(descriptor);
            if (ret != 0)
            {
                return 1;
            }
            
            if (descriptor.data_to_control) {
                simplifiedReplySockets[socketID] = false;
            } else {
                simplifiedReplySockets[socketID] = true;
            }

            sockets[socketID].on('end', () => {
                env.winRef.webContents.send('disconnected', socketIDDeviceIDMap[socketID]);
                console.log('device ' + socketIDDeviceIDMap[socketID] + ' sent FIN');
            });

            sockets[socketID].on('close', () => {
                env.winRef.webContents.send('disconnected', socketIDDeviceIDMap[socketID]);
                console.log('connection to ' + socketIDDeviceIDMap[socketID] + ' closed');
            });
        }

        return 0;
    }}
}

function makeListener(dataHandler, socket) {
    var numBytes = "NA";
    var numBytesReceived = 0;
    var chunks   = [];
    var headerBytes = Buffer.alloc(0); // partial length prefix carried over from the previous chunk
    var socketID = socketCount++;
    sockets[socketID] = socket;
    waitingReply[socketID] = 0;
    errorState[socketID] = 0;
    controlDataQueue[socketID] = [];
    pingState[socketID] = { in_flight: false, sent_at: 0n, last_rtt: null };

    function processChunk (chunk) {
        let startPos = 0;
        let stickyChunk = null;
        let handled = false;

        // check if the socket is in error
        if (errorState[socketID]) {
            console.log("Socket Error on " + socketID + " " + errorState[socketID]);
            return;
        }

        // if the received chunk belongs to a new transmission
        if (numBytes == "NA") {
            // the 4-byte length prefix is not guaranteed to arrive in one piece
            if (headerBytes.length > 0) {
                chunk = Buffer.concat([headerBytes, chunk]);
                headerBytes = Buffer.alloc(0);
            }
            if (chunk.length < 4) {
                headerBytes = Buffer.from(chunk); // copy, wait for the rest of the prefix
                return;
            }
            numBytes = chunk.readUIntBE(0, 4);
            startPos = 4;

            // console.log('Frame at socket ' + socketID + ' expected size: ' + numBytes);
        }

        if (numBytesReceived + chunk.length - startPos > numBytes) {
            let cut = numBytes - numBytesReceived;
            chunks.push(chunk.slice(startPos, startPos + cut));
            stickyChunk = chunk.slice(startPos + cut, chunk.length);
            numBytesReceived += cut;
        } else {
            if (startPos > 0) {
                chunks.push(chunk.slice(startPos));
            } else {
                chunks.push(chunk);
            }
            numBytesReceived += chunk.length - startPos;
        }
        
        if (numBytesReceived < numBytes) {
            return;
        } else if (numBytesReceived == numBytes) {
            // console.log("size matched: " + numBytesReceived);
            let ret = 0;
            let payloadBuf = (Buffer.concat(chunks));

            // reset closure variables
            numBytes = "NA";
            numBytesReceived = 0;
            chunks = [];

            // a reply is either OK, FAIL or a ping echo, check the size just to avoid translating too large string
            if (payloadBuf.length < 5) {
                let replyString = payloadBuf.toString('utf-8');
                /* Matched before the waitingReply branch, not inside it: a ping
                   is sent out of band, so most echoes arrive with no command
                   outstanding at all. It answers only itself — the control slot
                   and its queue are left exactly as they were. */
                if (replyString == PING_KEYWORD) {
                    recordPingReply(socketID);
                    handled = true;
                } else if (waitingReply[socketID]) {
                    if (replyString == 'OK') {
                        waitingReply[socketID] = 0;
                        dataHandler.sender(socketID);
                        handled = true;
                    } else if (replyString == 'FAIL') {
                        waitingReply[socketID] = 0;
                        dataHandler.sender(socketID);
                        handled = true;
                        console.log("Device sent FAIL on command: " + JSON.stringify(lastSentCommand[socketID]));
                        // TODO: record control reply
                    } else {
                        /* No catch-all else here as the possible case is binary 
                           response can be shorter than 5 bytes
                        */
                    }
                }
            }
            
            if (!handled) {
                ret = dataHandler.listener(socketID, payloadBuf);
                
                if (simplifiedReplySockets[socketID]) {
                    let simpRep = new Uint8Array(1);
                    if (ret != 0)
                    {
                        simpRep[0] = 255;
                    } else {
                        simpRep[0] = 1;
                    }
                    sockets[socketID].write(simpRep, () => {}); // one byte reply
                } else {
                    let message = "0000OK";
                    if (ret != 0)
                    {
                        message = "0000FAIL";
                    }
                    let messageBuf = Buffer.from(message, 'utf8');
                    messageBuf.writeInt32BE(messageBuf.length - 4);
                    sockets[socketID].write(messageBuf, () => {});
                }

                
            }

        } else {
            throw new ProtocolError("Num bytes: " + numBytes + ", actual recceived: " + numBytesReceived);
        }

        if (stickyChunk) {
            processChunk(stickyChunk);
        }

        return;
    }

    return processChunk;
}

var dataHandler = makeDataHandler(dataHub);

/* Echo received. Since only one ping is ever outstanding on a socket, an echo
   arriving while one is in flight is that ping's, and no correlation is needed
   beyond the flag. hrtime rather than Date.now() because it is monotonic and
   has the resolution to resolve a sub-millisecond link.

   An echo with nothing in flight is unsolicited — a device echoing of its own
   accord, or one answering across a reconnect — and is dropped rather than
   credited to a send that never happened. */
function recordPingReply(socketID) {
    let state = pingState[socketID];
    if (!state || !state.in_flight) {
        return;
    }
    state.last_rtt = Number(process.hrtime.bigint() - state.sent_at) / 1e6;
    state.in_flight = false;
}

/* How long the outstanding ping has been waiting, in ms, or null when none is.
   This is what the panel shows beside the spinner: an operator watching it turn
   needs to know whether that has been going on for 200 ms or 20 seconds, and
   with no timeout to cut it short the wait itself is the diagnostic. */
function pingWaitMs(socketID) {
    let state = pingState[socketID];
    if (!state || !state.in_flight) {
        return null;
    }
    return Number(process.hrtime.bigint() - state.sent_at) / 1e6;
}

/* Send one ping frame. Returns true if it went out. Eligibility by descriptor
   (support_rt_ping) is the caller's business — refused here only for the cases
   this module is the one that knows about. */
function pingDevice(deviceID) {
    if (!(deviceID in deviceIDSocketIDMap)) {
        return false;
    }
    let socketID = deviceIDSocketIDMap[deviceID];
    let socket = sockets[socketID];
    if (!socket || socket.destroyed) {
        return false;
    }
    // Acked with a bare byte, so it has no parser for a length-prefixed frame.
    if (simplifiedReplySockets[socketID]) {
        return false;
    }
    let state = pingState[socketID];
    /* One measurement outstanding at a time, for the life of the connection.
       This is the whole correlation scheme: no second ping exists to confuse an
       echo with, so a device that has gone quiet is simply still being waited
       on rather than accumulating a ping per poll. */
    if (!state || state.in_flight) {
        return false;
    }

    // "abcd" is the placeholder for the 4 byte BE length, as everywhere else.
    let sendBuf = Buffer.from("abcd" + PING_KEYWORD, 'utf8');
    sendBuf.writeInt32BE(sendBuf.length - 4);

    state.in_flight = true;
    state.sent_at = process.hrtime.bigint();
    socket.write(sendBuf, () => {});
    return true;
}

/* Per-device connection snapshot for the stats panel. Returns plain numbers and
   booleans rather than the queues themselves, so nothing that crosses IPC holds
   a reference into this module's state.

   Connection state is derived from the socket rather than tracked in a flag of
   its own: deviceIDSocketIDMap always points at the device's current socket (a
   reconnect allocates a new socketID and overwrites the entry here), so the
   socket's own destroyed flag cannot drift out of sync the way a separate
   boolean would. Note this leaves the previous socket's entries behind in
   sockets/controlDataQueue keyed by the old socketID — they are unreachable
   from this map, so they never show up twice. */
function getConnectionStats() {
    let stats = {};
    for (const deviceID in deviceIDSocketIDMap) {
        let socketID = deviceIDSocketIDMap[deviceID];
        let socket = sockets[socketID];
        let ping = pingState[socketID] || {};
        stats[deviceID] = {
            connected: socket ? !socket.destroyed : false,
            // Commands accepted from the renderer but not yet written out.
            pending_control: controlDataQueue[socketID] ? controlDataQueue[socketID].length : 0,
            // Why a queue is standing still: nothing more is written until the
            // device acknowledges the command already on the wire.
            awaiting_reply: waitingReply[socketID] ? true : false,
            // Null while a ping is outstanding as well as when none has ever
            // come back: in both cases the honest answer is that the current
            // round trip is not known yet.
            last_ping_ms: ping.in_flight ? null : (ping.last_rtt !== undefined ? ping.last_rtt : null),
            ping_in_flight: ping.in_flight === true,
            // How long the current wait has been going on, for the panel to
            // show while the round trip is still unknown.
            ping_wait_ms: pingWaitMs(socketID),
            // A bare-byte device has no frame parser to answer a ping with.
            pingable: simplifiedReplySockets[socketID] !== true
        };
    }
    return stats;
}

module.exports = {
    executeProtocol: function (socket) {
        socket.on('data', makeListener(dataHandler, socket));
    },
    getConnectionStats: getConnectionStats,
    pingDevice: pingDevice
}