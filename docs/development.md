[Documentation](README.md) · [Project](../README.md)

# Development

PainLabPlatform uses Electron for the desktop application, Node.js for communication and recording, and JavaScript for the interface and task runtime. Follow [Getting started](getting-started.md) to prepare workspace directories, then install dependencies with `npm ci` from the repository root.

| Command | Purpose |
| --- | --- |
| `npm start` | Launch the application. |
| `npm run debug` | Launch Electron with the project's debug flag. |
| `npm test` | Run the recording integration test. |

The test opens the real Electron app and runs three Python clients for five minutes. It checks that all 900,000 frames are acknowledged and that session journals match exported data. Python 3.10 or later must be available as `python`; set `PAINLAB_TEST_PYTHON` to select another executable. The test uses an isolated port and temporary recording/output directories.

Start with [main.js](../main.js) for application setup, [backend/](../backend/) for communication and recording, [frontend/](../frontend/) for the interface, and [clients/](../clients/) for reusable device clients. Keep study-specific scripts, resources, and device programs in the local `instance/` workspace. See [recording](recording.md) for export behavior and current operational limits.
