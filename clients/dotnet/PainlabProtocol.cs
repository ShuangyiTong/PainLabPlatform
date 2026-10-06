using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Collections;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using System.Text;

public class PainlabProtocolException : Exception
{
    public PainlabProtocolException()
    {
    }

    public PainlabProtocolException(string message)
        : base(message)
    {
    }

    public PainlabProtocolException(string message, Exception inner)
        : base(message, inner)
    {
    }
}

[Serializable]
public class NetworkConfig
{
    public string host;
    public int port;
    public UInt32 maxFrameBuffer;
    public UInt32 bufferQueueSize;
}

public class PainlabProtocol
{
    /* Round-trip ping keyword, sent and echoed as a bare 4-byte frame:
       00 00 00 04 50 49 4E 47. Kept under 5 bytes so it lands in the same
       short-reply branch as OK and FAIL rather than being taken for data. */
    protected const string PingKeyword = "PING";

    /* Both timeouts exist because the control panel may now sit on another
       machine. Without them a connect to a host that is up but not listening
       parks Start() for the OS timeout (~21 s on Windows), and a write into a
       stalled TCP window blocks whichever thread called it with no upper bound
       at all - including the main thread, which reaches SendData through
       HandlingControlData. Bounded failure is what lets the link be declared
       dead instead of silently wedging the game. */
    private const int ConnectTimeoutMs = 5000;
    private const int SendTimeoutMs = 2000;

    /* A frame waiting to go out, payload and length together in one entry.
       They used to be two parallel Queues, which is the only reason the mutex
       around them existed - a lock-free queue cannot keep two containers in
       step, but it has no trouble with one. */
    private struct QueuedFrame
    {
        public byte[] data;
        public UInt32 numBytes;
    }

    /* Was static, so every PainlabProtocol in the process shared one signal and
       a stale count survived editor domain reloads. */
    private Semaphore _sendSync = null;
    private TcpClient _connection = null;
    private Thread _listenerThread = null;
    private Thread _senderThread = null;

    protected UInt32 _bufferSize = 0;

    /* BlockingCollection over a ConcurrentQueue: the queue itself is lock-free,
       and the wrapper adds the two things a bare ConcurrentQueue lacks here - a
       blocking Take so the sender thread can park until a frame arrives, and a
       hard bound so a producer outrunning the link actually drops frames. The
       old code enqueued first and then released a capped semaphore, so once the
       semaphore saturated the "dropped" frame was still in the queue: the queue
       grew without bound and the sender fell permanently behind. */
    private BlockingCollection<QueuedFrame> _frameQueue = null;

    /* Monitor, not a Mutex: SendData used to leave the mutex held if a write
       threw, because ReleaseMutex sat after the write instead of in a finally.
       lock() releases on the way out however the block is left. */
    private readonly object _sendLock = new object();
    private byte[] _sendFrameBuffer = null;

    protected byte[] _listenBuffer = null;
    protected volatile UInt32 _numControlBytes = 0;
    protected byte[] _controlBuffer = null;

    private volatile bool _running = false;
    private volatile bool _closing = false;
    private long _droppedFrames = 0;

    protected bool _waitOnControl = false;
    protected Semaphore _waitOnControlSem = null;

    /* False once the link is gone, so callers can stop feeding a dead protocol
       and show the operator something rather than freezing mid-session. */
    public bool IsRunning
    {
        get { return _running; }
    }

    protected virtual void DebugOutput(string msg)
    {
        Console.WriteLine(msg);
    }

