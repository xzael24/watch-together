import React, { useEffect, useState, useRef } from 'react';
import { socket } from '../socket';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

const Room = ({ session, onLeave }) => {
  const [roomId, setRoomId] = useState(session.roomId || '');
  const [hostId, setHostId] = useState('');
  const [status, setStatus] = useState('Connecting...'); 
  const [joinRequests, setJoinRequests] = useState([]);
  const [systemMessages, setSystemMessages] = useState([]);
  
  // Phase 5: Chat State
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef(null);
  
  // WebRTC & Media State
  const [isSharing, setIsSharing] = useState(false);
  const [hasStream, setHasStream] = useState(false);
  const [playBlocked, setPlayBlocked] = useState(false);
  const videoRef = useRef(null);
  const localStream = useRef(null);
  const peerConnections = useRef({}); 
  const webrtcLocks = useRef({});

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  useEffect(() => {
    socket.connect();

    if (session.isHost) {
      socket.emit('create-room', { 
        nickname: session.nickname, 
        userId: session.userId, 
        existingRoomId: session.roomId 
      }, (res) => {
        if (res.success) {
          setRoomId(res.roomId);
          setHostId(res.hostId);
          setStatus('In Room');
          
          const savedStr = sessionStorage.getItem('nobar_session');
          if (savedStr) {
            const parsed = JSON.parse(savedStr);
            parsed.roomId = res.roomId;
            sessionStorage.setItem('nobar_session', JSON.stringify(parsed));
          }
        }
      });
    } else {
      socket.emit('request-join', { 
        roomId: session.roomId, 
        nickname: session.nickname,
        userId: session.userId
      }, (res) => {
        if (res.error) {
          setStatus('Error: ' + res.error);
        } else if (res.status === 'approved') {
          setStatus('In Room');
          setHostId(res.hostId);
        } else {
          setStatus('Waiting Approval...');
        }
      });
    }

    const onParticipantRequest = (data) => setJoinRequests(prev => {
      if (prev.some(req => req.userId === data.userId)) return prev;
      return [...prev, data];
    });
    const onJoinApproved = (data) => {
      setRoomId(data.roomId);
      setHostId(data.hostId);
      setStatus('In Room');
    };
    const onJoinRejected = (data) => {
      setStatus('Rejected: ' + data.message);
      socket.disconnect();
    };
    const onSystemMessage = (message) => setSystemMessages(prev => [...prev, message]);
    const onRoomClosed = (data) => {
      setStatus('Room Closed: ' + data.message);
      stopScreenShare();
      socket.disconnect();
    };

    const onViewerJoined = async ({ socketId, nickname }) => {
      createPeerConnection(socketId);
      if (localStream.current) {
        await negotiateConnection(socketId);
      }
    };

    const onViewerLeft = ({ socketId }) => {
      if (peerConnections.current[socketId]) {
        peerConnections.current[socketId].close();
        delete peerConnections.current[socketId];
      }
    };

    const onWebrtcOffer = async ({ socketId, offer }) => {
      if (webrtcLocks.current[socketId]) return;
      webrtcLocks.current[socketId] = true;
      try {
        const pc = createPeerConnection(socketId);
        if (pc.signalingState !== "stable") {
          webrtcLocks.current[socketId] = false;
          return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-answer', { targetSocketId: socketId, answer });
      } catch (e) {
        if (!e.message.includes('wrong state')) {
          console.error("Error handling WebRTC offer:", e);
        }
      } finally {
        webrtcLocks.current[socketId] = false;
      }
    };

    const onWebrtcAnswer = async ({ socketId, answer }) => {
      try {
        const pc = peerConnections.current[socketId];
        if (pc && pc.signalingState !== "stable") {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
      } catch (e) {
        console.error("Error handling WebRTC answer:", e);
      }
    };

    const onWebrtcIceCandidate = async ({ socketId, candidate }) => {
      const pc = peerConnections.current[socketId];
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error("Error adding ice candidate:", e);
        }
      }
    };

    // Phase 5: Chat Listener
    const onChatMessage = (data) => {
      setChatMessages(prev => [...prev, data]);
    };

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
      socket.disconnect();
    };
  }, [session]);

  const createPeerConnection = (targetSocketId) => {
    if (peerConnections.current[targetSocketId]) return peerConnections.current[targetSocketId];

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnections.current[targetSocketId] = pc;

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc-ice-candidate', { targetSocketId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      if (videoRef.current && event.streams[0]) {
        videoRef.current.srcObject = event.streams[0];
        setHasStream(true);
        
        // Attempt to autoplay, browser might block it if user refreshed without interacting
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.play().catch(e => {
              console.error("Autoplay blocked by browser:", e);
              setPlayBlocked(true);
            });
          }
        }, 100);

        const track = event.streams[0].getVideoTracks()[0];
        if (track) {
          track.onended = () => {
            setHasStream(false);
          };
        }
      }
    };

    if (session.isHost && localStream.current) {
      localStream.current.getTracks().forEach(track => {
        pc.addTrack(track, localStream.current);
      });
    }

    return pc;
  };

  const negotiateConnection = async (targetSocketId) => {
    const pc = peerConnections.current[targetSocketId];
    if (!pc) return;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetSocketId, offer });
  };

  const startScreenShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      localStream.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true; 
      }
      setIsSharing(true);

      stream.getVideoTracks()[0].onended = () => {
        stopScreenShare();
      };

      for (const [targetSocketId, pc] of Object.entries(peerConnections.current)) {
        stream.getTracks().forEach(track => {
          pc.addTrack(track, stream);
        });
        await negotiateConnection(targetSocketId);
      }
      
    } catch (err) {
      console.error("Error sharing screen: ", err);
    }
  };

  const stopScreenShare = () => {
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
      localStream.current = null;
    }
    setIsSharing(false);
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  };

  const handleApprove = (targetUserId) => {
    socket.emit('respond-join', { roomId, targetUserId, approved: true });
    setJoinRequests(prev => prev.filter(req => req.userId !== targetUserId));
  };
  
  const handleReject = (targetUserId) => {
    socket.emit('respond-join', { roomId, targetUserId, approved: false });
    setJoinRequests(prev => prev.filter(req => req.userId !== targetUserId));
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(roomId);
    alert('Room ID copied: ' + roomId);
  };

  // Phase 5: Sending Chat
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
    if (videoRef.current) {
      videoRef.current.play();
      setPlayBlocked(false);
    }
  };

  if (status !== 'In Room') {
    return (
      <div className="screen-wrapper">
        <div className="card fade-in" style={{ textAlign: 'center' }}>
          <h2>{status}</h2>
          {status.includes('Error') || status.includes('Rejected') || status.includes('Closed') ? (
            <button className="btn btn-primary" onClick={handleLeaveRoom} style={{ marginTop: '1rem' }}>
              Back to Home
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="screen-wrapper" style={{ padding: '2rem' }}>
      <div className="room-container">
        
        {/* Main Content Area */}
        <div className="room-main">
          <div className="card room-header">
            <div>
              <h3>Room: <span style={{ color: 'var(--accent-color)' }}>{roomId}</span></h3>
              <p className="subtitle" style={{ margin: 0, fontSize: '0.875rem' }}>You are logged in as {session.nickname}</p>
            </div>
            {session.isHost ? (
              <div className="room-header-controls">
                 {!isSharing ? (
                   <button className="btn btn-primary" onClick={startScreenShare} style={{ width: 'auto' }}>
                     Start Sharing Screen
                   </button>
                 ) : (
                   <button className="btn btn-primary" onClick={stopScreenShare} style={{ width: 'auto', backgroundColor: 'var(--danger-color)' }}>
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
             {!isSharing && !hasStream && <p className="subtitle" style={{ position: 'absolute' }}>Waiting for screen stream...</p>}
          </div>
        </div>

        {/* Sidebar */}
        <div className="room-sidebar">
          
          {/* Requests Component */}
          {session.isHost && joinRequests.length > 0 && (
            <div className="card fade-in" style={{ padding: '1.5rem', maxWidth: '100%' }}>
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

          {/* Chat Component */}
          <div className="card" style={{ padding: '0', maxWidth: '100%', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)' }}>
              <h4 style={{ margin: 0 }}>Live Chat</h4>
            </div>
            
            <div style={{ flex: 1, overflowY: 'auto', padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Render System Messages alongside regular messages if needed, here we focus on Chat */}
              {chatMessages.length === 0 && systemMessages.length === 0 && (
                <div style={{ color: 'var(--text-secondary)', textAlign: 'center', margin: 'auto' }}>Say hi to the room!</div>
              )}
              
              {systemMessages.map((msg, idx) => (
                <div key={`sys-${idx}`} style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {msg}
                </div>
              ))}

              {chatMessages.map((msg, idx) => {
                const isMe = msg.nickname === session.nickname;
                return (
                  <div key={`chat-${idx}`} style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                      {msg.nickname}
                    </span>
                    <div style={{
                      background: isMe ? 'var(--accent-color)' : 'var(--surface-hover)',
                      padding: '0.75rem 1rem',
                      borderRadius: isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                      maxWidth: '85%',
                      wordBreak: 'break-word'
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
                onChange={(e) => setChatInput(e.target.value)}
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
