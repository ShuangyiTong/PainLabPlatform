/* 
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  created on Nov 11, 2021
*/

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path')

let { env } = require('./env.js');
let { localDevCtrl } = require('./local-device.js');
let { dataHub } = require('./data.js');
let { getConnectionStats, pingDevice } = require('./protocol.js');

ipcMain.on('request-script-list', (event, arg) => {
    fs.readdir('./instance/saved_scripts', (err, files) => {
        if (env.winRef) {
            env.winRef.webContents.send('request-script-list', files);
        }
    });
});

ipcMain.on('request-script-content', (event, arg) => {
    filePath = path.join('./instance/saved_scripts', arg);

    fs.readFile(filePath, {encoding: 'utf-8'}, (err, content) => {
        if (err) {
            console.log(err);
            env.winRef.webContents.send('request-script-content', "reading file error");
        }
        if (env.winRef) {
            env.winRef.webContents.send('request-script-content', content);
        }
    });
});

/* Action scripts (instance/action_scripts) — same read-only pair as the saved
   scripts above, with two differences: only .js files are listed (the frontend
   parses every one of them at startup, so anything else is just a guaranteed
   parse error), and the content reply carries the file name alongside the
   content. The frontend requests all of them at once, so the name is what ties
   each reply back to the file that was asked for. */
ipcMain.on('request-action-script-list', (event, arg) => {
    fs.readdir('./instance/action_scripts', (err, files) => {
        if (err) {
            console.log(err);
        }
        if (env.winRef) {
            env.winRef.webContents.send('request-action-script-list',
                err ? [] : files.filter(f => f.endsWith('.js')));
        }
    });
});

ipcMain.on('request-action-script-content', (event, arg) => {
    let filePath = path.join('./instance/action_scripts', arg);

    fs.readFile(filePath, {encoding: 'utf-8'}, (err, content) => {
        if (err) {
            console.log(err);
        }
        if (env.winRef) {
            // [file name, content or null on failure, error message]
            env.winRef.webContents.send('request-action-script-content',
                err ? [arg, null, err.message] : [arg, content, null]);
        }
    });
});

ipcMain.on('save-script-content', (event, arg) => {
    filePath = path.join('./instance/saved_scripts', arg[0]);

    fs.writeFile(filePath, arg[1], {encoding: 'utf-8'}, (err, content) => {
        if (err) {
            console.log(err);
        }
    });
});

ipcMain.on('request-resources-list', (event, arg) => {
    fs.readdir('./instance/resources', (err, files) => {
        if (env.winRef) {
            env.winRef.webContents.send('request-resources-list', files);
        }
    });
});

ipcMain.on('request-resources-content', (event, arg) => {
    filePath = path.join('./instance/resources', arg);

    fs.readFile(filePath, {encoding: 'utf-8'}, (err, content) => {
        if (err) {
            console.log(err);
            env.winRef.webContents.send('request-resources-content', "reading file error");
        }
        if (env.winRef) {
            env.winRef.webContents.send('request-resources-content', content);
        }
    });
});

/* Runtime statistics for the device stats panel, joined from the two modules
   that own the numbers: protocol.js for the live socket and its control queue,
   data.js for the frame counts.

   Cumulative totals go over the wire, not rates. The renderer divides by the
   elapsed time between two replies using the timestamp below, which keeps the
   figures honest whether or not its poll fired on schedule (a busy renderer,
   a throttled timer), and leaves nothing here to reset between polls — this
   handler holds no state, so any number of pollers can ask without each one
   consuming the others' deltas. */
