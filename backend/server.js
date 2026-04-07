const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// ==========================================
// TURN SERVER (local dev only)
// ==========================================
const TURN_USER = 'nobar';
const TURN_PASS = crypto.randomBytes(8).toString('hex');
const TURN_PORT = 3478;

if (process.env.NODE_ENV !== 'production') {
  try {
    const Turn = require('node-turn');
    const turnServer = new Turn({
      authMech: 'long-term',
      credentials: { [TURN_USER]: TURN_PASS },
      listeningPort: TURN_PORT,
      debugLevel: 'OFF',
    });
    turnServer.start();
    console.log(`Local TURN server started on port ${TURN_PORT}`);
  } catch (e) {
    console.warn('Could not start local TURN server:', e.message);
  }
}

// ==========================================
// ICE SERVERS API ENDPOINT
// Frontend calls this to get credentials
// ==========================================
app.get('/api/ice-servers', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  if (process.env.NODE_ENV !== 'production') {
    // Local development: use our built-in TURN server
    iceServers.push({
      urls: `turn:localhost:${TURN_PORT}`,
      username: TURN_USER,
      credential: TURN_PASS,
    });
    iceServers.push({
      urls: `turn:127.0.0.1:${TURN_PORT}`,
      username: TURN_USER,
      credential: TURN_PASS,
    });
  } else if (process.env.TURN_URL) {
    // Production: use TURN credentials from env vars
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
  }

  res.json({ iceServers });
});

// ==========================================
// ROOM & USER STATE
// ==========================================
const rooms = {};
const disconnectTimeouts = {};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('create-room', ({ nickname, userId, existingRoomId }, callback) => {
    let roomId = existingRoomId;
    
    if (roomId && rooms[roomId] && rooms[roomId].hostUserId === userId) {
      if (disconnectTimeouts[userId]) {
        clearTimeout(disconnectTimeouts[userId]);
        delete disconnectTimeouts[userId];
      }
      rooms[roomId].hostId = socket.id;
      socket.join(roomId);
      console.log(`Host ${nickname} reconnected to Room [${roomId}]`);
      io.to(roomId).emit('system-message', `Host ${nickname} has reconnected.`);
      
      Object.keys(rooms[roomId].viewers).forEach(viewerUserId => {
        if (rooms[roomId].viewers[viewerUserId].status === 'approved') {
          const viewerSocketId = rooms[roomId].viewers[viewerUserId].socketId;
          socket.emit('viewer-joined', { socketId: viewerSocketId, nickname: rooms[roomId].viewers[viewerUserId].nickname });
        }
      });
      return callback({ success: true, roomId, hostId: socket.id });
    }

    roomId = crypto.randomBytes(3).toString('hex');
    rooms[roomId] = {
      hostId: socket.id,
      hostUserId: userId,
      viewers: {}
    };

    socket.join(roomId);
    console.log(`Room [${roomId}] created by Host ${nickname} (${socket.id})`);
    callback({ success: true, roomId, hostId: socket.id });
  });

  socket.on('request-join', ({ roomId, nickname, userId }, callback) => {
    const room = rooms[roomId];
    if (!room) return callback({ error: "Room not found or Host has left permanently." });

    if (userId === room.hostUserId) {
      return callback({ error: "You are the host. Please use create-room to rejoin." });
    }

    if (disconnectTimeouts[userId]) {
      clearTimeout(disconnectTimeouts[userId]);
      delete disconnectTimeouts[userId];
    }

    if (room.viewers[userId] && room.viewers[userId].status === 'approved') {
      room.viewers[userId].socketId = socket.id;
      socket.join(roomId);
      console.log(`[${roomId}] Guest ${nickname} reconnected.`);
      io.to(roomId).emit('system-message', `${nickname} has reconnected.`);
      io.to(room.hostId).emit('viewer-joined', { socketId: socket.id, nickname });
      return callback({ success: true, status: 'approved', hostId: room.hostId });
    }

    room.viewers[userId] = { socketId: socket.id, nickname, status: 'pending' };
    io.to(room.hostId).emit('participant-request', { socketId: socket.id, userId, nickname });
    callback({ success: true, message: 'Request sent to host. Waiting for approval...' });
  });

  socket.on('respond-join', ({ roomId, targetUserId, approved }) => {
    const room = rooms[roomId];
    if (room && room.hostId === socket.id) {
      const viewer = room.viewers[targetUserId];
      if (!viewer) return;

      if (approved) {
        viewer.status = 'approved';
        const targetSocket = io.sockets.sockets.get(viewer.socketId);
        if (targetSocket) targetSocket.join(roomId);
        io.to(viewer.socketId).emit('join-approved', { roomId, hostId: socket.id });
        io.to(roomId).emit('system-message', `${viewer.nickname} has joined the room.`);
        io.to(socket.id).emit('viewer-joined', { socketId: viewer.socketId, nickname: viewer.nickname });
      } else {
        io.to(viewer.socketId).emit('join-rejected', { message: 'The host declined your request.' });
        delete room.viewers[targetUserId];
      }
    }
  });

  socket.on('leave-room', ({ roomId, userId }) => {
    const room = rooms[roomId];
    if (!room) return;
    if (room.hostUserId === userId) {
      io.to(roomId).emit('room-closed', { message: 'Host has closed the room.' });
      delete rooms[roomId];
    } else if (room.viewers[userId]) {
      if (room.viewers[userId].status === 'approved') {
        io.to(roomId).emit('system-message', `${room.viewers[userId].nickname} left the room.`);
        io.to(room.hostId).emit('viewer-left', { socketId: room.viewers[userId].socketId });
      }
      delete room.viewers[userId];
    }
  });

  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', { socketId: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', { socketId: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-ice-candidate', { socketId: socket.id, candidate });
  });

  socket.on('chat-message', ({ roomId, nickname, message }) => {
    io.to(roomId).emit('chat-message', { nickname, message, timestamp: Date.now() });
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.hostId === socket.id) {
        disconnectTimeouts[room.hostUserId] = setTimeout(() => {
          if (rooms[roomId]) {
            io.to(roomId).emit('room-closed', { message: 'Host lost connection. Room closed.' });
            delete rooms[roomId];
          }
        }, 15000);
      } else {
        const viewerEntry = Object.entries(room.viewers).find(([, v]) => v.socketId === socket.id);
        if (viewerEntry) {
          const [userId, viewer] = viewerEntry;
          if (viewer.status === 'approved') {
            io.to(room.hostId).emit('viewer-left', { socketId: socket.id });
          }
          disconnectTimeouts[userId] = setTimeout(() => {
            if (rooms[roomId] && rooms[roomId].viewers[userId]) {
              io.to(roomId).emit('system-message', `${viewer.nickname} lost connection.`);
              delete rooms[roomId].viewers[userId];
            }
          }, 15000);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Nobar signaling server is running on http://localhost:${PORT}`);
});
