[Documentation](README.md) · [Project](../README.md)

# Protocol overview

PainLabPlatform uses an application protocol over TCP. The controller starts with a listener at `127.0.0.1:8124`; the control panel can add listeners on other local addresses.

A client sends a JSON device descriptor first. Subsequent **report data** flows from client to controller, while **control data** flows from controller to client. The two directions can operate concurrently, with acknowledgments coordinating successive transmissions within each direction.

Messages use length-prefixed framing. JSON supports structured reports and commands; descriptor-declared compact payloads and sample batches support selected reporting formats. Report-only clients can use a simplified acknowledgment mode. These choices must match the controller and client implementations.

For implementation details, see the [protocol handler](../backend/protocol.js), [payload decoding and control encoding](../backend/data.js), and [Python](../clients/python/PainlabProtocol.py) or [C#](../clients/dotnet/PainlabProtocol.cs) client source.

See [device integration](device-integration.md) for client design and [recording](recording.md) for stored data.