ipcMain.on('request-device-stats', (event, arg) => {
    if (!env.winRef) {
        return;
    }

    let connection = getConnectionStats();
    let counts = dataHub.frameCounts();
    let devices = {};

    /* Keyed off every device that has ever registered, not off the live
       sockets: one that has gone away stays in the panel marked disconnected,
       with its totals frozen, instead of silently vanishing. A reconnect fills
       the same entry back in — deviceData is kept across it, so the counters
       carry on from where they stopped rather than restarting. */
    for (const deviceID in dataHub.deviceDescriptors) {
        let conn = connection[deviceID] || {};
        let count = counts[deviceID] || {};

        /* Opt-in, per device, in the descriptor. conn.pingable is the second
           half of it: a device acked with a bare byte has no frame parser to
           answer with, whatever its descriptor claims. */
        let supports_ping = dataHub.deviceDescriptors[deviceID]['support_rt_ping'] === true
            && conn.pingable === true;

        devices[deviceID] = {
            name: dataHub.deviceDescriptors[deviceID]['name'] || deviceID,
            connected: conn.connected === true,
            awaiting_reply: conn.awaiting_reply === true,
            pending_control: conn.pending_control || 0,
            frames_received: count.frames_received || 0,
            samples_received: count.samples_received || 0,
            frames_sent: count.frames_sent || 0,
            supports_ping: supports_ping,
            // Null means "not known yet" — either in flight or never answered.
            // The renderer shows the waiting indicator for it.
            ping_ms: supports_ping ? (conn.last_ping_ms !== undefined ? conn.last_ping_ms : null) : null,
            // Non-null only while one is outstanding: how long it has been so.
            ping_wait_ms: supports_ping ? (conn.ping_wait_ms !== undefined ? conn.ping_wait_ms : null) : null
        };

        /* Fired after the reading above is taken, never waited on: the poll runs
           on a fixed one-second cycle and a round trip cannot be given a
           deadline inside it. So each poll reports the measurement the previous
           poll started and kicks off the next one. pingDevice() refuses while
           one is still outstanding — a ping is never abandoned or resent, so a
           device that has gone quiet is waited on rather than pinged again, and
           only one echo is ever in the air to be accounted for. */
        if (supports_ping && conn.connected === true) {
            // record the current reported 
            dataHub.writeLog({"ping update": deviceID + " pinged with " + JSON.stringify(conn), "timestamp": Date.now()});
            pingDevice(deviceID);
        }
    }

    env.winRef.webContents.send('request-device-stats', {
        timestamp: Date.now(),
        devices: devices
    });
});

ipcMain.on('start-local-program', (event, arg) => {
    // arg: [exec_path, launch_args, need_shell] — cwd decoded from the executable path
    let launch_args = Array.isArray(arg[1]) ? arg[1] : [];
    localDevCtrl.startProgram([path.dirname(arg[0]), path.basename(arg[0]), ...launch_args], arg[2])
    .then((ret) => { // numerical ref handle on success, error string otherwise
        if (env.winRef) {
            env.winRef.webContents.send('start-program-return', ret);
        }
    });
});

ipcMain.on('close-local-program', (event, arg) => {
    let ret = localDevCtrl.closeProgram(arg);
    if (env.winRef) {
        // 0 means killed: echo the handle back so the frontend knows which
        // program closed; otherwise forward the error string.
        env.winRef.webContents.send('close-program-return', ret === 0 ? arg : ret);
    }
});

ipcMain.on('list-program', (event, arg) => {
    if (env.winRef) {
        env.winRef.webContents.send('list-program-return', localDevCtrl.listProgram());
    }
});

/* Captured stdout/stderr for one program, pulled on demand — the frontend asks
   when the operator selects a program or hits refresh, and at no other time.
   Collection itself never stops (it can't; see attachOutputCapture), so this
   only ever reads a buffer that is already in memory.

   arg: [ref_handle, request_id]. The request id is echoed back untouched, and
   the reply carries the handle it belongs to. Both are for the frontend's
   benefit: two fetches can be in flight at once (a fast second click, or a
   refresh landing on top of a selection), and between them they let it tell
   which reply is the newest and which program it is for, instead of rendering
   whichever one happened to arrive last. */
ipcMain.on('request-program-stdout', (event, arg) => {
    if (!env.winRef) {
        return;
    }
    let reply = localDevCtrl.getProgramLog(arg[0]);
    reply.request_id = arg[1];
    env.winRef.webContents.send('request-program-stdout', reply);
});

/* Programs that exit on their own (crash or normal termination) are reported
   through the same route as operator-initiated closes, so the frontend frees
   its callback entry and greys the program out either way.
   TODO: separate self-exit from operator close (e.g. a dedicated
   'program-exited' channel) so the frontend can tell them apart. */
localDevCtrl.onProgramExit = (ref_handle) => {
    if (env.winRef) {
        env.winRef.webContents.send('close-program-return', ref_handle);
    }
};