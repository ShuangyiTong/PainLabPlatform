/* 
    Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
    created on Apr 15, 2021
*/
const { Worker, MessageChannel } = require('node:worker_threads');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const path = require('node:path');

const { env } = require('./env.js');
const Buffer = require('buffer').Buffer;

class DataHub {
    constructor({ sessionDir } = {}) {
        this.deviceDescriptors = {};
        this.deviceFrameCount = {};
        this.controlFrameCount = {};
        this.deviceSampleCount = {};
        // Match scripts and libraries: task data is relative to the working directory.
        this.sessionDir = path.resolve(sessionDir || path.join(
            process.env.PAINLAB_RECORDING_ROOT || path.join('instance', 'sessions'),
            randomBytes(12).toString('hex')));
        this.sequence = 0;
        this.pendingWrites = 0;
        this.writer = null;
    }

    getWriter() {
        if (!this.writer) {
            this.writer = new Worker(path.join(__dirname, 'recording', 'writer-worker.js'),
                { workerData: { sessionDir: this.sessionDir } });
            this.writer.on('message', () => { this.pendingWrites--; });
            this.writer.unref();
        }
        return this.writer;
    }

    write(kind, deviceId, data) {
        // Bound queued records without a second serialization on the main thread.
        // Errors (including worker file errors) are not caught or recovered here.
        if (this.pendingWrites >= 4096) throw new Error('Session writer queue is full');
        this.pendingWrites++;
        this.getWriter().postMessage({ kind, deviceId, data, seq: ++this.sequence });
    }

    flush() {
        const cutoff = this.sequence;
        const { port1, port2 } = new MessageChannel();
        const done = once(port1, 'message').then(() => { port1.close(); return cutoff; });
        this.getWriter().postMessage({ kind: 'flush', port: port2 }, [port2]);
        return done;
    }

    async close() {
        if (!this.writer) return;
        this.writer.ref();
        const done = once(this.writer, 'exit');
        this.writer.postMessage({ kind: 'close' });
        await done;
        this.writer = null;
    }

    registerDescriptor(descriptor) {
        let deviceID = descriptor['device_id'];

        if (deviceID in this.deviceDescriptors) {
            // reconnect, just log that
            console.log("deviceID " + deviceID + " reconnected");
            if (env.winRef) {
                env.winRef.webContents.send('connected', deviceID);
            }
        } else {
            this.deviceFrameCount[deviceID] = 0;
            this.controlFrameCount[deviceID] = 0;
            this.deviceSampleCount[deviceID] = 0;
            console.log("deviceID " + deviceID + " connected");
            // update render process
            if (env.winRef) {
                env.winRef.webContents.send('new-descriptor', [deviceID, descriptor]);
            }
        }
        this.deviceDescriptors[deviceID] = descriptor;
        this.write('descriptor', deviceID, descriptor);

        return 0;
    }

    saveFrame(deviceID, bufObj) {
        let frameFormat = this.deviceDescriptors[deviceID]['report_pack_order'];
        let binaryDecode = false;
        if (frameFormat) {
            if (frameFormat.order) {
                binaryDecode = true;
            }
        }

        if (binaryDecode) {
          if (frameFormat.packed) {
            let frameBatch = { timestamp: Date.now(), frames: [] };
            let frameOffset = 0;
            let dataFormat = this.deviceDescriptors[deviceID]['data_to_report'];
            while (frameOffset < bufObj.length) {
              let frameObj = {};
              frameFormat.order.forEach(item => {
                var decodedData;
                if (dataFormat[item] == 'uint32_t_le') {
                  decodedData = bufObj.readUInt32LE(frameOffset);
                  frameOffset += 4;
                } else if (dataFormat[item] == 'uint16_t_le') {
                  decodedData = bufObj.readUInt16LE(frameOffset);
                  frameOffset += 2;
                }
                frameObj[item] = decodedData;
              });
              frameBatch.frames.push(frameObj);
            }
            // Finalize the displayed batch before handing it to the writer.
            if (env.winRef && frameBatch.frames.length > 0
                && !this.deviceDescriptors[deviceID]['visual_report']['expand_packed']) {
                frameBatch.frames[frameBatch.frames.length - 1].timestamp = frameBatch.timestamp;
            }
            this.write('frame', deviceID, frameBatch);
            this.deviceFrameCount[deviceID]++;
            this.deviceSampleCount[deviceID] += frameBatch.frames.length;

            // send frame batch to front end
            if (env.winRef) {
              if (frameBatch.frames.length > 0) {
                if (this.deviceDescriptors[deviceID]['visual_report']['expand_packed']) {
                  env.winRef.webContents.send('new-dataframe', [deviceID, frameBatch.frames]);
                } else {
                  let frameToFront = frameBatch.frames[frameBatch.frames.length - 1];
                  frameToFront["timestamp"] = frameBatch.timestamp;
                  env.winRef.webContents.send('new-dataframe', [deviceID, frameToFront]);
                }
              }
            }
          } else {
            throw new Error("Not implemented yet");
          }
        } else {
            try
            {
                var frameObj = JSON.parse(bufObj.toString());
            }
            catch (error)
            {
                console.log(error);
                return 1;
            }
            frameObj['timestamp'] = Date.now();
            this.write('frame', deviceID, frameObj);
            this.deviceFrameCount[deviceID]++;
            this.deviceSampleCount[deviceID]++; // one frame, one sample on this path

            // send the frame to front end
            if (env.winRef) {
              if (frameFormat && frameFormat.packed) {
                let frameToFront = {timestamp: frameObj.timestamp};
                for (const prop in frameObj) {
                  if (prop != 'timestamp' && Array.isArray(frameObj[prop])) {
                    frameToFront[prop] = frameObj[prop];
                  } 
                }
                env.winRef.webContents.send('new-dataframe', [deviceID, frameToFront]);
              }
              else {
                env.winRef.webContents.send('new-dataframe', [deviceID, frameObj]);
              }
              
            }
        }

        return 0;
    }

    prepareControlData(deviceID, obj) {
        let frameFormat = this.deviceDescriptors[deviceID]['control_pack_order'];
        let controlFrame = null;

        if (frameFormat) {
            if (frameFormat == "serial") {
                controlFrame = Buffer.from("abcd" + obj['serial'], 'utf8'); // "abcd" is the placeholder for 4 byte BE length
            } else {
                throw new Error("not implemented yet.");
            }
        } else {
            controlFrame = Buffer.from("abcd" + JSON.stringify(obj), 'utf8'); // "abcd" is the placeholder for 4 byte BE length
        }

        obj['timestamp'] = Date.now();
        this.write('control', deviceID, obj);
        this.controlFrameCount[deviceID]++;
        return controlFrame;
    }

    writeLog(obj) {
      this.write('log', null, obj);
    }

    // Cumulative counts remain available without retaining complete histories.
    frameCounts() {
        let counts = {};
        for (const deviceID of Object.keys(this.deviceDescriptors)) {
            counts[deviceID] = {
                frames_received: this.deviceFrameCount[deviceID],
                samples_received: this.deviceSampleCount[deviceID] || 0,
                // Frames actually handed to the socket: prepareControlData()
                // pushes here at the moment one is written, not when queued.
                frames_sent: this.controlFrameCount[deviceID]
            };
        }
        return counts;
    }
}

var dataHub = new DataHub();
exports.dataHub = dataHub;
