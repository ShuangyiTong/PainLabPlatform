[Documentation](README.md) · [Project](../README.md)

# Instance workspace

`instance/` holds local material for an assembled PainLabPlatform setup. Its contents depend on the devices and paradigm; the framework does not require a particular study's scripts or recordings.

| Folder | Contents and interface |
| --- | --- |
| `saved_scripts/` | Task scripts selected in the editor. An optional JSON interaction header ends at `// EndofInteraction`; the JavaScript body defines task behavior, commonly through `actionFunction(device_id, dataframe)`. |
| `action_scripts/` | Parameterized operations invoked from the Actions panel. A JSON header declares the action name and parameters, followed by `// EndofAction` and a JavaScript body using `actionScope`. |
| `libraries/` | Reusable CommonJS modules accessed with `library(name[, exportName])`. Modules remain cached until application reload. |
| `integrated_devices/` | Locally launchable programs. Each program folder contains a matching executable: `<name>/<name>.exe` on Windows or `<name>/<name>` elsewhere. |
| `resources/` | Optional local files used by a setup. The setup guide creates this directory even when it is empty. |
| `sessions/` | Generated recording journals, created automatically when recording begins. `PAINLAB_RECORDING_ROOT` can select another parent directory. |

Follow [Getting started](getting-started.md) to create the workspace directories. Exact loading behavior is in the [script service](../backend/service.js), [library loader](../frontend/js/library-loader.js) and [program controller](../backend/local-device.js). See [recording](recording.md) for session export.
