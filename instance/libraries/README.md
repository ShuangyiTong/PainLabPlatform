# Task libraries

Libraries here provide reusable code for saved scripts. They run in the same
renderer as the script; they do not receive dataframes or start work automatically.
The platform only loads a library when a script requests it.

## Importing

Put imports at the start of the runtime body, after `// EndofInteraction` when the
script has a DSL header:

```js
const inplace_shuffle = library('exp_design', 'inplace_shuffle');

// Or import several exports from the same library:
const { inplace_shuffle } = library('exp_design');
```

These are alternative forms, not two declarations to put in the same script.
`library(name, exportName)` reports a missing export immediately. The namespace
form uses normal JavaScript property access/destructuring.

`inplace_shuffle(array)` mutates and returns the supplied array. Use a
fresh array or `array.slice()` to preserve the original order. It uses
`Math.random()`; it does not provide seeded randomization.

## Linear animation

```js
const createLinearAnimation = library('animation', 'createLinearAnimation');
const ballAnimation = createLinearAnimation(0);

ballAnimation.update(512, 10); // Move from the current value to 10 over 512 ms.
const position = ballAnimation.getValue(); // Uses the current time internally.
ballAnimation.update(300, -5); // Retarget from the current interpolated position.
ballAnimation.reset(0);       // Immediately return to zero.
```

Call `getValue()` for each display frame. It returns the destination once the
animation finishes. `update(0, destinationValue)` moves immediately. Durations
are nonnegative milliseconds; values are numbers. Each animation keeps its own
state, with no timers or dependencies. Updating an animation keeps its position
continuous; its speed can change when it receives a new destination.

## Writing a library

Add `<name>.js` here. Names contain letters, numbers, underscores or hyphens;
imports omit the extension. Use CommonJS exports explicitly:

```js
'use strict';

function helper(value) {
    return value * 2;
}

module.exports = { helper, VERSION: '1.0' };
```

Declarations stay private to the module unless exported. Dependencies can use
normal relative `require('./other_library.js')` or installed npm packages.
The library does not inherit the calling script's local variables. Pass data,
`interactiveScope`, or renderer helpers as arguments when needed; objects are
passed by reference without IPC or copying.

Keep top-level code limited to definitions and imports. A library with buffers,
counters or other experiment state should export a factory that creates a new
instance for each script activation. This also ensures it receives the current
`interactiveScope`, which is replaced on activation. Calls such as
`processor.onData(device_id, dataframe)` should remain explicit in `actionFunction`.
There is no automatic timer/listener cleanup; scripts that create these resources
remain responsible for disposing of them when reactivated or replaced.

## Loading and debugging

The default library directory is `./instance/libraries`, resolved from the app's
working directory, just as `backend/service.js` resolves `./instance/saved_scripts`.
For a packaged app, launch it with the working directory containing your external
`instance` folder; libraries are not resolved relative to the packaged source files.

Loading is synchronous, so import once during script initialization rather than
inside the dataframe handler. Node caches modules and their dependencies for the
renderer lifetime. **Restart the app after editing a library** to load its new
code. Reactivating a saved script alone does not reload library files. This first
version intentionally has no hot reload or plugin lifecycle.

Errors in library code retain their original filenames and line numbers. Missing
libraries and named exports report which name could not be loaded.

## What belongs in exp_design

Start with the shared shuffle. Other candidates are small, explicit order-building
helpers, such as repeating independently shuffled condition sets, when multiple
scripts need the same behavior. Their output should be ordinary arrays that a
researcher can inspect and log.

Keep experiment-specific block metadata, response requirements, calibration
checks, start/end actions and advancement rules in the experiment script.
SomaBall's two shuffled sets and its EC/EO prefix remain visible in `buildBlocks()`.
