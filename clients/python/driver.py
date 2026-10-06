#!/usr/bin/env python3
"""Synthetic PainLab device; Python 3.10+, no third-party dependencies.

Start the control panel, then run these in separate terminals:
    python clients/python/driver.py --name "Test device 1" --id test-1
    python clients/python/driver.py --name "Test device 2" --id test-2 --fps 2000

A finite run with larger frames:
    python clients/python/driver.py --name "Save test" --id save-test --fps 1000 --frames 10000 --payload-bytes 4096

Frames are paced throughout each second. Every frame still needs a server ACK,
so the requested rate can exceed link throughput. Sequence numbers count
generation attempts, starting at 1; queue drops appear as gaps in saved data.
Compare the final acknowledged count with the server's received count.
Ctrl+C stops generation and briefly drains accepted frames.

Each device has a 1 Hz sine-wave chart and an amplitude control (0 to 10).
The device_type includes its ID because Save File uses it in output filenames.
Use a different ID for every concurrent process.
"""

import argparse
import json
import math
import re
import sys
import time

from PainlabProtocol import NetworkConfig, PainlabProtocol


def positive_int(text):
    value = int(text)
    if value <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return value


def nonnegative_int(text):
    value = int(text)
    if value < 0:
        raise argparse.ArgumentTypeError("must be zero or a positive integer")
    return value


def nonnegative_seconds(text):
    value = float(text)
    if not math.isfinite(value) or value < 0:
        raise argparse.ArgumentTypeError("must be a finite, nonnegative number")
    return value


def device_id(text):
    # IDs become frontend selectors and filenames, and the current backend
    # stores them in ordinary JavaScript objects.
    reserved = {
        "__proto__", "constructor", "hasOwnProperty", "isPrototypeOf",
        "propertyIsEnumerable", "toLocaleString", "toString", "valueOf",
        "__defineGetter__", "__defineSetter__", "__lookupGetter__",
        "__lookupSetter__", "log",
    }
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", text) or text in reserved:
        raise argparse.ArgumentTypeError(
            "use 1-80 letters, digits, underscores or hyphens, "
            "avoiding reserved IDs such as 'log' or 'constructor'"
        )
    return text


def build_descriptor(name, identifier, fps, payload_bytes):
    report = {"sequence": "int", "value": "float", "amplitude": "float",
              "generated_at_ms": "double"}
    if payload_bytes:
        report["payload"] = "string"
    return {
        "name": name,
        "device_id": identifier,
        "device_type": "PythonStress_" + identifier,
        "data_to_report": report,
        # Select framed OK/FAIL acknowledgements, as used by the .NET client.
        "data_to_control": {"amplitude": "float"},
        "report_pack_order": None,
        "control_pack_order": None,
        "visual_report": {
            "value": "line_chart", "sequence": "static", "amplitude": "static",
            "data_rate": fps, "rolling_time": 5,
        },
        "visual_value_range": {"value": {"min": -10, "max": 10}},
        "visual_control": {"amplitude": ["slider", 0, 10]},
        "support_rt_ping": True,
    }


class TestDevice(PainlabProtocol):
    """Application hooks; transport and queues live in PainlabProtocol.py."""

    def __init__(self, descriptor):
        super().__init__()
        self.descriptor = descriptor
        self.amplitude = 1.0

    def DebugOutput(self, message):
        print(f"[{self.descriptor['device_id']}] {message}", flush=True)

    def RegisterWithDescriptor(self):
        self.SendString(json.dumps(self.descriptor, separators=(",", ":")))

    def ApplyControlData(self):
        raw = self._controlBuffer[:self._numControlBytes]
        command = json.loads(raw.decode("utf-8"))
        if not isinstance(command, dict):
            raise ValueError("control data must be a JSON object")
        if "amplitude" in command:
            value = command["amplitude"]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError("amplitude must be a number")
            if not math.isfinite(value) or not 0 <= value <= 10:
                raise ValueError("amplitude must be between 0 and 10")
            self.amplitude = float(value)
            self.DebugOutput(f"amplitude set to {self.amplitude:g}")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Run a synthetic PainLab device with a bounded send queue.",
        epilog="Launch several processes with distinct --id values to stress the server.",
    )
    parser.add_argument("--name", required=True, help="device display name")
    parser.add_argument("--id", required=True, type=device_id, help="unique device ID")
    parser.add_argument("--host", default="127.0.0.1", help="server host (default: %(default)s)")
    parser.add_argument("--port", type=positive_int, default=8124, help="server port (default: %(default)s)")
    parser.add_argument("--fps", "--frames-per-second", type=positive_int, default=1000,
                        help="target frames per second (default: %(default)s)")
    parser.add_argument("--frames", type=nonnegative_int, default=0,
                        help="stop after N generation attempts; 0 runs indefinitely")
    parser.add_argument("--duration", type=nonnegative_seconds, default=0,
                        help="stop after this many seconds; 0 runs indefinitely")
    parser.add_argument("--payload-bytes", type=nonnegative_int, default=0,
                        help="additional ASCII payload per frame (default: %(default)s)")
    parser.add_argument("--queue-size", type=positive_int, default=256,
                        help="maximum queued data frames (default: %(default)s)")
    parser.add_argument("--drain-timeout", type=nonnegative_seconds, default=5,
                        help="seconds to drain queued frames at exit (default: %(default)s)")
    args = parser.parse_args(argv)
    if not args.name.strip():
        parser.error("--name must not be empty")
    if args.port > 65535:
        parser.error("--port must be between 1 and 65535")
    if args.payload_bytes > 0xFFFFFFFF - 4096:
        parser.error("--payload-bytes exceeds the protocol's frame length limit")
    return args


