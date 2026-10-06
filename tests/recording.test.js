'use strict';

// The single integration test: real Electron UI + three real Python devices,
// default 1,000 frames/s for five minutes, then the real Save File handler.
// Run: npm test. Optional interpreter path: PAINLAB_TEST_PYTHON.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.resolve(__dirname, '..');
const framesPerDevice = 300000;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function launch() {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'painlab-recording-test-'));
    const env = { ...process.env, PAINLAB_TEST_OUTPUT_DIR: directory };
    delete env.ELECTRON_RUN_AS_NODE;
    let passed = false, tail = '';
    const child = spawn(require('electron'), [__filename], { cwd: root, env, stdio: ['inherit', 'pipe', 'inherit'] });
    child.stdout.on('data', chunk => {
        process.stdout.write(chunk);
        tail = (tail + chunk).slice(-256);
        if (tail.includes('PASS: all 900,000 frames were recorded and saved correctly.')) passed = true;
    });
    const stop = () => child.kill();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const [code] = await once(child, 'close');
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (code === 0 && passed) {
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
        await fsp.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } else console.error(`Test output retained: ${directory}`);
    process.exitCode = code === 0 && passed ? 0 : 1;
}

async function* journal(file, optional = false, cutoff = Infinity) {
    try { await fsp.access(file); }
    catch (error) { if (optional && error.code === 'ENOENT') return; throw error; }
    const input = fs.createReadStream(file);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
        for await (const line of lines) {
            const record = JSON.parse(line);
            if (record.seq > cutoff) break;
            yield record;
        }
    }
    finally { lines.close(); input.destroy(); }
}

// Validate the export's JSON array syntax without collecting the array. The
// real aggregator writes one JSON object per line, with commas after records.
async function* savedArray(file) {
    const input = fs.createReadStream(file);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let opened = false, closed = false, previous = null;
    try {
        for await (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            assert.equal(closed, false, 'data after closing JSON array');
            if (!opened) { assert.equal(line, '['); opened = true; continue; }
            if (line === ']') {
                if (previous !== null) yield JSON.parse(previous);
                closed = true;
            } else {
                if (previous !== null) {
                    assert.ok(previous.endsWith(','), 'missing array separator');
                    yield JSON.parse(previous.slice(0, -1));
                }
                previous = line;
            }
        }
        assert.ok(opened && closed, 'incomplete JSON array');
    } finally { lines.close(); input.destroy(); }
}

async function verify(dataHub, prefix, ids, cutoff) {
    const descriptors = {};
    for await (const record of journal(path.join(dataHub.sessionDir, 'descriptors.ndjson'), false, cutoff)) {
        descriptors[record.data.device_id] = record.data;
    }
    assert.deepEqual(Object.keys(descriptors).sort(), [...ids].sort());
    const control = { log: [] };
    for await (const record of journal(path.join(dataHub.sessionDir, 'log.ndjson'), false, cutoff)) control.log.push(record.data);
    for (const id of ids) {
        assert.equal(descriptors[id].visual_report.data_rate, 1000);
        const hex = Buffer.from(id).toString('hex');
        control[id] = [];
        for await (const record of journal(path.join(dataHub.sessionDir, `control-${hex}.ndjson`), true, cutoff)) {
            control[id].push(record.data);
        }
        const original = journal(path.join(dataHub.sessionDir, `device-${hex}.ndjson`), false, cutoff);
        let count = 0, lastSequence = 0;
        for await (const frame of savedArray(`${prefix}__Device_Data_${descriptors[id].device_type}__.json`)) {
            const record = await original.next();
            assert.equal(record.done, false, `${id}: exported extra frame`);
            assert.ok(record.value.seq > lastSequence, `${id}: journal sequence is not increasing`);
            lastSequence = record.value.seq;
            assert.deepEqual(frame, record.value.data, `${id}: export differs at frame ${count + 1}`);
            assert.equal(frame.sequence, ++count, `${id}: missing, duplicated or reordered frame`);
        }
        assert.equal((await original.next()).done, true, `${id}: unexported journal frame`);
        assert.equal(count, framesPerDevice, `${id}: wrong frame count`);
        console.log(`Verified ${id}: ${count} journal and exported frames match.`);
    }
    for (const [suffix, expected] of [['__Device_Descriptors__.json', descriptors], ['__Control_Data__.json', control]]) {
        const file = prefix + suffix;
        assert.ok((await fsp.stat(file)).size < 1024 * 1024, 'unexpectedly large metadata output');
        assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), expected);
    }
}

