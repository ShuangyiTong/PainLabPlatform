"""Standard-library client for the PainLab control panel TCP protocol.

Subclass ``PainlabProtocol`` like the .NET client: send a UTF-8 JSON descriptor
from ``RegisterWithDescriptor``, return a serialized frame from ``GetFrameBytes``,
and read ``_controlBuffer[:_numControlBytes]`` inside ``ApplyControlData``. Call
``Init``, then ``UpdateFrameData`` and ``HandlingControlData`` from your device
loop, and always call ``Close``.

Messages have a four-byte, unsigned, big-endian payload length. The sender waits
for ``OK`` after registration and each data frame. The listener echoes ``PING``
immediately; other inbound messages are controls. Control hooks run only on the
caller of ``HandlingControlData``, followed by an ``OK`` or ``FAIL`` response.
Descriptor and frame hooks run on the sender and producer threads respectively.
Include ``data_to_control`` in the descriptor (an empty object is sufficient)
to select the server's framed replies. Its data-only, one-byte reply mode is
not the .NET protocol implemented here.

Unlike the .NET implementation's single control slot, controls are queued so
coalesced messages cannot overwrite each other. Both queues are bounded by
``bufferQueueSize``. A full outgoing queue rejects the newest frame and counts
it in ``DroppedFrames``; incoming queue overflow ends the connection explicitly.
Mutable outgoing buffers are copied at submission. A server ``FAIL`` also ends
the connection rather than leaving the sender waiting forever.

``maxFrameBuffer`` follows the .NET limits: maximum outgoing payload size, and
maximum incoming frame size including its four-byte prefix. Only data submitted
through ``UpdateFrameData`` participates in frame statistics. Python 3.10+.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import select
import socket
import struct
import threading
import time


class PainlabProtocolException(Exception):
    """A connection, framing, or server acknowledgement failure."""


@dataclass
class NetworkConfig:
    host: str = "127.0.0.1"
    port: int = 8124
    maxFrameBuffer: int = 1_048_576
    bufferQueueSize: int = 1024


class PainlabProtocol:
    """Bounded, stop-and-wait client with .NET-compatible hook names.

    ``UpdateFrameData`` returns whether a frame was queued. ``SendData`` and
    ``SendString`` write immediately and return success; use those only for
    registration and protocol responses, not queued device data.
    ``HandlingControlData`` handles one control. It blocks until a control or
    disconnection when ``waitOnControl=True``, otherwise it returns immediately.

    Timeouts are seconds. ``AckTimeout=None`` preserves the .NET client's
    indefinite ACK wait, including when the panel is busy saving. A subclass
    may set a positive timeout. ``Close`` wakes protocol waits and discards
    queued frames; call ``Flush`` first to wait for all accepted frames.
    Instances may be reinitialized after previous protocol threads exit.
    """

    PingKeyword = "PING"
    ConnectTimeout = 5.0
    SendTimeout = 2.0
    AckTimeout: float | None = None

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._sendLock = threading.Lock()
        self._controlLock = threading.Lock()
        self._connection: socket.socket | None = None
        self._listenerThread: threading.Thread | None = None
        self._senderThread: threading.Thread | None = None
        self._frameQueue: deque[bytes] = deque()
        self._controlQueue: deque[bytes] = deque()
        self._queueSize = 0
        self._bufferSize = 0
        self._controlBuffer = b""
        self._numControlBytes = 0
        self._waitOnControl = False
        self._running = False
        self._closing = False
        self._registered = False
        self._lastError: str | None = None
        self._ackPending = False
        self._ackReceived = False
        self._framesSubmitted = 0
        self._framesSent = 0
        self._framesAcknowledged = 0
        self._droppedFrames = 0

    @property
    def IsRunning(self) -> bool:
        with self._condition:
            return self._running

    @property
    def Registered(self) -> bool:
        with self._condition:
            return self._registered

    @property
    def LastError(self) -> str | None:
        """First connection failure, or ``None`` for an orderly local close."""
        with self._condition:
            return self._lastError

    @property
    def FramesSent(self) -> int:
        with self._condition:
            return self._framesSent

    @property
    def FramesAcknowledged(self) -> int:
        with self._condition:
            return self._framesAcknowledged

    @property
    def DroppedFrames(self) -> int:
        """Frames rejected because the outgoing queue was full."""
        with self._condition:
            return self._droppedFrames

    @property
    def PendingFrames(self) -> int:
        """Accepted frames not acknowledged, including any lost at disconnect."""
        with self._condition:
            return self._framesSubmitted - self._framesAcknowledged

    def Init(self, netConf: NetworkConfig, waitOnControl: bool = False) -> None:
        """Connect and register in the background; inspect ``IsRunning``.

        Invalid configuration raises ``ValueError``. Network failures appear in
        ``LastError`` and ``DebugOutput`` instead of raising. Optionally call
        ``WaitUntilRegistered`` before beginning your recording.
        """
        if not isinstance(netConf.host, str) or not netConf.host:
            raise ValueError("host must be a nonempty string")
        if not isinstance(netConf.port, int) or not 1 <= netConf.port <= 65535:
            raise ValueError("port must be an integer from 1 to 65535")
        if (not isinstance(netConf.maxFrameBuffer, int)
                or not 8 <= netConf.maxFrameBuffer <= 0xFFFFFFFF):
            raise ValueError("maxFrameBuffer must be an integer from 8 to 4294967295")
        if not isinstance(netConf.bufferQueueSize, int) or netConf.bufferQueueSize < 1:
            raise ValueError("bufferQueueSize must be a positive integer")
        if self.ConnectTimeout <= 0 or self.SendTimeout <= 0:
            raise ValueError("connect and send timeouts must be positive")
        if self.AckTimeout is not None and self.AckTimeout <= 0:
            raise ValueError("AckTimeout must be positive or None")

        self.Close()
        if any(thread is not None and thread.is_alive()
               for thread in (self._listenerThread, self._senderThread)):
            raise RuntimeError("previous protocol threads have not stopped")
        with self._condition:
            self._bufferSize = netConf.maxFrameBuffer
            self._queueSize = netConf.bufferQueueSize
            self._waitOnControl = waitOnControl
            self._controlBuffer = b""
            self._numControlBytes = 0
            self._frameQueue.clear()
            self._controlQueue.clear()
            self._closing = False
            self._lastError = None
            self._ackPending = False
            self._ackReceived = False
            self._framesSubmitted = 0
            self._framesSent = 0
            self._framesAcknowledged = 0
            self._droppedFrames = 0

        connection = None
        try:
            connection = socket.create_connection(
                (netConf.host, netConf.port), timeout=self.ConnectTimeout
            )
            connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            # Nonblocking I/O gives writes deadlines without imposing a
            # receive timeout on an otherwise healthy idle connection.
            connection.setblocking(False)
        except OSError as error:
            if connection is not None:
                connection.close()
            self._fail(f"Could not connect to {netConf.host}:{netConf.port}: {error}")
            return

        with self._condition:
            self._connection = connection
            self._running = True
        self._listenerThread = threading.Thread(
            target=self._listen, name="PainlabListener", daemon=True
        )
        self._senderThread = threading.Thread(
            target=self._send_frames, name="PainlabSender", daemon=True
        )
        self._listenerThread.start()
        self._senderThread.start()

    def WaitUntilRegistered(self, timeout: float | None = 5.0) -> bool:
        with self._condition:
            self._condition.wait_for(
                lambda: self._registered or not self._running, timeout
            )
            return self._registered and self._running

    def Flush(self, timeout: float | None = 5.0) -> bool:
        """Wait for server ACKs of frames accepted before this call.

        This does not execute control hooks or mean data was saved to disk by
        the server. A timeout returns ``False`` without closing the connection.
        """
        with self._condition:
            target = self._framesSubmitted
            self._condition.wait_for(
                lambda: not self._running or (
                    self._registered and self._framesAcknowledged >= target
                ), timeout
            )
            return (self._running and self._registered
                    and self._framesAcknowledged >= target)

    def UpdateFrameData(self, givenBytes: bytes | bytearray | memoryview | None = None) -> bool:
        if not self.IsRunning:
            return False
        frame = self.GetFrameBytes() if givenBytes is None else givenBytes
        if frame is None:
            return False
        payload = self._payload_bytes(frame)
        with self._condition:
            if not self._running:
                return False
            if len(self._frameQueue) >= self._queueSize:
                self._droppedFrames += 1
                return False
            self._frameQueue.append(payload)
            self._framesSubmitted += 1
            self._condition.notify_all()
            return True

    def HandlingControlData(self) -> None:
        # Serialize callers, not the listener: PING and frame ACKs must keep
        # flowing while an application control hook runs.
        with self._controlLock:
            with self._condition:
                if self._waitOnControl:
                    self._condition.wait_for(
                        lambda: bool(self._controlQueue) or not self._running
                    )
                if not self._running or not self._controlQueue:
                    return
                self._controlBuffer = self._controlQueue.popleft()
                self._numControlBytes = len(self._controlBuffer)
            result = "OK"
            try:
                self.ApplyControlData()
            except Exception as error:
                self._report(f"Control failed: {error}")
                result = "FAIL"
            finally:
                self._controlBuffer = b""
                self._numControlBytes = 0
            self.SendString(result)

    def SendData(self, data: bytes | bytearray | memoryview, l: int = 0) -> bool:
        """Write a framed payload immediately, with serialization of writers."""
        if not self.IsRunning:
            return False
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError("payload must be bytes, bytearray, or memoryview")
        raw = bytes(data)
        if not isinstance(l, int) or l < 0 or l > len(raw):
            raise ValueError("payload length must be from zero to len(data)")
        payload = self._payload_bytes(raw[:l] if l else raw)
        packet = struct.pack("!I", len(payload)) + payload
        deadline = time.monotonic() + self.SendTimeout
        if not self._sendLock.acquire(timeout=self.SendTimeout):
            self._fail("Send timed out waiting for another writer")
            return False
        try:
            connection = self._connection
            if connection is None or not self.IsRunning:
                return False
            view = memoryview(packet)
            while view:
                if not self.IsRunning:
                    return False
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("socket write timed out")
                _, writable, _ = select.select([], [connection], [], min(remaining, 0.2))
                if not writable:
                    continue
                try:
                    count = connection.send(view)
                except BlockingIOError:
                    continue
                if count == 0:
                    raise ConnectionError("socket closed during write")
                view = view[count:]
            return True
        except (OSError, ValueError) as error:
            self._fail(f"Send failed: {error}")
            return False
        finally:
            self._sendLock.release()

    def SendString(self, stringData: str) -> bool:
        return self.SendData(self.StringToBytes(stringData))

    @staticmethod
    def StringToBytes(stringData: str) -> bytes:
        return stringData.encode("utf-8")

    def RegisterWithDescriptor(self) -> None:
        raise NotImplementedError("override RegisterWithDescriptor to send a device descriptor")

    def GetFrameBytes(self) -> bytes | None:
        return None

    def ApplyControlData(self) -> None:
        pass

    def DebugOutput(self, msg: str) -> None:
        print(msg, flush=True)

    def Close(self) -> None:
        """Disconnect and wake waiting threads; this does not flush frames."""
        with self._condition:
            self._closing = True
        self._disconnect()
        current = threading.current_thread()
        for thread in (self._listenerThread, self._senderThread):
            if thread is not None and thread is not current and thread.is_alive():
                thread.join(timeout=self.SendTimeout + 0.5)

    def _payload_bytes(self, data: bytes | bytearray | memoryview) -> bytes:
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError("payload must be bytes, bytearray, or memoryview")
        payload = bytes(data)
        if not payload or len(payload) > self._bufferSize:
            raise ValueError(f"payload length must be from 1 to {self._bufferSize} bytes")
        return payload

    def _send_frames(self) -> None:
        try:
            self._begin_ack()
            self.RegisterWithDescriptor()
            if not self._wait_for_ack():
                return
            with self._condition:
                if not self._running:
                    return
                self._registered = True
                self._condition.notify_all()
            while True:
                with self._condition:
                    self._condition.wait_for(
                        lambda: bool(self._frameQueue) or not self._running
                    )
                    if not self._running:
                        return
                    frame = self._frameQueue.popleft()
                self._begin_ack()
                if not self.SendData(frame):
                    return
                with self._condition:
                    self._framesSent += 1
                if not self._wait_for_ack():
                    return
                with self._condition:
                    self._framesAcknowledged += 1
                    self._condition.notify_all()
        except Exception as error:
            self._fail(f"Sender stopped: {error}")

    def _begin_ack(self) -> None:
        with self._condition:
            self._ackPending = True
            self._ackReceived = False

    def _wait_for_ack(self) -> bool:
        with self._condition:
            ready = self._condition.wait_for(
                lambda: self._ackReceived or not self._running, self.AckTimeout
            )
            acknowledged = self._ackReceived and self._running
            self._ackPending = False
            self._ackReceived = False
        if not ready:
            self._fail("Timed out waiting for server acknowledgement")
        return acknowledged

    def _listen(self) -> None:
        connection = self._connection
        if connection is None:
            return
        try:
            while self.IsRunning:
                header = self._receive_exact(connection, 4)
                length = struct.unpack("!I", header)[0]
                if length == 0 or length + 4 > self._bufferSize:
                    raise PainlabProtocolException(
                        f"Incoming payload of {length} bytes exceeds framing limits"
                    )
                payload = self._receive_exact(connection, length)
                if payload == b"OK":
                    with self._condition:
                        if self._ackPending:
                            self._ackReceived = True
                            self._condition.notify_all()
                elif payload == b"FAIL":
                    raise PainlabProtocolException("Server rejected descriptor or data (FAIL)")
                elif payload == b"PING":
                    if not self.SendString(self.PingKeyword):
                        return
                else:
                    with self._condition:
                        if len(self._controlQueue) >= self._queueSize:
                            raise PainlabProtocolException(
                                "Control queue full; call HandlingControlData more frequently"
                            )
                        self._controlQueue.append(payload)
                        self._condition.notify_all()
        except Exception as error:
            self._fail(f"Listener stopped: {error}")

    def _receive_exact(self, connection: socket.socket, length: int) -> bytes:
        result = bytearray()
        while len(result) < length:
            if not self.IsRunning:
                raise ConnectionError("client closed")
            readable, _, _ = select.select([connection], [], [], 0.2)
            if not readable:
                continue
            try:
                chunk = connection.recv(min(length - len(result), 65536))
            except BlockingIOError:
                continue
            if not chunk:
                raise ConnectionError("connection closed by host")
            result.extend(chunk)
        return bytes(result)

    def _disconnect(self, error: str | None = None) -> None:
        with self._condition:
            # A socket exception caused by local Close must not turn a normal
            # shutdown into an error or overwrite the first useful failure.
            report = error is not None and not self._closing and self._lastError is None
            if report:
                self._lastError = error
            self._running = False
            self._registered = False
            connection = self._connection
            self._connection = None
            self._frameQueue.clear()
            self._controlQueue.clear()
            self._condition.notify_all()
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        if report:
            self._report(error)

    def _fail(self, error: str) -> None:
        self._disconnect(error)

    def _report(self, message: str) -> None:
        try:
            self.DebugOutput(message)
        except Exception:
            # A logging callback cannot prevent connection cleanup.
            pass
