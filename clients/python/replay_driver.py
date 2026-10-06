#!/usr/bin/env python3
"""Replay a Save File export as a PainLab device (Python 3.10+, standard library).

Start the control panel, then run from the repository root:
    python clients/python/replay/_driver.py Tank-Test-9-01
    python clients/python/replay/_driver.py Tank-Test-9-01 --device unity
    python clients/python/replay/_driver.py "C:/recordings/my-run" --device 1 --speed 2

With no folder argument, prompt for one. Folder names are also searched under
instance/resources, relative to this script. Choose one recorded device per
process; run another process to replay another device. A descriptor file path
can be supplied instead of a folder containing multiple exports.

Playback starts at the selected device's first frame, using the saved server
timestamp (milliseconds) for relative timing. Sample batches and device-local
timestamps are preserved; the panel supplies new arrival timestamps. Equal or
backwards timestamps have zero delay. --speed 2 halves recorded delays.

The device name gains "(replay)", and its ID/type gain a replay prefix/suffix.
Use --id ORIGINAL_ID for scripts that refer to the recorded ID, after disconnecting
the original device. Controls cannot change recorded data and are rejected.
Frames are streamed from disk and queued without dropping them; a slow server
can make playback lag. Ctrl+C stops playback and briefly drains accepted frames.
Input is the exported JSON format, not the raw instance/sessions NDJSON journals.
"""

import argparse
from contextlib import closing
from copy import deepcopy
from itertools import chain, islice
import json
import math
from pathlib import Path
import re
import struct
import sys
import time

# Allow direct invocation from any working directory without installing a package.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PainlabProtocol import NetworkConfig, PainlabProtocol


RESOURCES = Path(__file__).resolve().parents[2] / "instance" / "resources"
DESCRIPTOR_SUFFIX = "__Device_Descriptors__.json"


def positive_int(text):
    value = int(text)
    if value <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return value


def positive_number(text):
    value = float(text)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a finite, positive number")
    return value


def device_id(text):
    reserved = {
        "__proto__", "constructor", "hasOwnProperty", "isPrototypeOf",
        "propertyIsEnumerable", "toLocaleString", "toString", "valueOf",
        "__defineGetter__", "__defineSetter__", "__lookupGetter__",
        "__lookupSetter__", "log",
    }
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", text) or text in reserved:
        raise argparse.ArgumentTypeError(
            "use 1-80 letters, digits, underscores or hyphens, avoiding reserved IDs"
        )
    return text


def load_recording(location):
    """Resolve an export folder/file and read its device descriptor map."""
    path = Path(location).expanduser()
    if not path.exists():
        path = RESOURCES / path
    if path.is_dir():
        matches = sorted(path.glob("*" + DESCRIPTOR_SUFFIX))
        if len(matches) != 1:
            raise ValueError(
                f"Expected one *{DESCRIPTOR_SUFFIX} file in {path}; found {len(matches)}. "
                "If there are several exports, pass the desired descriptor file path."
            )
        path = matches[0]
    if not path.is_file() or not path.name.endswith(DESCRIPTOR_SUFFIX):
        raise ValueError(f"Recording folder or exported descriptor file not found: {location}")
    with path.open(encoding="utf-8-sig") as source:
        descriptors = json.load(source)
    if not isinstance(descriptors, dict) or not descriptors:
        raise ValueError(f"{path}: expected a nonempty map of device descriptors")
    for identifier, descriptor in descriptors.items():
        if (not isinstance(descriptor, dict)
                or descriptor.get("device_id") != identifier
                or not isinstance(descriptor.get("device_type"), str)
                or not descriptor["device_type"]):
            raise ValueError(f"{path}: invalid descriptor for device {identifier!r}")
    return path.resolve(), list(descriptors.values())


def select_device(devices, choice=None):
    """Choose by menu number, ID, name or an unambiguous substring."""
    print("Recorded devices:", flush=True)
    for number, descriptor in enumerate(devices, 1):
        print(f"  {number}. {descriptor.get('name', descriptor['device_type'])} "
              f"[type={descriptor['device_type']}, id={descriptor['device_id']}]", flush=True)
    interactive = choice is None
    while True:
        selection = input("Device to replay (number, name or ID): ") if interactive else choice
        selection = selection.strip().casefold()
        matches = []
        if selection.isdecimal() and 1 <= int(selection) <= len(devices):
            matches = [devices[int(selection) - 1]]
        elif selection:
            def labels(descriptor):
                return [str(descriptor.get(key, "")).casefold()
                        for key in ("device_id", "device_type", "name")]
            matches = [descriptor for descriptor in devices if selection in labels(descriptor)]
            if not matches:
                matches = [descriptor for descriptor in devices
                           if any(selection in label for label in labels(descriptor))]
        if len(matches) == 1:
            return matches[0]
        message = f"Device selection {selection!r} matched {len(matches)} devices; choose one menu number or ID."
        if not interactive:
            raise ValueError(message)
        print(message, flush=True)


