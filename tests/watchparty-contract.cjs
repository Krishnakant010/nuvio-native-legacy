// Automated contract test for Nuvio Watch Party.
// Verifies server lifecycle, client synchronization, message exchange, and failure isolation.
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../watchparty/server.js');
const NuvioWatchParty = require('../watchparty/client.js');

(async () => {
  let failures = 0;
  function check(name, fn) {
    try { fn(); console.log('PASS:', name); }
    catch (e) { failures++; console.error('FAIL:', name, e.message); }
  }

  // 1. Scenario: Server Unavailable (Graceful Degradation)
  let offlineReported = false;
  NuvioWatchParty.on('status', status => {
    if (status === 'offline') offlineReported = true;
  });
  // Attempt connection on unopened port
  NuvioWatchParty.connect('ws://127.0.0.1:59999', 'TEST1', 'UserTest', false);
  await new Promise(r => setTimeout(r, 100));
  check('client reports offline gracefully when server is unavailable', () => {
    assert.equal(offlineReported, true);
    assert.equal(NuvioWatchParty.getStatus(), 'offline');
  });
  NuvioWatchParty.disconnect();

  // 2. Scenario: Start Local Server
  const server = createServer();
  const PORT = 8097;
  await new Promise(r => server.listen(PORT, r));

  check('watchparty server starts and serves health endpoint', async () => {
    const res = await new Promise(resolve => {
      http.get(`http://127.0.0.1:${PORT}/health`, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => resolve(JSON.parse(body)));
      });
    });
    assert.equal(res.status, 'ok');
  });

  // 3. Scenario: Host and Guest connect to same room via WebSocket
  let hostWs, guestWs;

  await new Promise(resolve => {
    hostWs = new WebSocket(`ws://127.0.0.1:${PORT}`);
    hostWs.onopen = () => {
      hostWs.send(JSON.stringify({ type: 'join', room: 'ROOM1', userId: 'host_1', isLeader: true }));
      resolve();
    };
  });

  let guestReceivedSync = [];
  await new Promise(resolve => {
    guestWs = new WebSocket(`ws://127.0.0.1:${PORT}`);
    guestWs.onopen = () => {
      guestWs.send(JSON.stringify({ type: 'join', room: 'ROOM1', userId: 'guest_1', isLeader: false }));
      resolve();
    };
    guestWs.onmessage = event => {
      guestReceivedSync.push(JSON.parse(event.data.toString()));
    };
  });

  await new Promise(r => setTimeout(r, 50));
  check('host and guest join room successfully', () => {
    assert.ok(guestReceivedSync.some(m => m.type === 'room_state' && m.room === 'ROOM1'));
  });

  // 4. Scenario: Host pauses
  guestReceivedSync = [];
  hostWs.send(JSON.stringify({ type: 'sync', room: 'ROOM1', state: 'paused', timeMs: 45000 }));
  await new Promise(r => setTimeout(r, 50));
  check('host pauses -> guest receives paused sync event', () => {
    const pauseMsg = guestReceivedSync.find(m => m.type === 'sync' && m.state === 'paused');
    assert.ok(pauseMsg);
    assert.equal(pauseMsg.timeMs, 45000);
  });

  // 5. Scenario: Host resumes (play)
  guestReceivedSync = [];
  hostWs.send(JSON.stringify({ type: 'sync', room: 'ROOM1', state: 'playing', timeMs: 45000 }));
  await new Promise(r => setTimeout(r, 50));
  check('host resumes -> guest receives playing sync event', () => {
    const playMsg = guestReceivedSync.find(m => m.type === 'sync' && m.state === 'playing');
    assert.ok(playMsg);
    assert.equal(playMsg.state, 'playing');
  });

  // 6. Scenario: Host seeks
  guestReceivedSync = [];
  hostWs.send(JSON.stringify({ type: 'sync', room: 'ROOM1', state: 'playing', timeMs: 120000 }));
  await new Promise(r => setTimeout(r, 50));
  check('host seeks -> guest receives updated time position', () => {
    const seekMsg = guestReceivedSync.find(m => m.type === 'sync' && m.timeMs === 120000);
    assert.ok(seekMsg);
  });

  // 7. Scenario: Drift Calculation (Desynchronization)
  check('drift detection triggers only beyond threshold', () => {
    assert.equal(NuvioWatchParty.checkDrift(10000, 10500), false); // 500ms diff <= 1500ms
    assert.equal(NuvioWatchParty.checkDrift(10000, 11400), false); // 1400ms diff <= 1500ms
    assert.equal(NuvioWatchParty.checkDrift(10000, 12000), true);  // 2000ms diff > 1500ms
  });

  // 8. Scenario: Host leaves and new leader is elected
  let leaderChanged = false;
  guestWs.onmessage = event => {
    const m = JSON.parse(event.data.toString());
    if (m.type === 'leader_changed') leaderChanged = true;
  };
  hostWs.close();
  await new Promise(r => setTimeout(r, 50));
  check('leader leaves -> new leader elected among remaining participants', () => {
    assert.equal(leaderChanged, true);
  });

  // 9. Scenario: Room cleaned up when all clients leave
  guestWs.close();
  await new Promise(r => setTimeout(r, 50));
  const { rooms } = require('../watchparty/server.js');
  check('room is destroyed when last client leaves', () => {
    assert.equal(rooms.has('ROOM1'), false);
  });

  await new Promise(r => server.close(r));
  process.exitCode = failures ? 1 : 0;
})();
