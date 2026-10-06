'use strict';

const path = require('node:path');

// Load task libraries in the renderer, where their exports remain ordinary
// functions and objects. Each file has Node's own private CommonJS scope.
function createLibrary(directory = './instance/libraries') {
    // Match backend/service.js: instance belongs to the working directory,
    // which can be outside the packaged application code.
    const root = path.resolve(directory);

    return function library(name, exportName) {
        if (typeof name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(name)) {
            throw new Error('Library names may contain only letters, numbers, underscores and hyphens.');
        }

        const filename = path.join(root, name + '.js');
        let resolved;
        try {
            resolved = require.resolve(filename);
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
            throw new Error(`Library "${name}" was not found at ${filename}`, { cause: error });
        }

        // Keep module errors intact so their original filename/line is visible.
        // Node caches this module and its dependencies until the app is reloaded.
        const exports = require(resolved);
        if (exportName === undefined) return exports;
        if (typeof exportName !== 'string' || exports == null
            || !Object.prototype.hasOwnProperty.call(exports, exportName)) {
            throw new Error(`Library "${name}" does not export "${String(exportName)}".`);
        }
        return exports[exportName];
    };
}

module.exports = { createLibrary };
