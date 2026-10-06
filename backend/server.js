/*
  Shuangyi Tong <shuangyi.tong@eng.ox.ac.uk>
  created on Apr 15, 2021
*/

const net = require('net');
const { executeProtocol } = require('./protocol.js');

const PORT = 8124;

/* Global registry of active listening servers.
   Key:   bound IP address (string)
   Value: net.Server instance
   Because server.listen() can only be called once per Server, we create a
   fresh net.Server for each IP and stash it here so we can look it up later
   for shutdown / duplicate checking. */
const activeServers = {};

function handleNewConnection(socket) {
    socket.on('error', (err) => {
        console.log(err);
    });
    console.log('a new connection established');
    executeProtocol(socket);
}

/**
 * Try to bind a new TCP server on `ip` at PORT.
 *
 * @param {string}   ip         - IP address to bind to.
 * @param {function} [onSuccess] - Called with no args when listen() succeeds.
 * @param {function} [onError]   - Called with an error-message string if
 *                                 binding fails (sync or async).
 * @returns {boolean} false if `ip` is already registered (no server created),
 *                    true otherwise (a server was created — success/failure
 *                    is reported through the callbacks).
 */
function createListeningServer(ip, onSuccess, onError) {
    if (ip in activeServers) {
        const msg = `Already listening on ${ip}:${PORT}`;
        console.log(msg);
        if (onError) onError(msg);
        return false;
    }

    const server = net.createServer(handleNewConnection);
    // Reserve the slot synchronously so concurrent callers see the IP as taken
    activeServers[ip] = server;

    let bound = false;

    server.on('error', (err) => {
        console.log(`Server error on ${ip}:${PORT} — ${err.message}`);
        if (!bound) {
            // Bind-time failure: clean up the reservation
            delete activeServers[ip];
            try { server.close(); } catch (e) { /* ignore */ }
            if (onError) onError(err.message);
        }
    });

    try {
        server.listen(PORT, ip, () => {
            bound = true;
            console.log(`Server bound to ${ip}:${PORT}`);
            if (onSuccess) onSuccess();
        });
    } catch (e) {
        // Synchronous throw (e.g. malformed IP) — error event won't fire
        delete activeServers[ip];
        console.log(`Failed to listen on ${ip}:${PORT} — ${e.message}`);
        if (onError) onError(e.message);
    }

    return true;
}

/**
 * Stop listening on `ip` and remove its entry from activeServers.
 * The IP slot is freed synchronously; the underlying socket closes async
 * after pending connections drain. Returns false if `ip` was not registered.
 */
function closeListeningServer(ip, onDone) {
    if (!(ip in activeServers)) {
        if (onDone) onDone(false);
        return false;
    }
    const server = activeServers[ip];
    delete activeServers[ip];
    server.close(() => {
        console.log(`Server on ${ip}:${PORT} closed`);
        if (onDone) onDone(true);
    });
    return true;
}

// ── Default startup server: localhost ────────────────────────────
createListeningServer('127.0.0.1');

exports.PORT = PORT;
exports.activeServers = activeServers;
exports.createListeningServer = createListeningServer;
exports.closeListeningServer = closeListeningServer;
