import React, { useState } from 'react';

const WelcomeScreen = ({ onJoinSuite }) => {
  const [nickname, setNickname] = useState('');
  const [roomId, setRoomId] = useState('');

  const handleCreateRoom = (e) => {
    e.preventDefault();
    if (!nickname.trim()) return;
    onJoinSuite({ nickname, isHost: true });
  };

  const handleJoinRoom = (e) => {
    e.preventDefault();
    if (!nickname.trim() || !roomId.trim()) return;
    onJoinSuite({ nickname, roomId, isHost: false });
  };

  return (
    <div className="screen-wrapper">
      <div className="card fade-in">
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <h1>Nobar</h1>
          <p className="subtitle">Watch together, seamlessly.</p>
        </div>

        <div className="input-group">
          <label className="input-label">Your Nickname</label>
          <input
            type="text"
            className="input-field"
            placeholder="e.g. John Doe"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
          />
        </div>

        <div className="btn-group">
          <button 
            className="btn btn-primary" 
            onClick={handleCreateRoom}
            disabled={!nickname.trim()}
          >
            Create New Room
          </button>
          
          <div className="divider">OR</div>
          
          <div className="input-group" style={{ marginBottom: '1rem' }}>
            <label className="input-label">Room Link / ID</label>
            <input
              type="text"
              className="input-field"
              placeholder="Paste room Link/ID to join..."
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
            />
          </div>
          
          <button 
            className="btn btn-secondary" 
            onClick={handleJoinRoom}
            disabled={!nickname.trim() || !roomId.trim()}
          >
            Request to Join Room
          </button>
        </div>
      </div>
    </div>
  );
};

export default WelcomeScreen;
