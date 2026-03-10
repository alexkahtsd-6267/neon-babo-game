(function () {
  "use strict";

  const socket = io();

  const netState = {
    socket,
    roomId: null,
    mySocketId: null,
    enemySocketId: null,
    snapshot: null,
    pingMs: null,
    connected: false,
  };

  const listeners = {
    queueStatus: [],
    matchFound: [],
    worldSnapshot: [],
    opponentLeft: [],
    matchEnded: [],
    ping: [],
    connect: [],
    disconnect: [],
  };

  function emitToListeners(name, payload) {
    if (!listeners[name]) return;
    for (const fn of listeners[name]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`clientNet listener error for ${name}:`, err);
      }
    }
  }

  function on(name, fn) {
    if (!listeners[name]) throw new Error(`Unknown clientNet event: ${name}`);
    listeners[name].push(fn);
    return () => {
      const idx = listeners[name].indexOf(fn);
      if (idx >= 0) listeners[name].splice(idx, 1);
    };
  }

  socket.on("connect", () => {
    netState.connected = true;
    netState.mySocketId = socket.id;
    emitToListeners("connect", { socketId: socket.id });
  });

  socket.on("disconnect", () => {
    netState.connected = false;
    netState.snapshot = null;
    netState.enemySocketId = null;
    emitToListeners("disconnect", {});
  });

  socket.on("queueStatus", (data) => {
    emitToListeners("queueStatus", data);
  });

  socket.on("matchFound", (data) => {
    netState.roomId = data.roomId || null;
    netState.snapshot = null;

    if (data?.you?.id) netState.mySocketId = data.you.id;
    if (data?.enemy?.id) netState.enemySocketId = data.enemy.id;

    emitToListeners("matchFound", data);
  });

  socket.on("worldSnapshot", (snapshot) => {
    netState.snapshot = snapshot || null;

    if (snapshot?.players) {
      const ids = Object.keys(snapshot.players);
      if (!netState.mySocketId && socket.id && snapshot.players[socket.id]) {
        netState.mySocketId = socket.id;
      }
      if (netState.mySocketId) {
        netState.enemySocketId = ids.find((id) => id !== netState.mySocketId) || null;
      }
    }

    emitToListeners("worldSnapshot", snapshot);
  });

  socket.on("opponentLeft", () => {
    emitToListeners("opponentLeft", {});
  });

  socket.on("matchEnded", (data) => {
    emitToListeners("matchEnded", data);
  });

  socket.on("pongCheck", (sentAt) => {
    const ping = Date.now() - sentAt;
    netState.pingMs = ping;
    emitToListeners("ping", { ping });
  });

  function sendPingCheck() {
    socket.emit("pingCheck", Date.now());
  }

  function startPingLoop(intervalMs = 1000) {
    sendPingCheck();
    return setInterval(sendPingCheck, intervalMs);
  }

  function getMyPlayerFromSnapshot() {
    if (!netState.snapshot || !netState.snapshot.players || !netState.mySocketId) {
      return null;
    }
    return netState.snapshot.players[netState.mySocketId] || null;
  }

  function getEnemyPlayerFromSnapshot() {
    if (!netState.snapshot || !netState.snapshot.players) return null;

    if (netState.enemySocketId) {
      return netState.snapshot.players[netState.enemySocketId] || null;
    }

    const ids = Object.keys(netState.snapshot.players);
    const enemyId = ids.find((id) => id !== netState.mySocketId);
    return enemyId ? netState.snapshot.players[enemyId] : null;
  }

  function sendInput(inputState) {
    if (!netState.roomId) return;
    socket.emit("inputUpdate", {
      roomId: netState.roomId,
      input: inputState,
    });
  }

  function getState() {
    return {
      roomId: netState.roomId,
      mySocketId: netState.mySocketId,
      enemySocketId: netState.enemySocketId,
      snapshot: netState.snapshot,
      pingMs: netState.pingMs,
      connected: netState.connected,
    };
  }

  window.clientNet = {
    on,
    sendInput,
    sendPingCheck,
    startPingLoop,
    getState,
    getMyPlayerFromSnapshot,
    getEnemyPlayerFromSnapshot,
  };
})();