def run(args):
    descriptor = build_descriptor(args.name, args.id, args.fps, args.payload_bytes)
    device = TestDevice(descriptor)
    descriptor_bytes = len(json.dumps(descriptor).encode("utf-8"))
    config = NetworkConfig(
        host=args.host, port=args.port,
        maxFrameBuffer=max(65536, args.payload_bytes + 4096, descriptor_bytes + 4096),
        bufferQueueSize=args.queue_size,
    )
    generated = accepted = 0
    exit_code = 0
    start = None
    try:
        print(f"Connecting {args.name!r} ({args.id}) to {args.host}:{args.port}...", flush=True)
        device.Init(config)
        if not device.IsRunning or not device.WaitUntilRegistered(timeout=5):
            print(f"Registration failed: {device.LastError or 'no descriptor acknowledgement within 5 seconds'}",
                  file=sys.stderr, flush=True)
            return 1

        print(f"Registered; target={args.fps} frames/s, payload={args.payload_bytes} bytes, "
              f"queue={args.queue_size}. Ctrl+C to stop.", flush=True)
        payload = "x" * args.payload_bytes
        start = time.perf_counter()
        deadline = start + args.duration if args.duration else math.inf
        next_frame = start
        next_status = start + 1
        last_status = start
        last_acknowledged = 0
        interval = 1.0 / args.fps

        try:
            while device.IsRunning:
                device.HandlingControlData()
                now = time.perf_counter()
                if now >= deadline or (args.frames and generated >= args.frames):
                    break
                # Limit each turn so controls and reporting stay responsive
                # even if the requested rate exceeds client/link throughput.
                due = min(128, max(0, int((now - next_frame) * args.fps) + 1)) if now >= next_frame else 0
                if args.frames:
                    due = min(due, args.frames - generated)
                for _ in range(due):
                    if not device.IsRunning or time.perf_counter() >= deadline:
                        break
                    generated += 1
                    frame = {
                        "sequence": generated,
                        "value": round(device.amplitude * math.sin(
                            2 * math.pi * ((generated - 1) % args.fps) / args.fps), 6),
                        "amplitude": device.amplitude,
                        "generated_at_ms": time.time_ns() // 1_000_000,
                    }
                    if payload:
                        frame["payload"] = payload
                    encoded = json.dumps(frame, separators=(",", ":"), allow_nan=False).encode("utf-8")
                    if device.UpdateFrameData(encoded):
                        accepted += 1
                    next_frame += interval

                now = time.perf_counter()
                if now >= next_status:
                    acknowledged = device.FramesAcknowledged
                    actual_rate = (acknowledged - last_acknowledged) / (now - last_status)
                    print(f"[{args.id}] generated={generated} queued_total={accepted} "
                          f"acknowledged={acknowledged} pending={device.PendingFrames} "
                          f"dropped={device.DroppedFrames} actual={actual_rate:.0f} frames/s", flush=True)
                    last_acknowledged, last_status = acknowledged, now
                    next_status = now + 1
                # Poll controls even at low rates; sleep instead of busy-spin.
                pause = min(0.01, next_frame - time.perf_counter())
                if pause > 0:
                    time.sleep(pause)
        except KeyboardInterrupt:
            print("\nStopping generation; draining accepted frames...", flush=True)

        drain_deadline = time.perf_counter() + args.drain_timeout
        while device.IsRunning and device.PendingFrames:
            device.HandlingControlData()
            remaining = drain_deadline - time.perf_counter()
            if remaining <= 0:
                break
            device.Flush(timeout=min(0.05, remaining))
        if not device.IsRunning:
            print(f"Connection stopped: {device.LastError or 'server closed the connection'}",
                  file=sys.stderr, flush=True)
            exit_code = 1
        elif device.FramesAcknowledged < accepted:
            print("Drain timed out: some accepted frames were not acknowledged before exit.",
                  file=sys.stderr, flush=True)
            exit_code = 1
    except KeyboardInterrupt:
        print("\nClosing immediately.", flush=True)
        exit_code = 130
    except (OSError, ValueError, MemoryError) as error:
        print(f"Device failed: {error}", file=sys.stderr, flush=True)
        exit_code = 1
    finally:
        device.Close()
        elapsed = time.perf_counter() - start if start is not None else 0
        print(f"[{args.id}] finished: generated={generated} queued_total={accepted} "
              f"sent={device.FramesSent} acknowledged={device.FramesAcknowledged} "
              f"dropped={device.DroppedFrames} unacknowledged={accepted - device.FramesAcknowledged} "
              f"elapsed={elapsed:.2f}s", flush=True)
    return exit_code


if __name__ == "__main__":
    sys.exit(run(parse_args()))