def data_file(descriptor_path, descriptor):
    # Same filename sanitization as backend/recording/aggregate.js.
    device_type = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", descriptor["device_type"])
    prefix = descriptor_path.name[:-len(DESCRIPTOR_SUFFIX)]
    path = descriptor_path.with_name(f"{prefix}__Device_Data_{device_type}__.json")
    if not path.is_file():
        raise ValueError(f"No saved data file for this device: {path}")
    return path


def iter_frames(path, chunk_size=65536):
    """Stream a JSON array, including compact and pretty-printed older exports."""
    decoder = json.JSONDecoder()
    with path.open(encoding="utf-8-sig") as source:
        buffer, position, eof = "", 0, False

        def read_more():
            nonlocal buffer, position, eof
            chunk = source.read(chunk_size)
            buffer = buffer[position:] + chunk
            position = 0
            eof = not chunk

        def peek():
            nonlocal position
            while True:
                while position < len(buffer) and buffer[position] in " \t\r\n":
                    position += 1
                if position < len(buffer):
                    return buffer[position]
                if eof:
                    return ""
                read_more()

        def invalid(message):
            return ValueError(f"{path}: {message}")

        if peek() != "[":
            raise invalid("expected a JSON array of recorded frames")
        position += 1
        number = 0
        if peek() != "]":
            while True:
                if peek() != "{":
                    raise invalid(f"expected a frame object at frame {number + 1}")
                while True:
                    try:
                        frame, end = decoder.raw_decode(buffer, position)
                        position = end
                        break
                    except json.JSONDecodeError as error:
                        if eof:
                            raise invalid(f"invalid JSON at frame {number + 1}: {error.msg}") from error
                        read_more()
                number += 1
                timestamp = frame.get("timestamp")
                if (isinstance(timestamp, bool) or not isinstance(timestamp, (int, float))
                        or not math.isfinite(timestamp)):
                    raise invalid(f"frame {number} needs a finite numeric timestamp in milliseconds")
                yield frame
                separator = peek()
                if separator == "]":
                    break
                if separator != ",":
                    raise invalid(f"expected ',' or ']' after frame {number}")
                position += 1
        position += 1
        if peek():
            raise invalid("unexpected data after the JSON array")


def make_descriptor(original, identifier=None):
    descriptor = deepcopy(original)
    safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", original["device_id"])
    descriptor["device_id"] = identifier or safe_id
    descriptor["device_type"] = original["device_type"] + "_Replay"
    descriptor["name"] = original.get("name", original["device_type"]) + " (replay)"
    # An empty object selects the framed OK/FAIL protocol, even for data-only sources.
    descriptor["data_to_control"] = {}
    descriptor["control_pack_order"] = None
    descriptor["visual_control"] = {}
    descriptor["support_rt_ping"] = True
    return descriptor


def encode_frame(frame, descriptor):
    """Restore the wire payload from a saved JSON frame or decoded binary batch."""
    packing = descriptor.get("report_pack_order") or {}
    if packing.get("order"):
        # These are the binary types currently decoded by backend/data.js.
        if not packing.get("packed"):
            raise ValueError("Unbatched binary reports are not supported by the server")
        formats = {"uint16_t_le": "H", "uint32_t_le": "I"}
        try:
            order = packing["order"]
            sample_format = struct.Struct("<" + "".join(
                formats[descriptor["data_to_report"][key]] for key in order
            ))
            samples = frame["frames"]
            if not isinstance(samples, list) or not samples:
                raise ValueError("expected a nonempty 'frames' array")
            return b"".join(sample_format.pack(*(sample[key] for key in order)) for sample in samples)
        except (KeyError, TypeError, struct.error) as error:
            raise ValueError(f"Cannot repack recorded binary frame: {error}") from error
    payload = {key: value for key, value in frame.items() if key != "timestamp"}
    return json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")


class ReplayDevice(PainlabProtocol):
    def __init__(self, descriptor):
        super().__init__()
        self.descriptor = descriptor

    def DebugOutput(self, message):
        print(f"[{self.descriptor['device_id']}] {message}", flush=True)

    def RegisterWithDescriptor(self):
        self.SendString(json.dumps(self.descriptor, separators=(",", ":"), allow_nan=False))

    def ApplyControlData(self):
        raise ValueError("Replay data is read-only; device controls cannot change this recording")


