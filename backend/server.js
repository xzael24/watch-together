const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// User identification & Room storage
const rooms = {};
const disconnectTimeouts = {}; 

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // 1. HOST CREATES OR REJOINS A ROOM
  socket.on('create-room', ({ nickname, userId, existingRoomId }, callback) => {
    let roomId = existingRoomId;
    
    // If it's a rejoin and room still exists, reuse it
    if (roomId && rooms[roomId] && rooms[roomId].hostUserId === userId) {
      if (disconnectTimeouts[userId]) {
        clearTimeout(disconnectTimeouts[userId]);
        delete disconnectTimeouts[userId];
      }
      rooms[roomId].hostId = socket.id;
      socket.join(roomId);
      console.log(`Host ${nickname} reconnected to Room [${roomId}]`);
      
      // Tell everyone the host is back so WebRTC can renegotiate if needed
      io.to(roomId).emit('system-message', `Host ${nickname} has reconnected.`);
      
      // Request new connections to all approved viewers
      Object.keys(rooms[roomId].viewers).forEach(viewerUserId => {
        if (rooms[roomId].viewers[viewerUserId].status === 'approved') {
          const viewerSocketId = rooms[roomId].viewers[viewerUserId].socketId;
          socket.emit('viewer-joined', { socketId: viewerSocketId, nickname: rooms[roomId].viewers[viewerUserId].nickname });
        }
      });
      return callback({ success: true, roomId, hostId: socket.id });
    }

    // Otherwise create a new room
    roomId = crypto.randomBytes(3).toString('hex');
    rooms[roomId] = {
      hostId: socket.id,
      hostUserId: userId,
      viewers: {} // userId -> { socketId, nickname, status }
    };

    socket.join(roomId);
    console.log(`Room [${roomId}] created by Host ${nickname} (${socket.id})`);
    callback({ success: true, roomId, hostId: socket.id });
  });

  // 2. GUEST REQUESTS TO JOIN / REJOIN
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

    // If viewer is already approved (rejoining after refresh)
    if (room.viewers[userId] && room.viewers[userId].status === 'approved') {
      room.viewers[userId].socketId = socket.id;
      socket.join(roomId);
      console.log(`[${roomId}] Guest ${nickname} reconnected.`);
      
      io.to(roomId).emit('system-message', `${nickname} has reconnected.`);
      io.to(room.hostId).emit('viewer-joined', { socketId: socket.id, nickname });
      
      return callback({ success: true, status: 'approved', hostId: room.hostId });
    }

    // New Join Request
    room.viewers[userId] = { socketId: socket.id, nickname, status: 'pending' };
    console.log(`[${roomId}] Guest ${nickname} requesting to join.`);

    io.to(room.hostId).emit('participant-request', {
      socketId: socket.id,
      userId,
      nickname
    });

    callback({ success: true, message: 'Request sent to host. Waiting for approval...' });
  });

  // 3. HOST APPROVES/REJECTS GUESTS
  socket.on('respond-join', ({ roomId, targetUserId, approved }) => {
    const room = rooms[roomId];
    
    if (room && room.hostId === socket.id) {
      const viewer = room.viewers[targetUserId];
      if (!viewer) return;

      if (approved) {
        viewer.status = 'approved';
        const targetSocket = io.sockets.sockets.get(viewer.socketId);
        if (targetSocket) {
          targetSocket.join(roomId);
        }
        
        io.to(viewer.socketId).emit('join-approved', { roomId, hostId: socket.id });
        io.to(roomId).emit('system-message', `${viewer.nickname} has joined the room.`);
        
        io.to(socket.id).emit('viewer-joined', { socketId: viewer.socketId, nickname: viewer.nickname });
      } else {
        io.to(viewer.socketId).emit('join-rejected', { message: 'The host declined your request.' });
        delete room.viewers[targetUserId];
      }
    }
  });

  // EXPLICIT LEAVE - clear immediately without timeouts
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

  // WEBRTC & CHAT PASS-THROUGH
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
    io.to(roomId).emit('chat-message', {
      nickname,
      message,
      timestamp: Date.now()
    });
  });

  // DISCONNECT FAULT TOLERANCE 
  socket.on('disconnect', () => {
    console.log(`User disconnected/refreshed: ${socket.id}`);
    
    for (const [roomId, room] of Object.entries(rooms)) {
      if (room.hostId === socket.id) {
        // Give Host 15 seconds to reconnect from a refresh
        disconnectTimeouts[room.hostUserId] = setTimeout(() => {
           if (rooms[roomId]) {
             io.to(roomId).emit('room-closed', { message: 'Host lost connection. Room closed.' });
             delete rooms[roomId];
           }
        }, 15000);
      } else {
        // Viewer disconnect
        const viewerEntry = Object.entries(room.viewers).find(([vid, v]) => v.socketId === socket.id);
        if (viewerEntry) {
          const [userId, viewer] = viewerEntry;
          if (viewer.status === 'approved') {
             // Let host know their WebRTC connection might be dead
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
