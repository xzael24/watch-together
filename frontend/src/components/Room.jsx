import React, { useEffect, useState, useRef } from 'react';
import { socket } from '../socket';

const BACKEND_URL = (() => {
  const raw = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
  return raw.startsWith('http') ? raw : `https://${raw}`;
})();

const DEFAULT_ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

// Detect mobile device
const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(navigator.userAgent);

// Check if screen sharing is natively supported
const canDisplayMedia = !!(navigator.mediaDevices?.getDisplayMedia);

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
  const [shareMode, setShareMode] = useState(null); // 'screen' | 'camera' | null
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  const videoRef = useRef(null);
  const chatEndRef = useRef(null);
  const localStream = useRef(null);
  const peerConnections = useRef({});
  const pendingCandidates = useRef({});
  const iceConfig = useRef(DEFAULT_ICE);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Fetch ICE servers (TURN credentials) from backend
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/ice-servers`)
      .then(r => r.json())
      .then(data => {
        console.log('[ICE] Config loaded:', data.iceServers.map(s => s.urls));
        iceConfig.current = { iceServers: data.iceServers };
      })
      .catch(() => {
        console.warn('[ICE] Could not fetch config, using defaults.');
      });
  }, []);

  // ======================================================
  // WEBRTC HELPERS
  // ======================================================
  const createPeerConnection = (targetSocketId) => {
    // Close any existing connection
    if (peerConnections.current[targetSocketId]) {
      peerConnections.current[targetSocketId].close();
    }
    pendingCandidates.current[targetSocketId] = [];

    const pc = new RTCPeerConnection(iceConfig.current);
    peerConnections.current[targetSocketId] = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[ICE] Sending candidate type=${event.candidate.type}`);
        socket.emit('webrtc-ice-candidate', { targetSocketId, candidate: event.candidate });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[PC ${targetSocketId.slice(-4)}] ICE: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      console.log(`[PC ${targetSocketId.slice(-4)}] Connection: ${pc.connectionState}`);
    };

    // VIEWER: receive the stream here
    pc.ontrack = (event) => {
      console.log('[VIEWER] ontrack fired, streams:', event.streams.length);
      if (videoRef.current && event.streams[0]) {
        videoRef.current.srcObject = event.streams[0];
        setHasStream(true);
        setPlayBlocked(false);

        const playPromise = videoRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch(e => {
            if (e.name === 'NotAllowedError') setPlayBlocked(true);
          });
        }

        const track = event.streams[0].getVideoTracks()[0];
        if (track) {
          track.onended = () => setHasStream(false);
        }
      }
    };

    // HOST: add tracks if stream exists
    if (session.isHost && localStream.current) {
      localStream.current.getTracks().forEach(track => {
        pc.addTrack(track, localStream.current);
      });
    }

    return pc;
  };

  const drainPendingCandidates = async (socketId, pc) => {
    const pending = pendingCandidates.current[socketId] || [];
    if (pending.length > 0) {
      console.log(`[ICE] Draining ${pending.length} buffered candidates for ${socketId.slice(-4)}`);
    }
    for (const c of pending) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) {}
    }
    pendingCandidates.current[socketId] = [];
  };

  const negotiateConnection = async (targetSocketId) => {
    const pc = peerConnections.current[targetSocketId];
    if (!pc) return;
    console.log('[HOST] Creating offer for:', targetSocketId.slice(-4));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetSocketId, offer });
  };

  // ======================================================
  // SCREEN / CAMERA SHARE
  // ======================================================
  const applyStream = (stream, mode) => {
    localStream.current = stream;

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      videoRef.current.play().catch(() => {});
    }

    setIsSharing(true);
    setShareMode(mode);
    setShowMobileMenu(false);

    // Renegotiate with all connected viewers
    Object.entries(peerConnections.current).forEach(async ([socketId, pc]) => {
      stream.getTracks().forEach(track => {
        try { pc.addTrack(track, stream); } catch (e) {}
      });
      await negotiateConnection(socketId);
    });

    stream.getVideoTracks()[0].onended = () => stopScreenShare();
  };

  const startScreenShare = async () => {
    setShowMobileMenu(false);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      applyStream(stream, 'screen');
    } catch (e) {
      if (e.name !== 'NotAllowedError') {
        console.error('[HOST] Screen share error:', e);
        if (isMobile) alert('Screen sharing tidak didukung di browser ini. Coba pakai kamera.');
      }
    }
  };

  const startCameraShare = async () => {
    setShowMobileMenu(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: true,
      });
      applyStream(stream, 'camera');
    } catch (e) {
      if (e.name !== 'NotAllowedError') {
        console.error('[HOST] Camera share error:', e);
      }
    }
  };

  const stopScreenShare = () => {
    if (localStream.current) {
      localStream.current.getTracks().forEach(t => t.stop());
      localStream.current = null;
    }
    setIsSharing(false);
    setShareMode(null);
    setShowMobileMenu(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  // ======================================================
  // SOCKET EVENTS
  // ======================================================
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
        if (res.error) setStatus('Error: ' + res.error);
        else if (res.status === 'approved') setStatus('In Room');
        else setStatus('Waiting Approval...');
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

    // HOST: viewer joined → create PC and negotiate if streaming
    const onViewerJoined = async ({ socketId, nickname }) => {
      console.log('[HOST] Viewer joined:', nickname, socketId.slice(-4));
      const pc = createPeerConnection(socketId);
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => {
          try { pc.addTrack(track, localStream.current); } catch (e) {}
        });
        await negotiateConnection(socketId);
      }
    };

    const onViewerLeft = ({ socketId }) => {
      if (peerConnections.current[socketId]) {
        peerConnections.current[socketId].close();
        delete peerConnections.current[socketId];
        delete pendingCandidates.current[socketId];
      }
    };

    // VIEWER: receives offer from host
    const onWebrtcOffer = async ({ socketId, offer }) => {
      console.log('[VIEWER] Received offer from', socketId.slice(-4));
      try {
        const pc = createPeerConnection(socketId);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        await drainPendingCandidates(socketId, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-answer', { targetSocketId: socketId, answer });
        console.log('[VIEWER] Answer sent');
      } catch (e) {
        console.error('[VIEWER] Offer handling error:', e);
      }
    };

    // HOST: receives answer from viewer
    const onWebrtcAnswer = async ({ socketId, answer }) => {
      console.log('[HOST] Received answer from', socketId.slice(-4));
      try {
        const pc = peerConnections.current[socketId];
        if (!pc) return console.warn('[HOST] No PC found for', socketId.slice(-4));
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
          await drainPendingCandidates(socketId, pc);
          console.log('[HOST] Remote description set successfully');
        }
      } catch (e) {
        console.error('[HOST] Answer handling error:', e);
      }
    };

    const onWebrtcIceCandidate = async ({ socketId, candidate }) => {
      const pc = peerConnections.current[socketId];
      if (!pc || !pc.remoteDescription) {
        if (!pendingCandidates.current[socketId]) pendingCandidates.current[socketId] = [];
        pendingCandidates.current[socketId].push(candidate);
        return;
      }
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        // Ignore benign candidate errors
      }
    };

    const onChatMessage = (data) => setChatMessages(prev => [...prev, data]);

    socket.on('participant-request', onParticipantRequest);
    socket.on('join-approved', onJoinApproved);
    socket.on('join-rejected', onJoinRejected);
    socket.on('system-message', onSystemMessage);
    socket.on('room-closed', onRoomClosed);
    socket.on('viewer-joined', onViewerJoined);
    socket.on('viewer-left', onViewerLeft);
    socket.on('webrtc-offer', onWebrtcOffer);
    socket.on('webrtc-answer', onWebrtcAnswer);
    socket.on('webrtc-ice-candidate', onWebrtcIceCandidate);
    socket.on('chat-message', onChatMessage);

    return () => {
      socket.off('participant-request', onParticipantRequest);
      socket.off('join-approved', onJoinApproved);
      socket.off('join-rejected', onJoinRejected);
      socket.off('system-message', onSystemMessage);
      socket.off('room-closed', onRoomClosed);
      socket.off('viewer-joined', onViewerJoined);
      socket.off('viewer-left', onViewerLeft);
      socket.off('webrtc-offer', onWebrtcOffer);
      socket.off('webrtc-answer', onWebrtcAnswer);
      socket.off('webrtc-ice-candidate', onWebrtcIceCandidate);
      socket.off('chat-message', onChatMessage);
      stopScreenShare();
      Object.values(peerConnections.current).forEach(pc => pc.close());
      socket.disconnect();
    };
  }, [session]);

  // ======================================================
  // ROOM ACTIONS
  // ======================================================
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

  // ======================================================
  // RENDER
  // ======================================================
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
                  isMobile ? (
                    <div style={{ position: 'relative' }}>
                      <button className="btn btn-primary" onClick={() => setShowMobileMenu(p => !p)} style={{ width: 'auto' }}>
                        Start Sharing ▾
                      </button>
                      {showMobileMenu && (
                        <div style={{
                          position: 'absolute', top: '110%', left: 0,
                          background: 'var(--surface-color)', border: '1px solid var(--border-color)',
                          borderRadius: 'var(--radius-md)', zIndex: 100, minWidth: '180px',
                          boxShadow: '0 8px 24px rgba(0,0,0,0.4)', overflow: 'hidden',
                        }}>
                          {canDisplayMedia && (
                            <button className="btn" onClick={startScreenShare}
                              style={{ width: '100%', padding: '0.75rem 1rem', textAlign: 'left', borderRadius: 0, background: 'transparent', border: 'none', cursor: 'pointer' }}>
                              Share Screen
                            </button>
                          )}
                          <button className="btn" onClick={startCameraShare}
                            style={{ width: '100%', padding: '0.75rem 1rem', textAlign: 'left', borderRadius: 0, background: 'transparent', border: 'none', cursor: 'pointer', borderTop: canDisplayMedia ? '1px solid var(--border-color)' : 'none' }}>
                            Share Camera
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <button className="btn btn-primary" onClick={startScreenShare} style={{ width: 'auto' }}>
                      Start Sharing Screen
                    </button>
                  )
                ) : (
                  <button className="btn btn-primary" onClick={stopScreenShare}
                    style={{ width: 'auto', backgroundColor: 'var(--danger-color)' }}>
                    Stop {shareMode === 'camera' ? 'Camera' : 'Screen'}
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
            <video ref={videoRef} autoPlay playsInline
              style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }} />
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
                    }}>{msg.message}</div>
                  </div>
                );
              })}
              <div ref={chatEndRef} />
            </div>
            <form onSubmit={handleSendMessage} style={{ padding: '1rem', borderTop: '1px solid var(--border-color)', display: 'flex', gap: '0.5rem' }}>
              <input type="text" className="input-field" placeholder="Type a message..."
                value={chatInput} onChange={e => setChatInput(e.target.value)}
                style={{ padding: '0.75rem', marginBottom: 0 }} />
              <button type="submit" className="btn btn-primary"
                style={{ width: 'auto', padding: '0.75rem 1.25rem' }} disabled={!chatInput.trim()}>
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
