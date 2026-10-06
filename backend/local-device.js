/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  created on Jun 11, 2026

  Manages locally spawned device programs (executables shipped under
  instance/integrated_devices). All error handling is done through return
  values — no function here throws.
*/

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const INTEGRATED_DEVICES_DIR = path.join('instance', 'integrated_devices');

/* Output retained per program, and how many finished programs keep theirs.
   Both caps are on the small side deliberately: the panel shows a tail, not an
   archive, and everything here is resident memory. 256 KB is a few thousand
   lines of typical device chatter. */
const MAX_PROGRAM_LOG_BYTES = 256 * 1024;
const MAX_FINISHED_LOGS = 20;

/* A capped, interleaved record of one program's stdout and stderr.

   Chunks are kept as the raw Buffers the pipes hand over and are only decoded
   when someone asks to read the log, which is the whole point of the design:
   the per-chunk path (the hot one — it runs for every line a program prints,
   whether or not anybody is watching) is a push and an integer add, and the
   decode happens once per operator click instead of once per line. Deferring
   the decode also gets multi-byte characters split across a chunk boundary
   right for free, since the halves are rejoined before any of it is decoded.

   Both streams share one chunk list rather than getting a buffer each: keeping
   them apart would lose the interleaving, and the order in which a program
   printed a message and then failed is usually the thing you opened the panel
   to find out. */
class ProgramLog {
    constructor(exec_name) {
        this.exec_name = exec_name;
        this.chunks = [];        // [{ fd: 1|2, buf: Buffer }], oldest first
        this.bytes = 0;          // total held in chunks, kept <= MAX_PROGRAM_LOG_BYTES
        this.dropped_bytes = 0;  // trimmed off the front to stay under the cap
        this.running = true;
        this.exit_code = null;
        this.exit_signal = null;
    }

    append(fd, buf) {
        if (buf.length === 0) return;
        this.chunks.push({ fd: fd, buf: buf });
        this.bytes += buf.length;

        // Trim whole chunks off the front, then a partial one to land exactly on
        // the cap. subarray() is a view over the same memory, so the partial
        // trim copies nothing.
        while (this.bytes > MAX_PROGRAM_LOG_BYTES) {
            let over = this.bytes - MAX_PROGRAM_LOG_BYTES;
            let head = this.chunks[0];
            if (head.buf.length <= over) {
                this.chunks.shift();
                this.bytes -= head.buf.length;
                this.dropped_bytes += head.buf.length;
            } else {
                head.buf = head.buf.subarray(over);
                this.bytes -= over;
                this.dropped_bytes += over;
            }
        }
    }

    /* Decoded output as [{ stream: 'out'|'err', text }], adjacent chunks from
       the same stream merged so the frontend gets a handful of segments to
       render rather than one per write. */
    segments() {
        let out = [];
        let run = [];
        let run_fd = 0;

        const flush = () => {
            if (run.length === 0) return;
            out.push({
                stream: run_fd === 2 ? 'err' : 'out',
                text: Buffer.concat(run).toString('utf8')
            });
            run = [];
        };

        for (const chunk of this.chunks) {
            if (chunk.fd !== run_fd) {
                flush();
                run_fd = chunk.fd;
            }
            run.push(chunk.buf);
        }
        flush();
        return out;
    }
}

class LocalDeviceController {
    constructor() {
        this.spawned_programs = {}; // ref_handle -> ChildProcess
        this.program_logs = {};     // ref_handle -> ProgramLog, kept past exit
        this.finished_order = [];   // ref handles of exited programs, oldest first
        this.next_ref_handle = 1;
        this.onProgramExit = null;  // optional hook: called with ref_handle when a tracked program exits on its own
    }

    /* Finished programs keep their output so the operator can still read why one
       died, but not forever — the oldest is discarded once MAX_FINISHED_LOGS
       have piled up. Running programs are never candidates: their entry is still
       live in the panel. */
    retireProgramLog(ref_handle) {
        this.finished_order.push(ref_handle);
        while (this.finished_order.length > MAX_FINISHED_LOGS) {
            delete this.program_logs[this.finished_order.shift()];
        }
    }

