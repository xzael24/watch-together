import { useState } from 'react'
import WelcomeScreen from './components/WelcomeScreen'
import Room from './components/Room'
import './index.css'

function App() {
  const [session, setSession] = useState(() => {
    const saved = sessionStorage.getItem('nobar_session');
    return saved ? JSON.parse(saved) : null;
  });

  const [userId] = useState(() => {
    const saved = sessionStorage.getItem('nobar_userId');
    if (saved) return saved;
    const newId = Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem('nobar_userId', newId);
    return newId;
  });

  const handleJoinSuite = (sessionData) => {
    const freshSession = { ...sessionData, userId };
    setSession(freshSession);
    sessionStorage.setItem('nobar_session', JSON.stringify(freshSession));
  }

  const handleLeaveRoom = () => {
    setSession(null);
    sessionStorage.removeItem('nobar_session');
  }

  return (
    <>
      {!session ? (
        <WelcomeScreen onJoinSuite={handleJoinSuite} />
      ) : (
        <Room session={session} onLeave={handleLeaveRoom} />
      )}
    </>
  )
}

export default App