    public void Init(NetworkConfig netConf, bool waitOnControl = false)
    {
        _bufferSize = netConf.maxFrameBuffer;

        _listenBuffer = new byte[_bufferSize];
        _controlBuffer = new byte[_bufferSize];
        _sendFrameBuffer = new byte[_bufferSize + 4];

        _sendSync = new Semaphore(0, 1);
        _frameQueue = new BlockingCollection<QueuedFrame>(new ConcurrentQueue<QueuedFrame>(),
                                                          (int)netConf.bufferQueueSize);

        if (waitOnControl)
        {
            _waitOnControl = true;
            _waitOnControlSem = new Semaphore(0, 1);
        }

        try
        {
            _connection = new TcpClient();

            if (!_connection.ConnectAsync(netConf.host, netConf.port).Wait(ConnectTimeoutMs))
            {
                throw new PainlabProtocolException("timed out after " + ConnectTimeoutMs + " ms");
            }

            /* Every data frame costs a full round trip (see SenderThread), so
               Nagle holding a small write back for an ACK that is itself waiting
               on the write is exactly the wrong trade here. */
            _connection.NoDelay = true;
            _connection.SendTimeout = SendTimeoutMs;
        }
        catch (Exception e)
        {
            Exception cause = e.InnerException != null ? e.InnerException : e;
            DebugOutput("Could not connect to " + netConf.host + ":" + netConf.port
                        + " - " + cause.Message);

            if (_connection != null)
            {
                _connection.Close();
                _connection = null;
            }

            return;
        }

        _running = true;

        /* Background threads: a foreground thread parked in a blocking Read
           keeps the process alive after the player asks to quit. */
        _listenerThread = new Thread(new ThreadStart(ListenThread));
        _listenerThread.IsBackground = true;
        _listenerThread.Start();

        _senderThread = new Thread(new ThreadStart(SenderThread));
        _senderThread.IsBackground = true;
        _senderThread.Start();
    }

    void ListenThread()
    {
        try
        {
            NetworkStream stream = _connection.GetStream();

            /* totalBytes and offset persist across frames on purpose. They used
               to be re-declared inside the read loop, so the sticky-packet path
               below copied the leftover bytes to the front of the buffer and set
               offset - and then the enclosing loop immediately reset offset to 0
               and the next Read overwrote them. Harmless on loopback, where a
               frame per segment is the norm; across a real link, where segments
               coalesce, it silently ate control frames. */
            UInt32 totalBytes = 0;
            int offset = 0;

            while (true)
            {
                if (totalBytes == 0 && offset >= 4)
                {
                    // new transmission
                    Array.Reverse(_listenBuffer, 0, 4);
                    totalBytes = BitConverter.ToUInt32(_listenBuffer, 0);

                    if (totalBytes + 4 > _bufferSize)
                    {
                        throw new PainlabProtocolException(
                            "frame of " + totalBytes + " bytes exceeds maxFrameBuffer");
                    }
                }

                if (totalBytes != 0 && offset >= (int)totalBytes + 4)
                {
                    int extraBytes = offset - (int)totalBytes - 4;
                    bool handled = false;

                    if (totalBytes < 5)
                    {
                        // check if it is a reply
                        string reply = Encoding.UTF8.GetString(_listenBuffer, 4, (int)totalBytes);
                        if (reply == "OK")
                        {
                            // signal sender thread to continue
                            ReleaseSendSync();
                            handled = true;
                        }
                        else if (reply == "FAIL")
                        {
                            DebugOutput("Server side failure");
                            handled = true;
                        }
                        else if (reply == PingKeyword)
                        {
                            /* Round-trip ping. Echoed from this thread on
                               the spot rather than handed to the main
                               thread the way control data is: what the
                               server is timing is the link, so anything
                               we make it wait for is measurement error.
                               SendData takes _sendLock, so racing the
                               sender thread here is already accounted
                               for. Devices that answer this must declare
                               support_rt_ping in their descriptor —
                               the server pings no one who has not. */
                            SendString(PingKeyword);
                            handled = true;
                        }
                        /* No catch-all else here on purpose: a control
                           frame is free to be shorter than five bytes
                           (a "serial" format command can be a single
                           character), and those have to fall through to
                           the control path below. */
                    }

                    if (!handled)
                    {
                        // going into this section must be control data
                        Array.Copy(_listenBuffer, 4, _controlBuffer, 0, (int)totalBytes);
                        _numControlBytes = (UInt32)totalBytes;

                        if (_waitOnControl)
                        {
                            _waitOnControlSem.Release();
                        }
                    }

                    // handle sticky packets
                    if (extraBytes > 0)
                    {
                        // Copy to the beginning of listen buffer
                        Array.Copy(_listenBuffer, (int)totalBytes + 4, _listenBuffer, 0, extraBytes);
                    }

                    offset = extraBytes;
                    // Reset totalBytes so that it knows to decode length first
                    totalBytes = 0;

                    /* What is left over may already hold another whole frame, so
                       go round before reading again rather than blocking on a
                       Read for data that has already arrived. */
                    continue;
                }

                int length = stream.Read(_listenBuffer, offset, _listenBuffer.Length - offset);

                if (length == 0)
                {
                    /* Peer closed cleanly. The old loop condition let this fall
                       out of the inner read loop and straight back into Read,
                       which then returned 0 again immediately - a 100% CPU spin
                       for as long as the player kept running. */
                    DebugOutput("Connection closed by host");
                    return;
                }

                offset += length;
            }
        }
        catch (Exception e)
        {
            /* Close() disposes the stream under this thread's blocking Read, so
               an exception on the way out is expected and says nothing.
               Anything else is reported: NetworkStream raises IOException (with
               a SocketException inside) for a dropped link, not SocketException
               itself, so the old catch never fired and the thread died in
               silence - no further OK, sender parked forever, control frames
               stopped, game still rendering. */
            if (!_closing)
            {
                Exception cause = e.InnerException != null ? e.InnerException : e;
                DebugOutput("Listener stopped: " + cause.Message);
            }
        }
        finally
        {
            /* No listener means no OK will ever arrive, so the link is done
               whatever the reason. Wake the sender so it can see that. */
            MarkDisconnected();
        }
    }

