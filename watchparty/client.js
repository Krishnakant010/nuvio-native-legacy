// Independent, decoupled JavaScript client for Nuvio Watch Party.
// Runs seamlessly on Tizen TV (Chromium), web browsers, Electron, and mobile.
// HARD SAFETY GUARANTEE: Server outage or connection drop NEVER stops or
// interrupts local video playback in Nuvio.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.NuvioWatchParty = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ws = null;
  var status = 'disconnected'; // 'connected' | 'connecting' | 'disconnected' | 'offline'
  var currentRoom = '';
  var currentLeader = false;
  var driftThresholdMs = 1500; // Desynchronization correction threshold
  var reconnectAttempts = 0;
  var maxReconnectAttempts = 3;
  var reconnectTimer = null;
  var heartbeatTimer = null;
  var listeners = {
    status: [],
    sync: [],
    participants: []
  };

  function emit(event, data) {
    var list = listeners[event] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) {}
    }
  }

  function setStatus(s) {
    status = s;
    emit('status', s);
  }

  function connect(serverUrl, roomCode, userName, isHost) {
    disconnect();
    if (!serverUrl || !roomCode) {
      setStatus('offline');
      return;
    }

    currentRoom = (roomCode || '').toUpperCase().trim();
    currentLeader = !!isHost;
    setStatus('connecting');

    try {
      var WebSocketImpl = (typeof WebSocket !== 'undefined') ? WebSocket : null;
      if (!WebSocketImpl && typeof window !== 'undefined' && window.WebSocket) {
        WebSocketImpl = window.WebSocket;
      }
      if (!WebSocketImpl) {
        setStatus('offline');
        return;
      }

      ws = new WebSocketImpl(serverUrl);

      ws.onopen = function () {
        setStatus('connected');
        reconnectAttempts = 0;
        // Send room join message
        ws.send(JSON.stringify({
          type: 'join',
          room: currentRoom,
          userName: userName || 'Viewer',
          isLeader: currentLeader
        }));

        // Start heartbeat if room leader
        if (currentLeader) {
          startHeartbeat();
        }
      };

      ws.onmessage = function (event) {
        try {
          var msg = JSON.parse(event.data);
          handleMessage(msg);
        } catch (e) {}
      };

      ws.onclose = function () {
        stopHeartbeat();
        ws = null;
        if (status !== 'disconnected') {
          setStatus('offline');
          // Attempt automatic reconnection if drop was unintentional
          if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            reconnectTimer = setTimeout(function () {
              connect(serverUrl, roomCode, userName, currentLeader);
            }, 3000);
          }
        }
      };

      ws.onerror = function () {
        setStatus('offline');
      };
    } catch (e) {
      setStatus('offline');
    }
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'room_state':
        if (typeof msg.isLeader === 'boolean') currentLeader = msg.isLeader;
        emit('participants', msg.participants || 1);
        if (!currentLeader) {
          emit('sync', {
            state: msg.state,
            timeMs: msg.timeMs,
            mediaId: msg.mediaId,
            initial: true
          });
        }
        break;

      case 'user_joined':
      case 'user_left':
        emit('participants', msg.participants || 1);
        break;

      case 'leader_changed':
        if (msg.leaderId) {
          emit('status', 'leader_changed');
        }
        break;

      case 'sync':
        if (!currentLeader) {
          emit('sync', {
            state: msg.state,
            timeMs: msg.timeMs,
            mediaId: msg.mediaId,
            epoch: msg.epoch
          });
        }
        break;

      case 'heartbeat':
        if (!currentLeader) {
          emit('sync', {
            state: msg.state,
            timeMs: msg.timeMs,
            driftOnly: true
          });
        }
        break;
    }
  }

  function sendSync(state, timeMs, mediaId) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify({
        type: 'sync',
        room: currentRoom,
        state: state,
        timeMs: Math.round(timeMs || 0),
        mediaId: mediaId || ''
      }));
    } catch (e) {}
  }

  function sendHeartbeat(state, timeMs) {
    if (!ws || ws.readyState !== 1 || !currentLeader) return;
    try {
      ws.send(JSON.stringify({
        type: 'heartbeat',
        room: currentRoom,
        state: state,
        timeMs: Math.round(timeMs || 0)
      }));
    } catch (e) {}
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (typeof window !== 'undefined' && window.__nvav && currentLeader) {
        var posMs = window.__nvav.posMs || 0;
        var estado = window.__nvav.tocando ? 'playing' : 'paused';
        sendHeartbeat(estado, posMs);
      }
    }, 4000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function disconnect() {
    stopHeartbeat();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try { ws.close(); } catch (e) {}
      ws = null;
    }
    currentRoom = '';
    currentLeader = false;
    reconnectAttempts = 0;
    setStatus('disconnected');
  }

  return {
    connect: connect,
    disconnect: disconnect,
    sendSync: sendSync,
    getStatus: function () { return status; },
    isLeader: function () { return currentLeader; },
    getRoom: function () { return currentRoom; },
    on: function (event, cb) {
      if (listeners[event]) listeners[event].push(cb);
    },
    off: function (event, cb) {
      if (listeners[event]) {
        var idx = listeners[event].indexOf(cb);
        if (idx !== -1) listeners[event].splice(idx, 1);
      }
    },
    checkDrift: function (localTimeMs, remoteTimeMs) {
      var diff = Math.abs(localTimeMs - remoteTimeMs);
      return diff > driftThresholdMs;
    }
  };
});
