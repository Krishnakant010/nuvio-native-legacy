// Ultra-lightweight, zero-dependency WebSocket and HTTP coordination server for Nuvio Watch Party.
// Runs on vanilla Node.js (Desktop, VPS, Raspberry Pi, or mobile via Termux/Node runtime).
// Typical memory footprint: < 15 MB RAM.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms = new Map(); // roomId -> { leaderId, mediaId, state, timeMs, lastEpoch, clients: Set }

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      leaderId: null,
      mediaId: '',
      state: 'paused',
      timeMs: 0,
      lastEpoch: Date.now(),
      clients: new Set()
    });
  }
  return rooms.get(roomId);
}

function broadcastRoom(room, message, exceptSocket = null) {
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  for (const client of room.clients) {
    if (client.socket !== exceptSocket && client.socket.writable) {
      sendWsText(client.socket, payload);
    }
  }
}

function sendWsText(socket, text) {
  const buf = Buffer.from(text, 'utf8');
  let header;
  if (buf.length < 126) {
    header = Buffer.from([0x81, buf.length]);
  } else if (buf.length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(buf.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(buf.length), 2);
  }
  try {
    socket.write(Buffer.concat([header, buf]));
  } catch (e) {}
}

function parseWsFrames(socket, onMessage, onClose) {
  let buffer = Buffer.alloc(0);

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskKeyLen = masked ? 4 : 0;
      const totalLen = offset + maskKeyLen + len;
      if (buffer.length < totalLen) return; // Wait for full frame

      let payload = buffer.subarray(offset + maskKeyLen, totalLen);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payload.length);
        for (let i = 0; i < payload.length; i++) {
          unmasked[i] = payload[i] ^ mask[i % 4];
        }
        payload = unmasked;
      }

      buffer = buffer.subarray(totalLen);

      if (opcode === 0x8) { // Close
        if (onClose) onClose();
        socket.end();
        return;
      } else if (opcode === 0x9) { // Ping
        socket.write(Buffer.from([0x8a, 0x00])); // Pong
      } else if (opcode === 0x1) { // Text
        if (onMessage) onMessage(payload.toString('utf8'));
      }
    }
  });

  socket.on('close', () => { if (onClose) onClose(); });
  socket.on('error', () => { if (onClose) onClose(); });
}

function handleClientMessage(client, text) {
  let msg;
  try { msg = JSON.parse(text); } catch (e) { return; }
  const room = client.room;
  if (!room && msg.type !== 'join') return;

  switch (msg.type) {
    case 'join': {
      const targetRoom = getRoom((msg.room || 'default').toUpperCase());
      client.room = targetRoom;
      client.userId = msg.userId || ('user_' + Math.random().toString(36).substring(2, 8));
      client.userName = msg.userName || client.userId;
      targetRoom.clients.add(client);

      if (!targetRoom.leaderId) {
        targetRoom.leaderId = client.userId;
        client.isLeader = true;
      }

      // Send initial room state to joining client
      sendWsText(client.socket, JSON.stringify({
        type: 'room_state',
        room: targetRoom.roomId,
        leaderId: targetRoom.leaderId,
        isLeader: client.isLeader,
        mediaId: targetRoom.mediaId,
        state: targetRoom.state,
        timeMs: targetRoom.timeMs,
        participants: targetRoom.clients.size
      }));

      // Notify others in room
      broadcastRoom(targetRoom, {
        type: 'user_joined',
        room: targetRoom.roomId,
        userId: client.userId,
        participants: targetRoom.clients.size
      }, client.socket);
      break;
    }

    case 'sync': {
      // Playback state synchronization (Play / Pause / Seek)
      if (room.leaderId === client.userId || msg.force) {
        room.state = msg.state || room.state;
        room.timeMs = typeof msg.timeMs === 'number' ? msg.timeMs : room.timeMs;
        room.mediaId = msg.mediaId || room.mediaId;
        room.lastEpoch = Date.now();

        broadcastRoom(room, {
          type: 'sync',
          room: room.roomId,
          state: room.state,
          timeMs: room.timeMs,
          mediaId: room.mediaId,
          leaderId: room.leaderId,
          epoch: room.lastEpoch
        }, client.socket);
      }
      break;
    }

    case 'heartbeat': {
      // Periodic synchronization pulse to correct time drift
      if (room.leaderId === client.userId) {
        room.timeMs = typeof msg.timeMs === 'number' ? msg.timeMs : room.timeMs;
        room.state = msg.state || room.state;
        broadcastRoom(room, {
          type: 'heartbeat',
          room: room.roomId,
          timeMs: room.timeMs,
          state: room.state,
          epoch: Date.now()
        }, client.socket);
      }
      break;
    }
  }
}

function handleClientClose(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client);

  if (room.clients.size === 0) {
    rooms.delete(room.roomId);
    return;
  }

  // Elect new leader if previous leader left
  if (room.leaderId === client.userId) {
    const nextClient = room.clients.values().next().value;
    room.leaderId = nextClient.userId;
    nextClient.isLeader = true;
    broadcastRoom(room, {
      type: 'leader_changed',
      room: room.roomId,
      leaderId: room.leaderId
    });
  }

  broadcastRoom(room, {
    type: 'user_left',
    room: room.roomId,
    userId: client.userId,
    participants: room.clients.size
  });
}

function createServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        status: 'ok',
        rooms: rooms.size,
        uptime: Math.floor(process.uptime())
      }));
      return;
    }
    if (req.url === '/' || req.url === '/demo.html' || req.url === '/demo') {
      const demoPath = path.join(__dirname, 'demo.html');
      if (fs.existsSync(demoPath)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(demoPath));
        return;
      }
    }
    if (req.url === '/client.js') {
      const clientPath = path.join(__dirname, 'client.js');
      if (fs.existsSync(clientPath)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(fs.readFileSync(clientPath));
        return;
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Nuvio Watch Party Server (Active)');
  });

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    const acceptKey = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + acceptKey + '\r\n\r\n'
    );

    const client = { socket, room: null, userId: null, isLeader: false };
    parseWsFrames(
      socket,
      text => handleClientMessage(client, text),
      () => handleClientClose(client)
    );
  });

  return server;
}

if (require.main === module) {
  const PORT = process.env.PORT || 8089;
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`[WatchParty] Server started on port ${PORT}`);
  });
}

module.exports = { createServer, rooms };
