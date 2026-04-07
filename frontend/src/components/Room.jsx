import React, { useEffect, useState, useRef } from 'react';
import { socket } from '../socket';

// Best supported MIME type for cross-browser recording + MSE playback
const PREFERRED_MIME = (() => {
  if (typeof MediaRecorder === 'undefined') return 'video/webm';
  const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
})();

const Room = ({ session, onLeave }) => {
  const [roomId, setRoomId] = useState(session.roomId || '');
  const [status, setStatus] = useState('Connecting...');
  const [joinRequests, setJoinRequests] = useState([]);
  const [systemMessages, setSystemMessages] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [hasStream, setHasStream] = useState(false);
  const [playBlocked, setPlayBlocked] = useState(false);

  const videoRef = useRef(null);
  const chatEndRef = useRef(null);

  // Host: screen capture + MediaRecorder
  const localStream = useRef(null);
  const mediaRecorderRef = useRef(null);
  const isSharingRef = useRef(false); // ref for closure access

  // Viewer: MSE playback
  const mediaSourceRef = useRef(null);
  const sourceBufferRef = useRef(null);
  const chunkQueueRef = useRef([]);
  const mimeTypeRef = useRef(PREFERRED_MIME);

  // Keep handler refs updated so stale closures inside useEffect always call latest version
  const onViewerJoinedRef = useRef(null);
  const onScreenChunkRef = useRef(null);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Keep these refs current every render  
  onViewerJoinedRef.current = ({ socketId, nickname }) => {
    console.log('[HOST] Viewer joined:', nickname);
    // If currently sharing, restart recording so new viewer gets fresh init segment
    if (isSharingRef.current) {
      stopRecording();
      setTimeout(() => startRecording(), 150);
    }
  };

  onScreenChunkRef.current = (chunk) => {
    if (!session.isHost) {
      appendChunk(chunk);
    }
  };

  // ====================================================
  // VIEWER: MediaSource API for playback
  // ====================================================
  const initViewerStream = (mimeType) => {
    console.log('[VIEWER] Initializing MediaSource with MIME:', mimeType);
    mimeTypeRef.current = mimeType;
    sourceBufferRef.current = null;
    chunkQueueRef.current = [];

    // Clean up old MediaSource
    if (mediaSourceRef.current?.readyState === 'open') {
      try { mediaSourceRef.current.endOfStream(); } catch (e) {}
    }

    const ms = new MediaSource();
    mediaSourceRef.current = ms;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current.src = URL.createObjectURL(ms);
    }

    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer(mimeType);
        sb.mode = 'sequence'; // required for live streaming
        sourceBufferRef.current = sb;

        sb.addEventListener('updateend', () => drainQueue());

        // Drain any chunks that arrived before sourceopen
        drainQueue();
      } catch (e) {
        console.error('[VIEWER] sourceopen error:', e);
      }
    }, { once: true });

    // Attempt play
    setTimeout(() => {
      const p = videoRef.current?.play();
      p?.catch(e => {
        if (e.name === 'NotAllowedError') setPlayBlocked(true);
      });
    }, 200);

    setHasStream(true);
  };

  const drainQueue = () => {
    const sb = sourceBufferRef.current;
    if (!sb || sb.updating || chunkQueueRef.current.length === 0) return;

    // Trim old data to prevent memory bloat (keep last 15s)
    try {
      if (sb.buffered.length > 0) {
        const start = sb.buffered.start(0);
        const end = sb.buffered.end(sb.buffered.length - 1);
        if (end - start > 20) {
          sb.remove(start, end - 15);
          return; // wait for updateend to drain next
        }
      }
    } catch (e) {}

    const chunk = chunkQueueRef.current.shift();
    try {
      sb.appendBuffer(chunk);
    } catch (e) {
      if (e.name === 'QuotaExceededError') {
        console.warn('[VIEWER] Buffer full, clearing queue');
        chunkQueueRef.current = [];
      }
    }
  };

  const appendChunk = (chunk) => {
    const sb = sourceBufferRef.current;
    if (!sb) {
      chunkQueueRef.current.push(chunk);
      return;
    }
    if (sb.updating) {
      chunkQueueRef.current.push(chunk);
    } else {
      try {
        drainQueue();
        if (!sb.updating) sb.appendBuffer(chunk);
      } catch (e) {}
    }
  };

  // ====================================================
  // HOST: MediaRecorder → Socket.IO chunks
  // ====================================================
  const startRecording = () => {
    if (!localStream.current) return;

    const recorder = new MediaRecorder(localStream.current, {
      mimeType: PREFERRED_MIME,
      videoBitsPerSecond: 1_500_000, // 1.5 Mbps
    });

    recorder.ondataavailable = async (e) => {
      if (e.data && e.data.size > 0) {
        const chunk = await e.data.arrayBuffer();
        socket.emit('screen-chunk', { roomId: roomId, chunk });
      }
    };

    // Notify viewers to (re)initialize their MSE
    socket.emit('screen-share-started', { roomId: roomId, mimeType: PREFERRED_MIME });

    recorder.start(200); // 200ms chunks
    mediaRecorderRef.current = recorder;
    console.log('[HOST] MediaRecorder started');
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      try { mediaRecorderRef.current.stop(); } catch (e) {}
      mediaRecorderRef.current = null;
    }
  };

  const startScreenShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      localStream.current = stream;

      // Host preview (muted)
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.play().catch(() => {});
      }

      isSharingRef.current = true;
      setIsSharing(true);
      startRecording();

      stream.getVideoTracks()[0].onended = () => stopScreenShare();
    } catch (e) {
      if (e.name !== 'NotAllowedError') {
        console.error('[HOST] Error starting screen share:', e);
      }
    }
  };

  const stopScreenShare = () => {
    stopRecording();
    if (localStream.current) {
      localStream.current.getTracks().forEach(t => t.stop());
      localStream.current = null;
    }
    isSharingRef.current = false;
    setIsSharing(false);
    socket.emit('screen-share-stopped', { roomId });
    if (videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current.src = '';
    }
  };

  // ====================================================
  // SOCKET CONNECTION + EVENT LISTENERS
  // ====================================================
  useEffect(() => {
    socket.connect();

    if (session.isHost) {
      socket.emit('create-room', {
        nickname: session.nickname,
        userId: session.userId,
        existingRoomId: session.roomId,
      }, (res) => {
        if (res.success) {
          setRoomId(res.roomId);
          setStatus('In Room');
          const saved = sessionStorage.getItem('nobar_session');
          if (saved) {
            const parsed = JSON.parse(saved);
            parsed.roomId = res.roomId;
            sessionStorage.setItem('nobar_session', JSON.stringify(parsed));
          }
        }
      });
    } else {
      socket.emit('request-join', {
        roomId: session.roomId,
        nickname: session.nickname,
        userId: session.userId,
      }, (res) => {
        if (res.error) {
          setStatus('Error: ' + res.error);
        } else if (res.status === 'approved') {
          setStatus('In Room');
        } else {
          setStatus('Waiting Approval...');
        }
      });
    }

    const onParticipantRequest = (data) =>
      setJoinRequests(prev => prev.some(r => r.userId === data.userId) ? prev : [...prev, data]);

    const onJoinApproved = (data) => {
      setRoomId(data.roomId);
      setStatus('In Room');
    };

    const onJoinRejected = (data) => {
      setStatus('Rejected: ' + data.message);
      socket.disconnect();
    };

    const onSystemMessage = (msg) => setSystemMessages(prev => [...prev, msg]);

    const onRoomClosed = (data) => {
      setStatus('Room Closed: ' + data.message);
      stopScreenShare();
      socket.disconnect();
    };

    const onViewerJoined = (...args) => onViewerJoinedRef.current?.(...args);

    const onScreenShareStarted = ({ mimeType }) => {
      if (!session.isHost) {
        console.log('[VIEWER] Screen share started, MIME:', mimeType);
        initViewerStream(mimeType);
      }
    };

    const onScreenChunk = (chunk) => onScreenChunkRef.current?.(chunk);

    const onScreenShareStopped = () => {
      if (!session.isHost) {
        console.log('[VIEWER] Screen share stopped');
        setHasStream(false);
        if (videoRef.current) {
          videoRef.current.src = '';
          videoRef.current.srcObject = null;
        }
      }
    };

    const onChatMessage = (data) => setChatMessages(prev => [...prev, data]);

    socket.on('participant-request', onParticipantRequest);
    socket.on('join-approved', onJoinApproved);
    socket.on('join-rejected', onJoinRejected);
    socket.on('system-message', onSystemMessage);
    socket.on('room-closed', onRoomClosed);
    socket.on('viewer-joined', onViewerJoined);
    socket.on('screen-share-started', onScreenShareStarted);
    socket.on('screen-chunk', onScreenChunk);
    socket.on('screen-share-stopped', onScreenShareStopped);
    socket.on('chat-message', onChatMessage);

    return () => {
      socket.off('participant-request', onParticipantRequest);
      socket.off('join-approved', onJoinApproved);
      socket.off('join-rejected', onJoinRejected);
      socket.off('system-message', onSystemMessage);
      socket.off('room-closed', onRoomClosed);
      socket.off('viewer-joined', onViewerJoined);
      socket.off('screen-share-started', onScreenShareStarted);
      socket.off('screen-chunk', onScreenChunk);
      socket.off('screen-share-stopped', onScreenShareStopped);
      socket.off('chat-message', onChatMessage);
      stopScreenShare();
      socket.disconnect();
    };
  }, [session]);

  // ====================================================
  // ROOM ACTIONS
  // ====================================================
  const handleApprove = (userId) => {
    socket.emit('respond-join', { roomId, targetUserId: userId, approved: true });
    setJoinRequests(prev => prev.filter(r => r.userId !== userId));
  };

  const handleReject = (userId) => {
    socket.emit('respond-join', { roomId, targetUserId: userId, approved: false });
    setJoinRequests(prev => prev.filter(r => r.userId !== userId));
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(roomId);
    alert('Room ID copied: ' + roomId);
  };

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    socket.emit('chat-message', { roomId, nickname: session.nickname, message: chatInput.trim() });
    setChatInput('');
  };

  const handleLeaveRoom = () => {
    socket.emit('leave-room', { roomId, userId: session.userId });
    onLeave();
  };

  const handleForcePlay = () => {
    videoRef.current?.play();
    setPlayBlocked(false);
  };

  // ====================================================
  // RENDER
  // ====================================================
  if (status !== 'In Room') {
    return (
      <div className="screen-wrapper">
        <div className="card fade-in" style={{ textAlign: 'center' }}>
          <h2>{status}</h2>
          {(status.includes('Error') || status.includes('Rejected') || status.includes('Closed')) && (
            <button className="btn btn-primary" onClick={handleLeaveRoom} style={{ marginTop: '1rem' }}>
              Back to Home
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="screen-wrapper" style={{ padding: '2rem' }}>
      <div className="room-container">

        {/* Main Content */}
        <div className="room-main">
          <div className="card room-header">
            <div>
              <h3>Room: <span style={{ color: 'var(--accent-color)' }}>{roomId}</span></h3>
              <p className="subtitle" style={{ margin: 0, fontSize: '0.875rem' }}>
                {session.nickname} · {session.isHost ? 'Host' : 'Viewer'}
              </p>
            </div>
            {session.isHost ? (
              <div className="room-header-controls">
                {!isSharing ? (
                  <button className="btn btn-primary" onClick={startScreenShare} style={{ width: 'auto' }}>
                    Start Sharing Screen
                  </button>
                ) : (
                  <button className="btn btn-primary" onClick={stopScreenShare}
                    style={{ width: 'auto', backgroundColor: 'var(--danger-color)' }}>
                    Stop Sharing
                  </button>
                )}
                <button className="btn btn-secondary" onClick={handleCopyLink} style={{ width: 'auto' }}>
                  Copy Room ID
                </button>
              </div>
            ) : (
              <div style={{ padding: '0.5rem 1rem', background: 'var(--surface-hover)', borderRadius: 'var(--radius-md)' }}>
                Viewing Host's Screen
              </div>
            )}
          </div>

          <div className="card video-container">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
            />
            {playBlocked && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.8)', zIndex: 10 }}>
                <button className="btn btn-primary" onClick={handleForcePlay} style={{ width: 'auto', padding: '1rem 2rem', fontSize: '1.1rem' }}>
                  ▶ Click to Resume Video
                </button>
              </div>
            )}
            {!isSharing && !hasStream && (
              <p className="subtitle" style={{ position: 'absolute' }}>Waiting for screen stream...</p>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="room-sidebar">

          {/* Pending Requests */}
          {session.isHost && joinRequests.length > 0 && (
            <div className="card fade-in" style={{ padding: '1.5rem' }}>
              <h4 style={{ marginBottom: '1rem', color: 'var(--accent-color)' }}>Pending Requests</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {joinRequests.map(req => (
                  <div key={req.userId} style={{ background: 'var(--bg-color)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                    <p style={{ margin: 0, marginBottom: '0.5rem', fontWeight: 600 }}>{req.nickname}</p>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button className="btn btn-primary" style={{ padding: '0.5rem' }} onClick={() => handleApprove(req.userId)}>Accept</button>
                      <button className="btn btn-secondary" style={{ padding: '0.5rem' }} onClick={() => handleReject(req.userId)}>Deny</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Chat */}
          <div className="card" style={{ padding: '0', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)' }}>
              <h4 style={{ margin: 0 }}>Live Chat</h4>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {chatMessages.length === 0 && systemMessages.length === 0 && (
                <div style={{ color: 'var(--text-secondary)', textAlign: 'center', margin: 'auto' }}>Say hi to the room!</div>
              )}
              {systemMessages.map((msg, i) => (
                <div key={`sys-${i}`} style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{msg}</div>
              ))}
              {chatMessages.map((msg, i) => {
                const isMe = msg.nickname === session.nickname;
                return (
                  <div key={`chat-${i}`} style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>{msg.nickname}</span>
                    <div style={{
                      background: isMe ? 'var(--accent-color)' : 'var(--surface-hover)',
                      padding: '0.75rem 1rem',
                      borderRadius: isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                      maxWidth: '85%', wordBreak: 'break-word'
                    }}>
                      {msg.message}
                    </div>
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleSendMessage} style={{ padding: '1rem', borderTop: '1px solid var(--border-color)', display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                className="input-field"
                placeholder="Type a message..."
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                style={{ padding: '0.75rem', marginBottom: 0 }}
              />
              <button type="submit" className="btn btn-primary" style={{ width: 'auto', padding: '0.75rem 1.25rem' }} disabled={!chatInput.trim()}>
                Send
              </button>
            </form>
          </div>

          <button className="btn btn-secondary" onClick={handleLeaveRoom}>Leave Room</button>
        </div>
      </div>
    </div>
  );
};

export default Room;
