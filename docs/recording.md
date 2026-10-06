[Documentation](README.md) · [Project](../README.md)

# Recording and export

PainLabPlatform records descriptors, incoming reports, outgoing controls, and logs through a dedicated writer worker. Each session has a generated directory under `instance/sessions/`; set `PAINLAB_RECORDING_ROOT` to change that location.

The session contains newline-delimited JSON journals: `descriptors.ndjson`, `log.ndjson`, and separate device and control files. Records include a sequence number used to select an export cutoff.

**Save File** captures the current sequence, waits for preceding writes, and exports JSON while acquisition can continue. Exports contain device descriptors, control data and logs, and report data grouped by device. To export a session from the command line:

```sh
npm run session -- "<session-folder>" "<output-prefix>"
```

An optional final sequence number limits the export. Without one, the tool reads complete journal lines present when it opens them; an unfinished trailing line is excluded.

Existing files at the output prefix are overwritten. Each device needs a `device_type` that produces a unique export filename; filename collisions fail export. Recording file errors and the 4,096-record queue limit are not recovered automatically. Malformed journal data or export file errors also fail the operation.

See [development](development.md) for the recording integration test.
