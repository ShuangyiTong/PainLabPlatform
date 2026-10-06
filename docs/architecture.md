[Documentation](README.md) · [Project](../README.md)

# Architecture

PainLabPlatform connects independent device clients to a central controller. Clients report observations and receive control commands through a shared interface. Task scripts express experimental contingencies, allowing existing device integrations to be reused as a paradigm changes.

The implementation separates these responsibilities:

- **Device clients** handle acquisition, device-specific commands and communication with the controller.
- **Controller backend** accepts connections, registers descriptors, decodes reports and dispatches controls. See [`backend/`](../backend/).
- **Control panel** uses descriptor declarations to display reports and controls. JavaScript task logic receives incoming reports through `actionFunction(device_id, dataframe)`. See [`frontend/js/renderer.js`](../frontend/js/renderer.js).
- **Recording** writes reports, controls, descriptors and logs to session journals, with separate export processing. See [recording and export](recording.md).

The desktop application uses Electron: Node.js handles backend communication, while the renderer hosts the operator interface and task logic. Chart rendering and journal writing use separate workers.

Study-specific scripts, libraries, resources and local programs belong in the [instance workspace](instance-layout.md). [Device integration](device-integration.md) describes how new clients join the framework.
