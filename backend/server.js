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
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// =============================================
// ICE SERVERS CONFIG ENDPOINT
// Frontend calls this to get TURN credentials
// =============================================
app.get('/api/ice-servers', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  // Production TURN from environment variables (set these in Railway dashboard)
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    });
    // Add TCP fallback if configured
    if (process.env.TURN_URL_TCP) {
      iceServers.push({
        urls: process.env.TURN_URL_TCP,
        username: process.env.TURN_USERNAME || '',
        credential: process.env.TURN_CREDENTIAL || '',
      });
    }
  }

  res.json({ iceServers });
});

// =============================================
// ROOM & SESSION STATE
// =============================================
const rooms = {};
const disconnectTimeouts = {};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // ---- HOST ----
  socket.on('create-room', ({ nickname, userId, existingRoomId }, callback) => {
    let roomId = existingRoomId;

    if (roomId && rooms[roomId] && rooms[roomId].hostUserId === userId) {
      if (disconnectTimeouts[userId]) {
        clearTimeout(disconnectTimeouts[userId]);
        delete disconnectTimeouts[userId];
      }
      rooms[roomId].hostId = socket.id;
      socket.join(roomId);
      console.log(`Host ${nickname} reconnected to room [${roomId}]`);
      io.to(roomId).emit('system-message', `Host ${nickname} has reconnected.`);

      // Re-trigger viewer-joined for each approved viewer so host can re-negotiate WebRTC
      Object.values(rooms[roomId].viewers).forEach(v => {
        if (v.status === 'approved') {
          socket.emit('viewer-joined', { socketId: v.socketId, nickname: v.nickname });
        }
      });
      return callback({ success: true, roomId, hostId: socket.id });
    }

    roomId = crypto.randomBytes(3).toString('hex');
    rooms[roomId] = { hostId: socket.id, hostUserId: userId, viewers: {} };
    socket.join(roomId);
    console.log(`Room [${roomId}] created by ${nickname}`);
    callback({ success: true, roomId, hostId: socket.id });
  });

  // ---- GUEST ----
  socket.on('request-join', ({ roomId, nickname, userId }, callback) => {
    const room = rooms[roomId];
    if (!room) return callback({ error: "Room not found." });
    if (userId === room.hostUserId) return callback({ error: "You are the host." });

    if (disconnectTimeouts[userId]) {
      clearTimeout(disconnectTimeouts[userId]);
      delete disconnectTimeouts[userId];
    }

    if (room.viewers[userId]?.status === 'approved') {
      room.viewers[userId].socketId = socket.id;
      socket.join(roomId);
      io.to(roomId).emit('system-message', `${nickname} has reconnected.`);
      io.to(room.hostId).emit('viewer-joined', { socketId: socket.id, nickname });
      return callback({ success: true, status: 'approved', hostId: room.hostId });
    }

    room.viewers[userId] = { socketId: socket.id, nickname, status: 'pending' };
    io.to(room.hostId).emit('participant-request', { socketId: socket.id, userId, nickname });
    callback({ success: true });
  });

  socket.on('respond-join', ({ roomId, targetUserId, approved }) => {
    const room = rooms[roomId];
    if (!room || room.hostId !== socket.id) return;
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
      }
      delete room.viewers[userId];
    }
  });

  // ---- WEBRTC SIGNALING ----
  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    io.to(targetSocketId).emit('webrtc-offer', { socketId: socket.id, offer });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('webrtc-answer', { socketId: socket.id, answer });
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('webrtc-ice-candidate', { socketId: socket.id, candidate });
  });

  // ---- CHAT ----
  socket.on('chat-message', ({ roomId, nickname, message }) => {
    io.to(roomId).emit('chat-message', { nickname, message, timestamp: Date.now() });
  });

  // ---- DISCONNECT ----
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
        const entry = Object.entries(room.viewers).find(([, v]) => v.socketId === socket.id);
        if (entry) {
          const [userId, viewer] = entry;
          disconnectTimeouts[userId] = setTimeout(() => {
            if (rooms[roomId]?.viewers[userId]) {
              if (viewer.status === 'approved') {
                io.to(roomId).emit('system-message', `${viewer.nickname} lost connection.`);
              }
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
  console.log(`Nobar signaling server running on port ${PORT}`);
});
