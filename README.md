# Nobar (Watch Together)

Nobar is a modern, minimalist web application built to facilitate seamless screen-sharing and real-time interactions. The platform allows users to create private screening rooms securely, invite peers, and interact through a synchronized live text chat.

## Features

- **Peer-to-Peer Screen Sharing**
  Utilizes the WebRTC API to deliver high-quality, ultra-low latency screen and audio broadcasts directly between browsers.

- **Private Room Ecosystem**
  Host-controlled private instances linked with a customized 6-character unique ID. Each instance supports independent broadcast signals.

- **Access Management**
  A live lobby reception mechanism allows the host to approve or deny incoming viewer connections in real-time.

- **Real-time Live Chat**
  A persistent, low-latency live messenger channel tied to the room, integrated directly into the dashboard for communication alongside the broadcast.

- **Fault-Tolerant Session Persistence**
  Implements a temporary cooldown survival architecture. Web resources and layouts seamlessly auto-recover from unexpected browser refreshes or unintentional disconnections.

- **Adaptive Mobile Interface**
  Engineered with a responsive layout system ensuring a perfect fit and scroll management across desktops, tablets, and mobile portrait orientations.

## Technology Stack

- **Frontend Environment**: React.js with Vite
- **Styling Architecture**: Pure Vanilla CSS, curated with minimalist dark-mode aesthetics and glassmorphism.
- **Backend Environment**: Node.js & Express.js
- **Signaling Layer**: Socket.IO
- **Core Technology**: WebRTC (RTCPeerConnection & MediaDevices API)

## Installation Guide

To run local development instances, ensure you have Node.js installed. Split your terminal instances to run backend and frontend separately.

### 1. Launching the Backend (Signaling Server)

Navigate to the backend directory and install the necessary dependencies:
```bash
cd backend
npm install
```

Start the signaling server:
```bash
npm start
```
The server will initialize on port 3001.

### 2. Launching the Frontend (Client)

Navigate to the frontend directory and install dependencies:
```bash
cd frontend
npm install
```

Start the Vite development server:
```bash
npm run dev
```
The console will output a localhost address (usually http://localhost:5173). Access this URL on your browser to view the application.

## Deployment Configurations

For production deployments, Nobar relies on an explicit assignment of environment variables to link the separated nodes.

1. Deploy the backend source code to any WebSocket-compatible host provider (e.g., Render, Railway).
2. Note the generated public URL of the backend hosting.
3. Deploy the frontend source code (e.g., Vercel, Netlify), and provide the backend link in the platform's Environment Variables setting with the following key:
   `VITE_BACKEND_URL=https://your-backend-address.com`

## Mechanism Notes

Due to strict automated media blocking policies embedded within modern web browsers, viewing screenshares post-reconnection/refresh may require manual interaction on the viewer's side (clicking the unblock overlay prompt) before acquiring permission to run the media track natively.

## License

This application is provided as an open-structured project setup for learning WebRTC data flows and real-time socket environments.
