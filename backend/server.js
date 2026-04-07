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
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e6, // 5MB max per message for screen chunks
});

const rooms = {};
const disconnectTimeouts = {};

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // HOST CREATES OR REJOINS
  socket.on('create-room', ({ nickname, userId, existingRoomId }, callback) => {
    let roomId = existingRoomId;

    if (roomId && rooms[roomId] && rooms[roomId].hostUserId === userId) {
      if (disconnectTimeouts[userId]) {
        clearTimeout(disconnectTimeouts[userId]);
        delete disconnectTimeouts[userId];
      }
      rooms[roomId].hostId = socket.id;
      socket.join(roomId);
      io.to(roomId).emit('system-message', `Host ${nickname} has reconnected.`);

      Object.values(rooms[roomId].viewers).forEach(v => {
        if (v.status === 'approved') {
          socket.emit('viewer-joined', { socketId: v.socketId, nickname: v.nickname });
        }
      });
      return callback({ success: true, roomId, hostId: socket.id });
    }

    roomId = crypto.randomBytes(3).toString('hex');
    rooms[roomId] = { hostId: socket.id, hostUserId: userId, viewers: {}, isSharing: false };
    socket.join(roomId);
    console.log(`Room [${roomId}] created by ${nickname}`);
    callback({ success: true, roomId, hostId: socket.id });
  });

  // GUEST REQUESTS TO JOIN
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
      // Tell host a viewer reconnected (host will restart recording if sharing)
      io.to(room.hostId).emit('viewer-joined', { socketId: socket.id, nickname });
      return callback({ success: true, status: 'approved', hostId: room.hostId });
    }

    room.viewers[userId] = { socketId: socket.id, nickname, status: 'pending' };
    io.to(room.hostId).emit('participant-request', { socketId: socket.id, userId, nickname });
    callback({ success: true });
  });

  // HOST APPROVES/REJECTS
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

  // EXPLICIT LEAVE
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

  // ===================================================
  // SCREEN SHARING RELAY (MediaRecorder approach)
  // ===================================================
  socket.on('screen-share-started', ({ roomId, mimeType }) => {
    if (rooms[roomId]) rooms[roomId].isSharing = true;
    socket.to(roomId).emit('screen-share-started', { mimeType });
  });

  // Binary screen data relay — socketio handles ArrayBuffer natively
  socket.on('screen-chunk', ({ roomId, chunk }) => {
    socket.to(roomId).emit('screen-chunk', chunk);
  });

  socket.on('screen-share-stopped', ({ roomId }) => {
    if (rooms[roomId]) rooms[roomId].isSharing = false;
    socket.to(roomId).emit('screen-share-stopped');
  });

  // CHAT
  socket.on('chat-message', ({ roomId, nickname, message }) => {
    io.to(roomId).emit('chat-message', { nickname, message, timestamp: Date.now() });
  });

  // DISCONNECT
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
