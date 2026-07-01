const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const { createServerGame } = require("./serverGame");
const { DEFAULTS } = require("./shared");
const matchLogger = require("./matchLogger");
const { createBotClient } = require("./bots/botClient");
const { createTrainingManager } = require("./trainingManager");
const { getLearningLog } = require("./learningLogStore");
const { addManualEntry } = require("./manualLearningStore");

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

let trainingManager = null;

function getGameMode() {
  const raw = String(DEFAULTS.game?.mode || "multiplayer")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");

  if (raw === "singleplayer" || raw === "single") return "singleplayer";
  if (raw === "training" || raw === "train") return "training";
  return "multiplayer";
}

function getSingleplayerDifficulty() {
  const raw = String(DEFAULTS.singleplayer?.difficulty || "easy")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");

  if (raw === "1" || raw === "easy") return "easy";
  if (raw === "2" || raw === "medium") return "medium";
  if (raw === "3" || raw === "hard") return "hard";
  if (raw === "4" || raw === "extreme" || raw === "extremelyhard") return "extreme";
  if (raw === "5" || raw === "machine" || raw === "machinelevelhard") return "machine";

  return "easy";
}

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

    const headers = {
      "Content-Type": contentType,
    };

    if (ext === ".html" || ext === ".js" || ext === ".css") {
      headers["Cache-Control"] =
        "no-store, no-cache, must-revalidate, proxy-revalidate";
      headers["Pragma"] = "no-cache";
      headers["Expires"] = "0";
    }

    res.writeHead(200, headers);
    res.end(content);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

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

        console.log("Defaults updated.");
        console.log("Current mode:", getGameMode());
        console.log("Singleplayer difficulty:", getSingleplayerDifficulty());

        if (trainingManager) {
          if (getGameMode() === "training") {
            trainingManager.ensureRunning("defaults-updated");
          } else {
            trainingManager.stopAll("mode changed away from training");
            latestSpectatorSnapshot = null;
            latestSpectatorMeta = null;
            latestTrainingRoomId = null;
            broadcastSpectatorStatus();
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

  if (pathname === "/api/mode") {
    sendJson(res, 200, {
      mode: getGameMode(),
      rawMode: DEFAULTS.game?.mode,
      singleplayerDifficulty: getSingleplayerDifficulty(),
      rawSingleplayerDifficulty: DEFAULTS.singleplayer?.difficulty,
    });
    return;
  }

  if (pathname === "/api/log/entry" && req.method === "POST") {
    if (!canEditDefaults(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const entry = addManualEntry(body);

      sendJson(res, 200, {
        ok: true,
        entry,
      });
    } catch (err) {
      console.error("Manual learning entry error:", err);

      sendJson(res, 400, {
        ok: false,
        error: "Could not save manual learning entry",
      });
    }

    return;
  }

  if (pathname === "/api/log" || pathname === "/api/learning-log") {
    const limit = Number(url.searchParams.get("limit")) || 100;
    sendJson(res, 200, getLearningLog({ limit }));
    return;
  }

  if (pathname === "/api/spectate") {
    sendJson(res, 200, getSpectatorStatus());
    return;
  }

  if (pathname === "/api/training") {
    if (
      trainingManager &&
      getGameMode() === "training" &&
      DEFAULTS.training?.autoStart
    ) {
      trainingManager.ensureRunning("api-training-status");
    }

    sendJson(
      res,
      200,
      trainingManager
        ? trainingManager.getStatus()
        : { error: "Training manager not ready" }
    );
    return;
  }

  if (pathname === "/api/training/start" && req.method === "POST") {
    if (!canEditDefaults(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    updateDefaults({
      game: {
        mode: "training",
      },
    });

    const status = trainingManager.startTrainingPair("manual-start");
    broadcastSpectatorStatus();

    sendJson(res, 200, status);
    return;
  }

  if (pathname === "/api/training/stop" && req.method === "POST") {
    if (!canEditDefaults(req)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }

    const status = trainingManager.stopAll("manual-stop");

    latestSpectatorSnapshot = null;
    latestSpectatorMeta = null;
    latestTrainingRoomId = null;

    broadcastSpectatorStatus();

    sendJson(res, 200, status);
    return;
  }

  let filePath = null;

  if (pathname === "/") {
    if (getGameMode() === "training") {
      if (trainingManager && DEFAULTS.training?.autoStart) {
        trainingManager.ensureRunning("dashboard-opened");
      }

      filePath = path.join(__dirname, "training.html");
    } else {
      filePath = path.join(__dirname, "index.html");
    }
  } else if (pathname === "/play" || pathname === "/index.html") {
    filePath = path.join(__dirname, "index.html");
  } else if (pathname === "/spectate" || pathname === "/spectate.html") {
    if (
      trainingManager &&
      getGameMode() === "training" &&
      DEFAULTS.training?.autoStart
    ) {
      trainingManager.ensureRunning("spectate-page-opened");
    }

    filePath = path.join(__dirname, "spectate.html");
  } else if (
    pathname === "/Log" ||
    pathname === "/log" ||
    pathname === "/learning-log" ||
    pathname === "/learninglog"
  ) {
    filePath = path.join(__dirname, "log.html");
  } else if (pathname === "/training" || pathname === "/training.html") {
    if (
      trainingManager &&
      getGameMode() === "training" &&
      DEFAULTS.training?.autoStart
    ) {
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

const SPECTATOR_ROOM = "spectators";

let latestSpectatorSnapshot = null;
let latestSpectatorMeta = null;
let latestTrainingRoomId = null;

const queues = {
  multiplayerHumans: [],
  singleplayerHumans: [],
  singleplayerBots: [],
  trainingBots: [],
};

const activeBots = new Map();

function makeRoomId(a, b) {
  return `match_${a}_${b}_${Date.now()}`;
}

function getSpectatorStatus() {
  return {
    mode: getGameMode(),
    hasSnapshot: !!latestSpectatorSnapshot,
    roomId: latestTrainingRoomId,
    meta: latestSpectatorMeta,
    training: trainingManager ? trainingManager.getStatus() : null,
  };
}

function broadcastSpectatorStatus() {
  io.to(SPECTATOR_ROOM).emit("spectatorStatus", getSpectatorStatus());
}

function handleSpectatorConnection(socket) {
  socket.join(SPECTATOR_ROOM);

  if (latestTrainingRoomId) {
    socket.join(latestTrainingRoomId);
  }

  console.log("Spectator connected:", socket.id);

  socket.emit("spectatorStatus", getSpectatorStatus());

  if (latestSpectatorSnapshot) {
    socket.emit("spectatorSnapshot", {
      meta: latestSpectatorMeta,
      snapshot: latestSpectatorSnapshot,
      training: trainingManager ? trainingManager.getStatus() : null,
    });
  }

  if (
    trainingManager &&
    getGameMode() === "training" &&
    DEFAULTS.training?.autoStart
  ) {
    trainingManager.ensureRunning("spectator-connected");
  }
}

function socketMeta(socket) {
  return {
    id: socket.id,
    isBot: !!socket.data.isBot,
    isSpectator: !!socket.data.isSpectator,
    botName: socket.data.botName || null,
    botMode: socket.data.botMode || null,
    profileName: socket.data.profileName || null,
    runId: socket.data.runId || null,
    difficulty: socket.data.difficulty || null,
  };
}

function cleanQueue(name) {
  queues[name] = queues[name].filter((s) => {
    return s && s.connected && !socketToRoom.has(s.id);
  });
}

function removeFromQueues(socketId) {
  for (const key of Object.keys(queues)) {
    queues[key] = queues[key].filter((s) => s.id !== socketId);
  }
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

  const snapshotHz =
    matchType === "training"
      ? Math.max(0.2, Number(DEFAULTS.training?.snapshotLogHz) || 2)
      : 1;

  const snapshotIntervalMs = Math.max(250, Math.floor(1000 / snapshotHz));

  const record = {
    matchId,
    roomId: game.roomId,
    matchType,
    startedAt: Date.now(),
    players,
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

        if (matchType === "training") {
          latestSpectatorSnapshot = snapshot;
        }
      }

      if (game.state?.ended || snapshot?.winner) {
        finishMatchRecord(game.roomId, {
          reason: "ended",
          winnerSocketId: snapshot?.winner || game.state?.winner || null,
          snapshot,
        });
      }
    }, snapshotIntervalMs),
  };

  matchRecords.set(game.roomId, record);

  if (matchType === "training" && trainingManager) {
    latestSpectatorMeta = meta;
    latestSpectatorSnapshot = null;
    latestTrainingRoomId = game.roomId;

    io.in(SPECTATOR_ROOM).socketsJoin(game.roomId);

    trainingManager.onTrainingMatchStarted(meta);
    broadcastSpectatorStatus();
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
    winnerSocketId:
      result.winnerSocketId ||
      snapshot?.winner ||
      record.game.state?.winner ||
      null,
    disconnectedSocketId: result.disconnectedSocketId || null,
    players: record.players,
    finalSnapshot: snapshot,
  };

  matchLogger.endMatch(record.matchId, summary);
  matchRecords.delete(roomId);

  if (summary.matchType === "training" && trainingManager) {
    trainingManager.onTrainingMatchEnded(summary);

    io.in(SPECTATOR_ROOM).socketsLeave(roomId);

    if (latestTrainingRoomId === roomId) {
      latestTrainingRoomId = null;
    }

    broadcastSpectatorStatus();
  }

  if (summary.matchType === "singleplayer" && trainingManager) {
    trainingManager.onSingleplayerMatchEnded(summary);
  }
}

function createMatch(socketA, socketB, matchType) {
  if (!socketA?.connected || !socketB?.connected) return false;
  if (socketToRoom.has(socketA.id) || socketToRoom.has(socketB.id)) return false;

  const roomId = makeRoomId(socketA.id, socketB.id);

  console.log(`Creating ${matchType} match:`, roomId);

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

    if (a && b) {
      createMatch(a, b, "multiplayer");
    }
  }
}

function tryPairSingleplayer() {
  cleanQueue("singleplayerHumans");
  cleanQueue("singleplayerBots");

  while (
    queues.singleplayerHumans.length >= 1 &&
    queues.singleplayerBots.length >= 1
  ) {
    const human = shiftQueue("singleplayerHumans");
    const bot = shiftQueue("singleplayerBots");

    if (human && bot) {
      createMatch(human, bot, "singleplayer");
    }
  }
}

function tryPairTraining() {
  cleanQueue("trainingBots");

  while (queues.trainingBots.length >= 2) {
    const a = shiftQueue("trainingBots");
    const b = shiftQueue("trainingBots");

    if (a && b) {
      createMatch(a, b, "training");
    }
  }
}

function spawnSingleplayerBotForHuman(humanSocketId) {
  const botId = `single_bot_${humanSocketId}_${Date.now()}`;
  const difficulty = getSingleplayerDifficulty();

  console.log("Spawning singleplayer bot:", botId);
  console.log("Singleplayer difficulty:", difficulty);

  const bot = createBotClient({
    serverUrl: `http://127.0.0.1:${PORT}`,
    botName: `Singleplayer Bot (${difficulty})`,
    botMode: "singleplayer",
    profileName: "bot1",
    runId: botId,
    difficulty,
  });

  activeBots.set(botId, bot);

  const cleanup = () => {
    activeBots.delete(botId);
  };

  if (bot.socket) {
    bot.socket.on("disconnect", cleanup);
  }

  setTimeout(() => {
    if (!socketToRoom.has(humanSocketId)) {
      console.log(
        "Singleplayer bot did not pair quickly. Human still waiting:",
        humanSocketId
      );

      tryPairSingleplayer();
    }
  }, 2500);

  return bot;
}

function handleHumanConnection(socket) {
  const mode = getGameMode();

  console.log("Human connected in mode:", mode, socket.id);

  if (mode === "singleplayer") {
    const difficulty = getSingleplayerDifficulty();

    pushQueue("singleplayerHumans", socket);

    socket.emit("queueStatus", {
      message: `Starting singleplayer AI opponent. Difficulty: ${difficulty}`,
    });

    spawnSingleplayerBotForHuman(socket.id);

    setTimeout(() => {
      tryPairSingleplayer();
    }, 250);

    return;
  }

  if (mode === "multiplayer") {
    pushQueue("multiplayerHumans", socket);

    socket.emit("queueStatus", {
      message: "Waiting for opponent...",
    });

    tryPairMultiplayer();

    return;
  }

  if (mode === "training") {
    socket.emit("queueStatus", {
      message:
        "Training mode is active. Open /, /training, or /spectate, or switch mode in /defaults.",
    });

    if (trainingManager && DEFAULTS.training?.autoStart) {
      trainingManager.ensureRunning("human-connected-training-mode");
    }

    return;
  }
}

function handleBotConnection(socket) {
  const botMode = String(socket.data.botMode || "").trim().toLowerCase();

  console.log("Bot connected in mode:", botMode, socket.id);

  if (botMode === "singleplayer") {
    pushQueue("singleplayerBots", socket);

    socket.emit("queueStatus", {
      message: "Singleplayer bot waiting for human...",
    });

    tryPairSingleplayer();

    return;
  }

  if (botMode === "training") {
    pushQueue("trainingBots", socket);

    socket.emit("queueStatus", {
      message: "Training bot waiting for another training bot...",
    });

    tryPairTraining();

    return;
  }

  socket.disconnect(true);
}

io.on("connection", (socket) => {
  socket.data.isSpectator = socket.handshake.query?.spectator === "1";
  socket.data.isBot = socket.handshake.query?.bot === "1";
  socket.data.botName = String(socket.handshake.query?.botName || "");
  socket.data.botMode = String(socket.handshake.query?.botMode || "");
  socket.data.profileName = String(socket.handshake.query?.profileName || "");
  socket.data.runId = String(socket.handshake.query?.runId || "");
  socket.data.difficulty = String(socket.handshake.query?.difficulty || "");

  socket.on("pingCheck", (sentAt) => {
    socket.emit("pongCheck", sentAt);
  });

  if (socket.data.isSpectator) {
    handleSpectatorConnection(socket);
  } else if (socket.data.isBot) {
    handleBotConnection(socket);
  } else {
    handleHumanConnection(socket);
  }

  socket.on("inputUpdate", ({ roomId, input }) => {
    if (socket.data.isSpectator) return;

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
    console.log(
      socket.data.isSpectator
        ? "Spectator disconnected:"
        : socket.data.isBot
          ? "Bot disconnected:"
          : "Player disconnected:",
      socket.id
    );

    if (socket.data.isSpectator) {
      return;
    }

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
  console.log(`Current game mode: ${getGameMode()}`);
  console.log(`Singleplayer difficulty: ${getSingleplayerDifficulty()}`);

  if (getGameMode() === "training" && DEFAULTS.training?.autoStart) {
    trainingManager.ensureRunning("server-started-in-training-mode");
  }
});