    protected void SendData(byte[] data, UInt32 l = 0)
    {
        TcpClient connection = _connection;

        if (connection == null || _closing)
        {
            return;
        }

        UInt32 dataLength = Convert.ToBoolean(l) ? l : (UInt32)data.Length;

        if (dataLength + 4 > _sendFrameBuffer.Length)
        {
            DebugOutput("Frame of " + dataLength + " bytes exceeds maxFrameBuffer, not sent");
            return;
        }

        try
        {
            NetworkStream stream = connection.GetStream();
            if (!stream.CanWrite)
            {
                return;
            }

            // Use lock because the main thread will invoke send reply data
            lock (_sendLock)
            {
                /* One Write rather than a 4-byte header write followed by the
                   payload: two writes on a stop-and-wait link give Nagle a small
                   segment to sit on, and halving the syscalls is free. This is
                   the TODO that used to live here. */
                byte[] dataLengthBE = BitConverter.GetBytes(dataLength);
                Array.Reverse(dataLengthBE);

                Array.Copy(dataLengthBE, 0, _sendFrameBuffer, 0, 4);
                Array.Copy(data, 0, _sendFrameBuffer, 4, (int)dataLength);

                stream.Write(_sendFrameBuffer, 0, (int)dataLength + 4);
            }
        }
        catch (Exception e)
        {
            if (!_closing)
            {
                Exception cause = e.InnerException != null ? e.InnerException : e;
                DebugOutput("Send failed: " + cause.Message);
            }

            MarkDisconnected();
        }
    }

    protected void SendString(string stringData)
    {
        byte[] stringBytes = Encoding.UTF8.GetBytes(stringData);
        SendData(stringBytes);
    }

    protected byte[] StringToBytes(string stringData)
    {
        return Encoding.UTF8.GetBytes(stringData);
    }

