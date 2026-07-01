const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const { createServerGame } = require("./serverGame");
const { DEFAULTS } = require("./shared");
const matchLogger = require("./matchLogger");
const { createTrainingManager } = require("./trainingManager");

const {
  loadSavedDefaults,
  getDefaults,
  updateDefaults,
} = require("./defaultsStore");

loadSavedDefaults();

const PORT = process.env.PORT || 3000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) {
      console.error("Read error:", err);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Server error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });

    req.on("error", reject);
  });
}

function canEditDefaults(req) {
  const adminKey = process.env.DEFAULTS_ADMIN_KEY;

  if (!adminKey) return true;

  return req.headers["x-admin-key"] === adminKey;
}

let trainingManager = null;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/api/defaults") {
    if (req.method === "GET") {
      sendJson(res, 200, getDefaults());
      return;
    }

    if (req.method === "POST") {
      if (!canEditDefaults(req)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }

      try {
        const body = await readJsonBody(req);
        const updated = updateDefaults(body);

        if (trainingManager) {
          if (DEFAULTS.game.mode === "training") {
            trainingManager.ensureRunning("defaults-updated");
          } else {
            trainingManager.stopAll("mode changed away from training");
          }
        }

        sendJson(res, 200, updated);
      } catch (err) {
        console.error("Defaults update error:", err);
        sendJson(res, 400, { error: "Invalid defaults payload" });
      }

      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (pathname === "/api/training") {
    if (trainingManager && DEFAULTS.game.mode === "training" && DEFAULTS.training.autoStart) {
      trainingManager.ensureRunning("api-status");
    }

    sendJson(
      res,
      200,
      trainingManager ? trainingManager.getStatus() : { error: "Training manager not ready" }
    );
    return;
  }

  if (pathname === "/api/training/start" && req.method === "POST") {
    if (!canEditDefaults(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    if (DEFAULTS.game.mode !== "training") {
      DEFAULTS.game.mode = "training";
    }

    sendJson(res, 200, trainingManager.startTrainingPair("manual-start"));
    return;
  }

  if (pathname === "/api/training/stop" && req.method === "POST") {
    if (!canEditDefaults(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    sendJson(res, 200, trainingManager.stopAll("manual-stop"));
    return;
  }

  let filePath = null;

  if (pathname === "/") {
    if (DEFAULTS.game.mode === "training") {
      if (trainingManager && DEFAULTS.training.autoStart) {
        trainingManager.ensureRunning("dashboard-opened");
      }

      filePath = path.join(__dirname, "training.html");
    } else {
      filePath = path.join(__dirname, "index.html");
    }
  } else if (pathname === "/play" || pathname === "/index.html") {
    filePath = path.join(__dirname, "index.html");
  } else if (pathname === "/training" || pathname === "/training.html") {
    if (trainingManager && DEFAULTS.game.mode === "training" && DEFAULTS.training.autoStart) {
      trainingManager.ensureRunning("training-page-opened");
    }

    filePath = path.join(__dirname, "training.html");
  } else if (pathname === "/defaults" || pathname === "/defaults.html") {
    filePath = path.join(__dirname, "defaults.html");
  } else if (pathname === "/clientNet.js") {
    filePath = path.join(__dirname, "clientNet.js");
  } else if (pathname === "/shared.js") {
    filePath = path.join(__dirname, "shared.js");
  }

  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  serveFile(res, filePath);
});

const io = new Server(server, {
  cors: { origin: "*" },
});

trainingManager = createTrainingManager({
  serverUrl: `http://127.0.0.1:${PORT}`,
});

const matches = new Map();
const socketToRoom = new Map();
const matchRecords = new Map();

const queues = {
  multiplayerHumans: [],
  singleplayerHumans: [],
  singleplayerBots: [],
  trainingBots: [],
};

function socketMeta(socket) {
  return {
    id: socket.id,
    isBot: socket.data.isBot,
    botName: socket.data.botName || null,
    botMode: socket.data.botMode || null,
    profileName: socket.data.profileName || null,
    runId: socket.data.runId || null,
  };
}

function cleanQueue(name) {
  queues[name] = queues[name].filter((s) => s && s.connected && !socketToRoom.has(s.id));
}

function pushQueue(name, socket) {
  cleanQueue(name);

  if (!queues[name].some((s) => s.id === socket.id)) {
    queues[name].push(socket);
  }
}

function shiftQueue(name) {
  cleanQueue(name);
  return queues[name].shift() || null;
}

function removeFromQueues(socketId) {
  for (const key of Object.keys(queues)) {
    queues[key] = queues[key].filter((s) => s.id !== socketId);
  }
}

function makeRoomId(a, b) {
  return `match_${a}_${b}_${Date.now()}`;
}

function startMatchRecord(game, matchType, socketA, socketB) {
  const matchId = `log_${Date.now()}_${game.roomId}`;

  const players = {
    [socketA.id]: socketMeta(socketA),
    [socketB.id]: socketMeta(socketB),
  };

  const meta = {
    matchId,
    roomId: game.roomId,
    matchType,
    startedAt: Date.now(),
    players,
  };

  matchLogger.startMatch(matchId, meta);

  const hz = Math.max(0.2, Number(DEFAULTS.training.snapshotLogHz) || 2);
  const intervalMs = Math.floor(1000 / hz);

  const record = {
    ...meta,
    game,
    finished: false,
    snapshotInterval: setInterval(() => {
      if (record.finished) return;

      let snapshot = null;

      try {
        snapshot = game.getSnapshot();
      } catch (err) {
        console.error("Snapshot logging error:", err);
      }

      if (snapshot) {
        matchLogger.logEvent(matchId, "world.snapshot", snapshot);
      }

      if (game.state?.ended || snapshot?.winner) {
        finishMatchRecord(game.roomId, {
          reason: "ended",
          winnerSocketId: snapshot?.winner || game.state?.winner || null,
          snapshot,
        });
      }
    }, intervalMs),
  };

  matchRecords.set(game.roomId, record);

  if (matchType === "training") {
    trainingManager.onTrainingMatchStarted(meta);
  }
}

function finishMatchRecord(roomId, result = {}) {
  const record = matchRecords.get(roomId);

  if (!record || record.finished) return;

  record.finished = true;
  clearInterval(record.snapshotInterval);

  let snapshot = result.snapshot || null;

  try {
    snapshot = snapshot || record.game.getSnapshot();
  } catch (_) {}

  const summary = {
    matchId: record.matchId,
    roomId,
    matchType: record.matchType,
    startedAt: record.startedAt,
    endedAt: Date.now(),
    durationMs: Date.now() - record.startedAt,
    reason: result.reason || "ended",
    winnerSocketId: result.winnerSocketId || snapshot?.winner || record.game.state?.winner || null,
    disconnectedSocketId: result.disconnectedSocketId || null,
    players: record.players,
    finalSnapshot: snapshot,
  };

  matchLogger.endMatch(record.matchId, summary);
  matchRecords.delete(roomId);

  if (record.matchType === "training") {
    trainingManager.onTrainingMatchEnded(summary);
  } else if (record.matchType === "singleplayer") {
    trainingManager.onSingleplayerMatchEnded(summary);
  }
}

function createMatch(socketA, socketB, matchType) {
  if (!socketA?.connected || !socketB?.connected) return false;
  if (socketToRoom.has(socketA.id) || socketToRoom.has(socketB.id)) return false;

  const roomId = makeRoomId(socketA.id, socketB.id);

  socketA.join(roomId);
  socketB.join(roomId);

  const game = createServerGame(io, roomId, socketA.id, socketB.id);

  matches.set(roomId, game);
  socketToRoom.set(socketA.id, roomId);
  socketToRoom.set(socketB.id, roomId);

  startMatchRecord(game, matchType, socketA, socketB);

  socketA.emit("matchFound", game.getMatchFoundPayload(socketA.id));
  socketB.emit("matchFound", game.getMatchFoundPayload(socketB.id));

  game.start();

  return true;
}

function tryPairMultiplayer() {
  cleanQueue("multiplayerHumans");

  while (queues.multiplayerHumans.length >= 2) {
    const a = shiftQueue("multiplayerHumans");
    const b = shiftQueue("multiplayerHumans");

    if (a && b) createMatch(a, b, "multiplayer");
  }
}

function tryPairSingleplayer() {
  cleanQueue("singleplayerHumans");
  cleanQueue("singleplayerBots");

  while (queues.singleplayerHumans.length >= 1 && queues.singleplayerBots.length >= 1) {
    const human = shiftQueue("singleplayerHumans");
    const bot = shiftQueue("singleplayerBots");

    if (human && bot) createMatch(human, bot, "singleplayer");
  }
}

function tryPairTraining() {
  cleanQueue("trainingBots");

  while (queues.trainingBots.length >= 2) {
    const a = shiftQueue("trainingBots");
    const b = shiftQueue("trainingBots");

    if (a && b) createMatch(a, b, "training");
  }
}

function handleHumanConnection(socket) {
  const mode = DEFAULTS.game.mode;

  if (mode === "multiplayer") {
    pushQueue("multiplayerHumans", socket);
    socket.emit("queueStatus", { message: "Waiting for opponent..." });
    tryPairMultiplayer();
    return;
  }

  if (mode === "singleplayer") {
    pushQueue("singleplayerHumans", socket);
    socket.emit("queueStatus", { message: "Starting AI opponent..." });
    tryPairSingleplayer();

    if (!socketToRoom.has(socket.id)) {
      trainingManager.spawnSingleplayerBot();
    }

    return;
  }

  if (mode === "training") {
    socket.emit("queueStatus", {
      message:
        "Training mode is active. Open / or /training for the dashboard, or switch mode to multiplayer/singleplayer in /defaults.",
    });

    if (DEFAULTS.training.autoStart) {
      trainingManager.ensureRunning("human-connected-training-mode");
    }
  }
}

function handleBotConnection(socket) {
  const botMode = socket.data.botMode;

  if (botMode === "singleplayer") {
    pushQueue("singleplayerBots", socket);
    tryPairSingleplayer();
    return;
  }

  if (botMode === "training") {
    pushQueue("trainingBots", socket);
    tryPairTraining();
    return;
  }

  socket.disconnect(true);
}

io.on("connection", (socket) => {
  socket.data.isBot = socket.handshake.query?.bot === "1";
  socket.data.botName = String(socket.handshake.query?.botName || "");
  socket.data.botMode = String(socket.handshake.query?.botMode || "");
  socket.data.profileName = String(socket.handshake.query?.profileName || "");
  socket.data.runId = String(socket.handshake.query?.runId || "");

  console.log(
    socket.data.isBot ? "Bot connected:" : "Player connected:",
    socket.id,
    socket.data.botName || ""
  );

  socket.on("pingCheck", (sentAt) => {
    socket.emit("pongCheck", sentAt);
  });

  if (socket.data.isBot) {
    handleBotConnection(socket);
  } else {
    handleHumanConnection(socket);
  }

  socket.on("inputUpdate", ({ roomId, input }) => {
    const knownRoomId = socketToRoom.get(socket.id);

    if (!knownRoomId) return;
    if (roomId !== knownRoomId) return;

    const game = matches.get(knownRoomId);

    if (!game) return;

    const record = matchRecords.get(knownRoomId);

    if (record) {
      matchLogger.logEvent(record.matchId, "input.update", {
        socketId: socket.id,
        isBot: !!socket.data.isBot,
        input: input || {},
      });
    }

    game.setInput(socket.id, input || {});
  });

  socket.on("disconnect", () => {
    console.log(socket.data.isBot ? "Bot disconnected:" : "Player disconnected:", socket.id);

    removeFromQueues(socket.id);

    const roomId = socketToRoom.get(socket.id);

    if (roomId) {
      const game = matches.get(roomId);

      if (game) {
        finishMatchRecord(roomId, {
          reason: "disconnect",
          disconnectedSocketId: socket.id,
          winnerSocketId: null,
        });

        game.onDisconnect(socket.id);
        game.stop();
        matches.delete(roomId);
      }

      for (const [otherSocketId, otherRoomId] of socketToRoom.entries()) {
        if (otherRoomId === roomId) {
          socketToRoom.delete(otherSocketId);
        }
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
