[Documentation](README.md) · [Project](../README.md)

# Device integration

A PainLabPlatform device is an independent client that registers with the controller, reports data and, when needed, accepts commands. Hardware acquisition, vendor interfaces and application-specific behavior remain on the client side.

Choose an execution pattern suited to the relationship between reporting and control:

- **Unidirectional:** the client reports observations without accepting task commands.
- **Temporally dependent:** commands and reports are causally coupled and can be handled sequentially.
- **Temporally independent:** reporting continues while commands are handled concurrently.

The device descriptor identifies the client and declares report fields (`data_to_report`), control fields (`data_to_control`) and optional display or payload-layout information. Task scripts use these identifiers and fields to implement experimental logic.

[Python](../clients/python/PainlabProtocol.py) and [C#](../clients/dotnet/PainlabProtocol.cs) client source is provided. Their extension hooks include `RegisterWithDescriptor`, `GetFrameBytes` and `ApplyControlData`. Applications manage the client lifecycle, submit frames and process controls as appropriate. The Python source requires Python 3.10 or later.

Consult the [protocol overview](protocol.md) and client implementations for the current communication behavior.
