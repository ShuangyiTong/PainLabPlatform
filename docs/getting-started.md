[Documentation](README.md) · [Project](../README.md)

# Getting started

## Prepare the workspace

Install Node.js and npm, obtain a checkout, and open a terminal in its root.
Electron is installed by npm. Device connectors may require additional runtimes;
the Python client requires Python 3.10 or newer.

Create the local directories before the first launch. This command preserves
existing contents and also works when study-specific scripts have been removed:

```sh
node -e "['saved_scripts','action_scripts','libraries','integrated_devices','resources'].forEach(d => require('fs').mkdirSync('instance/' + d, { recursive: true }))"
npm ci
npm start
```

See [instance layout](instance-layout.md) for what belongs in each directory.
Recording sessions are created automatically.

## Connect and operate

The controller initially listens on `127.0.0.1:8124`. For clients on another
computer, use **Options → Create New Listening Port** to listen on the host's
local-network address, then configure clients to use that address.

Connect your devices and add your own task configuration. The
[user guide](user-guide.md) describes the operator workflow.

## If something is missing

Check that you launched from the repository root and created the workspace
directories. For a missing device, check its process, address, port, and network
access. Use the application log and terminal output to investigate errors.
