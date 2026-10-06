#!/usr/bin/env node
'use strict';

const { aggregate } = require('../backend/recording/aggregate');

async function main() {
    const [sessionDir, outputPrefix, cutoff] = process.argv.slice(2);
    if (!sessionDir || !outputPrefix || process.argv.length > 5) {
        throw new Error('Usage: node tools/session.js <session-folder> <output-prefix> [sequence-cutoff]');
    }
    const files = await aggregate(sessionDir, outputPrefix, cutoff === undefined ? Infinity : Number(cutoff));
    for (const file of files) console.log(file);
}

if (require.main === module) main();