async function runElectron() {
    const { app, dialog } = require('electron');
    const directory = process.env.PAINLAB_TEST_OUTPUT_DIR;
    assert.ok(directory, 'Run this test with node tests/recording.test.js');
    process.chdir(root);
    process.env.PAINLAB_RECORDING_ROOT = path.join(directory, 'sessions');
    fs.mkdirSync(path.join(directory, 'profile'), { recursive: true });
    app.setPath('userData', path.join(directory, 'profile'));
    const prefix = path.join(directory, 'saved');
    const children = [];
    let dataHub, server, progress, rejectFailure;
    const failed = new Promise((_, reject) => { rejectFailure = reject; });
    process.on('uncaughtException', rejectFailure);
    process.on('unhandledRejection', rejectFailure);
    const deadline = setTimeout(() => rejectFailure(new Error('Test exceeded seven minutes')), 420000);
    const work = async () => {
        let saved, saveCutoff;
        const saveFinished = new Promise(resolve => { saved = resolve; });
        dialog.showSaveDialog = async () => {
            saveCutoff = dataHub.sequence;
            return { canceled: false, filePath: prefix };
        };
        dialog.showMessageBox = async (...args) => {
            const options = args[args.length - 1];
            assert.equal(options.message, 'All device data saved.', 'unexpected application dialog');
            saved();
            return { response: 0 };
        };
        const loaded = new Promise((resolve, reject) => app.once('browser-window-created', (_, win) => {
            win.webContents.once('did-finish-load', () => resolve(win));
            win.webContents.once('did-fail-load', (_, code, message) => reject(new Error(`Renderer load failed: ${code} ${message}`)));
            win.webContents.on('render-process-gone', (_, details) => rejectFailure(new Error(`Renderer stopped: ${details.reason}`)));
        }));
        // Bind only this test app's default listener to an unused port. Restore
        // net immediately; never connect to another running app on port 8124.
        const listen = net.Server.prototype.listen;
        net.Server.prototype.listen = function (...args) {
            if (args[0] === 8124 && args[1] === '127.0.0.1') args[0] = 0;
            return listen.apply(this, args);
        };
        try { require('../main.js'); } finally { net.Server.prototype.listen = listen; }
        ({ dataHub } = require('../backend/data.js'));
        server = require('../backend/server.js').activeServers['127.0.0.1'];
        if (!server.listening) await once(server, 'listening');
        const win = await loaded;
        const ids = [1, 2, 3].map(index => `test-${process.pid}-${index}`);
        const started = Date.now();
        console.log(`Real Electron recording test: 3 devices × 1,000 FPS × 5 minutes; port ${server.address().port}`);
        const runs = ids.map((id, index) => {
            const child = spawn(process.env.PAINLAB_TEST_PYTHON || 'python', [
                '-B',
                path.join(root, 'clients/python/driver.py'), '--name', `Recording test ${index + 1}`,
                '--id', id, '--port', String(server.address().port), '--frames', String(framesPerDevice)
            ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            const record = { child, closed: false, output: '' };
            children.push(record);
            for (const stream of [child.stdout, child.stderr]) {
                stream.setEncoding('utf8');
                stream.on('data', text => { record.output = (record.output + text).slice(-8192); });
            }
            record.done = new Promise((resolve, reject) => {
                child.once('error', reject);
                child.once('close', (code, signal) => {
                    record.closed = true;
                    try {
                        assert.equal(code, 0, `${id} stopped (${signal || code}):\n${record.output}`);
                        const summary = record.output.match(/finished: generated=(\d+) queued_total=(\d+) sent=(\d+) acknowledged=(\d+) dropped=(\d+) unacknowledged=(\d+)/);
                        assert.ok(summary, `${id}: missing final driver summary\n${record.output}`);
                        assert.deepEqual(summary.slice(1).map(Number), [framesPerDevice, framesPerDevice, framesPerDevice, framesPerDevice, 0, 0], id);
                        resolve();
                    } catch (error) { reject(error); }
                });
            });
            return record.done;
        });
        progress = setInterval(() => console.log(`${Math.floor((Date.now() - started) / 1000)}s: ` +
            ids.map(id => `${id}=${dataHub.frameCounts()[id]?.frames_received || 0}`).join(', ')), 30000);
        await Promise.all(runs);
        await delay(Math.max(0, 300000 - (Date.now() - started)));
        const entries = await win.webContents.executeJavaScript(
            "Array.from(document.querySelectorAll('#device-select-panel .device-entry'), entry => entry.id)");
        assert.deepEqual(entries.sort(), ids.map(id => `entry${id}`).sort());
        for (const id of ids) assert.equal(dataHub.frameCounts()[id].frames_received, framesPerDevice);
        console.log('Invoking the real Save File handler through renderer IPC...');
        await win.webContents.executeJavaScript("require('electron').ipcRenderer.send('menu-action', 'save-all-data')");
        await saveFinished;
        await dataHub.close();
        await verify(dataHub, prefix, ids, saveCutoff);
    };
    let code = 0;
    try { await Promise.race([work(), failed]); console.log('PASS: all 900,000 frames were recorded and saved correctly.'); }
    catch (error) { code = 1; console.error(error.stack || error); console.error(`Test output retained: ${directory}`); }
    finally {
        clearTimeout(deadline);
        clearInterval(progress);
        for (const record of children) if (!record.closed) record.child.kill();
        await Promise.allSettled(children.map(record => record.done));
        if (dataHub?.writer) await Promise.race([dataHub.close(), delay(5000)]).catch(() => {});
        if (server?.listening) server.close();
        app.exit(code); // Closes only this test Electron process and its real window.
    }
}

if (process.versions.electron) runElectron();
else launch().catch(error => { console.error(error); process.exitCode = 1; });
