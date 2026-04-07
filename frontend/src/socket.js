import { io } from 'socket.io-client';

// Check if there's a specific backend URL configured in `.env`, otherwise use standard localhost/origin routing
const URL = import.meta.env.VITE_BACKEND_URL || (import.meta.env.PROD ? undefined : 'http://localhost:3001');

export const socket = io(URL, {
  autoConnect: false, // Don't connect until we intentionally join/create a room
});
