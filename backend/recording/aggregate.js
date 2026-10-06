'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

// Capture complete lines only. The recorder may be midway through appending
// a later record when a live export opens a journal; that tail is excluded.
async function completeSize(file) {
    const handle = await fsp.open(file, 'r');
    try {
        let end = (await handle.stat()).size;
        const buffer = Buffer.alloc(Math.min(end, 65536));
        while (end) {
            const start = Math.max(0, end - buffer.length);
            const { bytesRead } = await handle.read(buffer, 0, end - start, start);
            const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
            if (newline >= 0) return start + newline + 1;
            end = start;
        }
        return 0;
    } finally { await handle.close(); }
}

async function aggregate(sessionDir, outputPrefix, cutoff = Infinity) {
    if (cutoff !== Infinity && (!Number.isSafeInteger(cutoff) || cutoff < 0)) {
        throw new Error('The sequence cutoff must be a nonnegative integer.');
    }
    sessionDir = path.resolve(sessionDir);
    outputPrefix = path.resolve(outputPrefix);
    const sizes = new Map();
    for (const file of await fsp.readdir(sessionDir)) {
        if (/^(descriptors|log|device-[0-9a-f]+|control-[0-9a-f]+)\.ndjson$/.test(file)) {
            sizes.set(file, await completeSize(path.join(sessionDir, file)));
        }
    }
    if (!sizes.has('descriptors.ndjson') || !sizes.has('log.ndjson')) {
        throw new Error('Expected descriptors.ndjson and log.ndjson in a flat session folder.');
    }

    async function* records(file) {
        const bytes = sizes.get(file) || 0;
        if (!bytes) return;
        const input = fs.createReadStream(path.join(sessionDir, file), { end: bytes - 1 });
        const lines = readline.createInterface({ input, crlfDelay: Infinity });
        try {
            for await (const line of lines) {
                const record = JSON.parse(line);
                if (record.seq > cutoff) break;
                yield record.data;
            }
        } finally { lines.close(); input.destroy(); }
    }

    const descriptors = Object.create(null);
    for await (const descriptor of records('descriptors.ndjson')) descriptors[descriptor.device_id] = descriptor;
    const devices = Object.keys(descriptors);
    const types = new Set();
    const deviceFiles = devices.map(id => {
        const type = String(descriptors[id].device_type).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        if (types.has(type.toLowerCase())) throw new Error(`Devices share the output filename for type "${type}". Give each device a unique device_type.`);
        types.add(type.toLowerCase());
        return `${outputPrefix}__Device_Data_${type}__.json`;
    });
    const outputs = [`${outputPrefix}__Device_Descriptors__.json`, `${outputPrefix}__Control_Data__.json`, ...deviceFiles];
    const journal = (kind, id) => `${kind}-${Buffer.from(id, 'utf8').toString('hex')}.ndjson`;

    async function* array(file) {
        yield '[\n';
        let first = true;
        for await (const data of records(file)) {
            if (!first) yield ',\n';
            first = false;
            yield JSON.stringify(data);
        }
        yield '\n]';
    }

    async function* descriptorObject() {
        yield '{';
        for (let index = 0; index < devices.length; index++) {
            const id = devices[index];
            yield `${index ? ',' : ''}${JSON.stringify(id)}:${JSON.stringify(descriptors[id])}`;
        }
        yield '}';
    }

    async function* controlObject() {
        yield '{"log":';
        yield* array('log.ndjson');
        for (const id of devices) {
            yield `,${JSON.stringify(id)}:`;
            yield* array(journal('control', id));
        }
        yield '}';
    }

    const write = (file, chunks) => pipeline(Readable.from(chunks, { objectMode: false }), fs.createWriteStream(file));
    await fsp.mkdir(path.dirname(outputPrefix), { recursive: true });
    await write(outputs[0], descriptorObject());
    await write(outputs[1], controlObject());
    for (let index = 0; index < devices.length; index++) {
        await write(deviceFiles[index], array(journal('device', devices[index])));
    }
    return outputs;
}

module.exports = { aggregate };
