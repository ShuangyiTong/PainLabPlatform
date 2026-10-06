'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');

fs.mkdirSync(workerData.sessionDir, { recursive: true });
const files = new Map();
function file(name) {
    if (!files.has(name)) files.set(name, fs.openSync(path.join(workerData.sessionDir, name), 'a'));
    return files.get(name);
}
file('descriptors.ndjson');
file('log.ndjson');

// Synchronous writes run only in this worker. Each message finishes before the
// next starts, so a flush message needs no locks or separate operation queue.
// File errors are deliberately uncaught and surface as a worker error.
parentPort.on('message', message => {
    if (message.kind === 'flush') {
        message.port.postMessage('flushed');
        message.port.close();
        return;
    }
    if (message.kind === 'close') {
        for (const descriptor of files.values()) fs.closeSync(descriptor);
        parentPort.close();
        return;
    }
    const name = message.kind === 'descriptor' ? 'descriptors.ndjson'
        : message.kind === 'log' ? 'log.ndjson'
        : `${message.kind === 'frame' ? 'device' : 'control'}-${Buffer.from(message.deviceId).toString('hex')}.ndjson`;
    fs.appendFileSync(file(name), JSON.stringify({ seq: message.seq, data: message.data }) + '\n');
    parentPort.postMessage('written');
});