    void SenderThread()
    {
        try
        {
            DebugOutput("sending descriptor");
            RegisterWithDescriptor();

            // need to wait for an OK for any send data to proceed
            if (!WaitForAck())
            {
                return;
            }

            while (true)
            {
                QueuedFrame frame;

                try
                {
                    // Wait data ready
                    frame = _frameQueue.Take();
                }
                catch (InvalidOperationException)
                {
                    // CompleteAdding on an empty queue: shutting down
                    return;
                }

                SendData(frame.data, frame.numBytes);

                // wait for listener OK signal
                if (!WaitForAck())
                {
                    return;
                }
            }
        }
        catch (Exception e)
        {
            if (!_closing)
            {
                DebugOutput("Sender stopped: " + e.Message);
            }
        }
    }

    /* False means the wait was broken by shutdown or by a dead link rather than
       by a real OK, so the caller must stop instead of sending into the void. */
    bool WaitForAck()
    {
        _sendSync.WaitOne();

        return _running && !_closing;
    }

    /* The signal is binary - the sender only ever waits on one outstanding OK -
       so an extra one is nothing to act on. It used to be raised on a capped
       semaphore with no guard, which turned a stray OK into a SemaphoreFullException
       that killed the listener thread. */
    void ReleaseSendSync()
    {
        try
        {
            _sendSync.Release();
        }
        catch (SemaphoreFullException)
        {
        }
    }

    void MarkDisconnected()
    {
        _running = false;

        if (_frameQueue != null && !_frameQueue.IsAddingCompleted)
        {
            try
            {
                _frameQueue.CompleteAdding();
            }
            catch (ObjectDisposedException)
            {
            }
        }

        // unblock a sender parked on an OK that is never coming
        ReleaseSendSync();
    }

    protected virtual void RegisterWithDescriptor()
    {
        return;
    }

    protected virtual byte[] GetFrameBytes()
    {
        return null;
    }

    protected virtual void ApplyControlData()
    {
        return;
    }

    public void UpdateFrameData(byte[] givenBytes = null)
    {
        /* Nothing drains the queue unless the sender thread is alive. This used
           to keep enqueuing regardless, so a player started with no control
           panel reachable grew the queue every frame forever and logged a drop
           every frame with it - in a build that is a synchronous write to
           Player.log per frame, which is enough on its own to wreck the frame
           rate. */
        if (!_running)
        {
            return;
        }

        byte[] frameBytes = null;
        if (givenBytes != null)
        {
            frameBytes = givenBytes;
        }
        else
        {
            frameBytes = GetFrameBytes();
        }

        if (frameBytes == null)
        {
            return;
        }

        QueuedFrame frame;
        frame.data = frameBytes;
        frame.numBytes = (UInt32)frameBytes.Length;

        bool queued = false;
        try
        {
            queued = _frameQueue.TryAdd(frame);
        }
        catch (InvalidOperationException)
        {
            // CompleteAdding raced us; the link is going away
            return;
        }

        if (!queued)
        {
            /* Report the backlog without logging every frame of it - the log
               call is far more expensive than the frame we just dropped. */
            long dropped = Interlocked.Increment(ref _droppedFrames);
            if (dropped == 1 || dropped % 300 == 0)
            {
                DebugOutput("Frame sent to host dropped, link is behind ("
                            + dropped + " total)");
            }
        }
    }

    public void HandlingControlData()
    {
        if (_numControlBytes > 0)
        {
            string result = "";
            try
            {
                ApplyControlData();
                result = "OK";
            }
            catch (Exception e)
            {
                DebugOutput(e.Message);
                result = "FAIL";
            }

            _numControlBytes = 0;
            SendString(result);
        }
    }

    public void Close()
    {
        /* Set before the socket goes so the listener, which is sitting in a
           blocking Read that is about to throw, can tell an orderly shutdown
           from a real failure. */
        _closing = true;

        MarkDisconnected();

        TcpClient connection = _connection;
        _connection = null;

        if (connection != null)
        {
            connection.Close();
        }
    }
}