    /* args: [working_directory, executable_name, ...launch_args]
       Resolves to a numerical ref_handle on success, or an error string on
       any spawn failure (resolved, never rejected — callers don't need
       try/catch). The handle only becomes valid once the OS confirms the
       process actually started ('spawn' event), so a bad path or missing
       binary comes back as an error string instead of a dead handle. */
    startProgram(args, need_shell = false) {
        return new Promise((resolve) => {
            if (!Array.isArray(args) || args.length < 2) {
                resolve("startProgram expects [working_directory, executable_name, ...launch_args]");
                return;
            }
            const cwd = args[0];
            const executable = path.isAbsolute(args[1]) ? args[1] : path.resolve(cwd, args[1]);
            const launch_args = args.slice(2);

            let child;
            try {
                child = spawn(executable, launch_args, {
                    cwd: cwd,
                    detached: false, // keep it a direct child so child.kill() reaches it
                    // stdin stays ignored (the child sees EOF, as it always has);
                    // stdout and stderr are piped so their output can be shown in
                    // the panel. See attachOutputCapture for the obligation that
                    // piping carries.
                    stdio: ['ignore', 'pipe', 'pipe'],
                    shell: need_shell
                });
            } catch (e) {
                resolve("Failed to spawn " + executable + ": " + e.message);
                return;
            }

            /* Wired up before the 'spawn' event rather than inside it, so a
               program that prints and dies immediately still has every byte of
               it captured. */
            const log = this.attachOutputCapture(child, path.basename(executable));

            let settled = false;
            child.once('error', (err) => {
                // Pre-'spawn' error means the process never started (ENOENT etc.)
                if (settled) return;
                settled = true;
                resolve("Failed to spawn " + executable + ": " + err.message);
            });
            child.once('spawn', () => {
                if (settled) return;
                settled = true;
                const ref_handle = this.next_ref_handle++;
                this.spawned_programs[ref_handle] = child;
                this.program_logs[ref_handle] = log;
                child.once('exit', () => {
                    // closeProgram already removed (and reported) operator-
                    // initiated kills; only self-exits are still tracked here.
                    if (!(ref_handle in this.spawned_programs)) return;
                    delete this.spawned_programs[ref_handle];
                    if (this.onProgramExit) this.onProgramExit(ref_handle);
                });
                /* 'close' rather than 'exit' for the log's own bookkeeping:
                   'exit' fires while the pipes may still hold output the program
                   wrote on its way out, and 'close' is what says there is no
                   more coming. It also fires for operator kills, which the
                   'exit' handler above deliberately skips. */
                child.once('close', (code, signal) => {
                    log.running = false;
                    log.exit_code = code;
                    log.exit_signal = signal;
                    this.retireProgramLog(ref_handle);
                });
                resolve(ref_handle);
            });
        });
    }

    /* Starts draining the child's pipes into a ProgramLog.

       This is not optional once stdio is piped: a pipe nobody reads fills its
       OS-side buffer (a few KB on Windows) and the child then blocks forever on
       its next write — a chatty program would hang mid-experiment. So capture
       runs for every program from spawn to exit, whether or not the panel is
       showing it; what the frontend controls is when the log is *read*, not
       whether it is collected.

       The 'error' handlers are what keep a broken pipe (a killed program, an
       EPIPE on teardown) from reaching the process as an uncaught exception and
       taking the app down with it. There is nothing to do about one — the
       stream is finished either way — so they swallow it. */
    attachOutputCapture(child, exec_name) {
        const log = new ProgramLog(exec_name);
        if (child.stdout) {
            child.stdout.on('data', (buf) => log.append(1, buf));
            child.stdout.on('error', () => {});
        }
        if (child.stderr) {
            child.stderr.on('data', (buf) => log.append(2, buf));
            child.stderr.on('error', () => {});
        }
        return log;
    }

    /* Snapshot of one program's captured output, for the frontend's on-demand
       fetch. Always resolves to an object — a handle whose log has aged out of
       MAX_FINISHED_LOGS comes back with found: false rather than an error, since
       from the panel's side that is a display state, not a failure. */
    getProgramLog(ref_handle) {
        const log = this.program_logs[ref_handle];
        if (!log) {
            return { ref_handle: ref_handle, found: false };
        }
        return {
            ref_handle: ref_handle,
            found: true,
            exec_name: log.exec_name,
            running: log.running,
            exit_code: log.exit_code,
            exit_signal: log.exit_signal,
            bytes: log.bytes,
            dropped_bytes: log.dropped_bytes,
            segments: log.segments()
        };
    }

    /* Returns 0 when the kill signal was delivered, an error string otherwise. */
    closeProgram(ref_handle) {
        const child = this.spawned_programs[ref_handle];
        if (!child) {
            return "No running program found for handle " + ref_handle;
        }
        try {
            if (!child.kill()) {
                return "Failed to kill program (handle " + ref_handle + ", pid " + child.pid + ")";
            }
        } catch (e) {
            return "Error killing program (handle " + ref_handle + "): " + e.message;
        }
        delete this.spawned_programs[ref_handle];
        return 0;
    }

    /* Scans instance/integrated_devices for program folders. A folder counts
       as a program when it contains an executable named after the folder
       (with .exe appended on Windows). Returns the executable paths. */
    listProgram() {
        let programs = [];
        let entries;
        try {
            entries = fs.readdirSync(INTEGRATED_DEVICES_DIR, { withFileTypes: true });
        } catch (e) {
            return programs;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const exec_name = process.platform === 'win32' ? entry.name + '.exe' : entry.name;
            const exec_path = path.join(INTEGRATED_DEVICES_DIR, entry.name, exec_name);
            if (fs.existsSync(exec_path)) {
                programs.push(exec_path);
            }
        }
        return programs;
    }
}

var localDevCtrl = new LocalDeviceController();

exports.LocalDeviceController = LocalDeviceController;
exports.localDevCtrl = localDevCtrl;
