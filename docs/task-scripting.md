[Documentation](README.md) · [Project](../README.md)

# Task scripting

PainLabPlatform separates experimental policy from device integration. Task scripts in `instance/saved_scripts/` define `actionFunction(device_id, dataframe)`, called when the controller delivers a decoded report. The script identifies its source, updates task state, and sends feedback through `sendCommand(device_id, field, value)` or `sendMultipleCommands(device_id, object)`. Commands must match the target device's descriptor.

An optional JSON header declares `display_params` and `updatable_params`, followed by `// EndofInteraction` and the JavaScript body. These declarations generate live readouts and operator controls. Store the associated values in `interactiveScope`; the header maps labels to those values and names conversion functions for operator input.

One-off operations belong in `instance/action_scripts/`. Their JSON header declares a name and parameters, ending at `// EndofAction`. On a button press, the body reads converted inputs from `actionScope`, which is cleared after execution. The active task continues to receive reports.

Shared CommonJS helpers belong in `instance/libraries/`. Use `library(name)` for a module's exports or `library(name, exportName)` for one export. Modules remain cached until the app reloads.

These scripts execute in the renderer, so lengthy synchronous work also delays the interface. See [renderer interfaces](../frontend/js/renderer.js) and the [library loader](../frontend/js/library-loader.js) for implementation details.