def replay_frames(device, frames, *, speed=1.0, queue_size=256, limit=0):
    """Pace against a monotonic schedule to avoid accumulating sleep/ACK overhead."""
    start = time.perf_counter()
    due = start
    previous_timestamp = None
    next_status = start + 5
    accepted = 0
    for frame in islice(frames, limit) if limit else frames:
        timestamp = frame["timestamp"]
        if previous_timestamp is not None:
            due += max(0, timestamp - previous_timestamp) / 1000.0 / speed
        previous_timestamp = timestamp
        payload = encode_frame(frame, device.descriptor)
        while device.IsRunning:
            device.HandlingControlData()
            remaining = due - time.perf_counter()
            if remaining > 0:
                time.sleep(min(0.01, remaining))
            elif device.PendingFrames >= queue_size:
                # One producer: reserving room before submitting prevents queue drops.
                device.Flush(timeout=0.01)
            else:
                break
        if not device.IsRunning or not device.UpdateFrameData(payload):
            raise ConnectionError(device.LastError or "Connection stopped while replaying")
        accepted += 1
        now = time.perf_counter()
        if now >= next_status:
            print(f"Replayed={accepted} acknowledged={device.FramesAcknowledged} "
                  f"pending={device.PendingFrames} lag={max(0, now - due):.2f}s", flush=True)
            next_status = now + 5
    return accepted


def drain(device, timeout):
    deadline = time.perf_counter() + timeout
    while device.IsRunning and device.PendingFrames:
        device.HandlingControlData()
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            raise TimeoutError("Drain timed out; some accepted frames were not acknowledged")
        device.Flush(timeout=min(0.05, remaining))
    if not device.IsRunning:
        raise ConnectionError(device.LastError or "Server closed the connection")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("recording", nargs="?", help="export folder name/path, or descriptor file path")
    parser.add_argument("--device", help="menu number, device ID, name or unique substring; otherwise prompt")
    parser.add_argument("--id", type=device_id, help="override the replay device ID (default: RECORDED_ID)")
    parser.add_argument("--host", default="127.0.0.1", help="server host (default: %(default)s)")
    parser.add_argument("--port", type=positive_int, default=8124, help="server port (default: %(default)s)")
    parser.add_argument("--speed", type=positive_number, default=1.0, help="playback multiplier (default: %(default)s)")
    parser.add_argument("--frames", type=positive_int, default=0, help="replay only the first N frames (default: all)")
    parser.add_argument("--queue-size", type=positive_int, default=256, help="maximum pending frames (default: %(default)s)")
    parser.add_argument("--drain-timeout", type=positive_number, default=5.0, help="seconds to drain before exit (default: %(default)s)")
    args = parser.parse_args(argv)
    if args.port > 65535:
        parser.error("--port must be between 1 and 65535")
    return args


def run(args):
    device = None
    try:
        location = args.recording or input("Recording folder name or path: ").strip().strip('"')
        if not location:
            raise ValueError("A recording folder name or path is required")
        descriptor_path, descriptors = load_recording(location)
        original = select_device(descriptors, args.device)
        path = data_file(descriptor_path, original)
        descriptor = make_descriptor(original, args.id)
        with closing(iter_frames(path)) as frames:
            # Validate a first frame before opening a device connection.
            first = next(frames, None)
            if first is None:
                raise ValueError(f"No frames to replay in {path}")
            encode_frame(first, descriptor)
            device = ReplayDevice(descriptor)
            config = NetworkConfig(
                host=args.host, port=args.port, bufferQueueSize=args.queue_size,
                # This is a length limit, not an allocation. Later records may
                # be larger than the first, so allow the protocol's full range.
                maxFrameBuffer=0xFFFFFFFF,
            )
            print(f"Replaying {path}\nConnecting {descriptor['name']!r} "
                  f"({descriptor['device_id']}) to {args.host}:{args.port}...", flush=True)
            device.Init(config)
            if not device.WaitUntilRegistered(timeout=5):
                raise ConnectionError(device.LastError or "No descriptor acknowledgement within 5 seconds")
            print(f"Registered; speed={args.speed:g}x. Ctrl+C to stop.", flush=True)
            try:
                replay_frames(device, chain((first,), frames), speed=args.speed,
                              queue_size=args.queue_size, limit=args.frames)
            except KeyboardInterrupt:
                print("\nStopping playback; draining accepted frames...", flush=True)
            drain(device, args.drain_timeout)
        return 0
    except KeyboardInterrupt:
        print("\nReplay cancelled.", file=sys.stderr, flush=True)
        return 130
    except (OSError, ValueError, EOFError) as error:
        print(f"Replay failed: {error}", file=sys.stderr, flush=True)
        return 1
    finally:
        if device is not None:
            device.Close()
            print(f"Finished: sent={device.FramesSent} acknowledged={device.FramesAcknowledged} "
                  f"pending={device.PendingFrames} dropped={device.DroppedFrames}", flush=True)


if __name__ == "__main__":
    sys.exit(run(parse_args()))
