const fs = require("fs");
const path = require("path");
const { DEFAULTS } = require("./shared");
const { createBotClient } = require("./bots/botClient");
const brainStore = require("./bots/botBrainStore");

const STATE_FILE = path.join(__dirname, "trainingState.json");

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadState() {
  const base = {
    date: todayKey(),
    usedMsToday: 0,

    matchesToday: 0,
    singleplayerMatchesToday: 0,

    bot1WinsToday: 0,
    bot2WinsToday: 0,
    drawsToday: 0,

    lastWinner: null,
    lastResult: null,

    currentRunId: null,
    currentRoomId: null,
    currentMatchStartedAt: null,

    lastStatus: "Idle",
  };

  if (!fs.existsSync(STATE_FILE)) return base;

  try {
    return {
      ...base,
      ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")),
    };
  } catch (err) {
    console.error("Could not read trainingState.json:", err);
    return base;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function createTrainingManager({ serverUrl }) {
  let state = loadState();

  let bots = [];
  let trainingStartedAt = null;
  let restartTimer = null;
  let maxMatchTimer = null;
  let intentionallyStopped = false;

  function rolloverIfNeeded() {
    const today = todayKey();

    if (state.date === today) return;

    state = {
      ...state,
      date: today,
      usedMsToday: 0,

      matchesToday: 0,
      singleplayerMatchesToday: 0,

      bot1WinsToday: 0,
      bot2WinsToday: 0,
      drawsToday: 0,

      currentRunId: null,
      currentRoomId: null,
      currentMatchStartedAt: null,

      lastStatus: "New training day",
    };

    saveState(state);
  }

  function limitMs() {
    const minutes = Math.max(
      1,
      Number(DEFAULTS.training?.dailyLimitMinutes) || 30
    );

    return minutes * 60 * 1000;
  }

  function activeElapsedMs() {
    if (!trainingStartedAt) return 0;

    return Date.now() - trainingStartedAt;
  }

  function usedMsToday() {
    rolloverIfNeeded();

    return state.usedMsToday + activeElapsedMs();
  }

  function remainingMsToday() {
    return Math.max(0, limitMs() - usedMsToday());
  }

  function clearTimers() {
    if (restartTimer) clearTimeout(restartTimer);
    if (maxMatchTimer) clearTimeout(maxMatchTimer);

    restartTimer = null;
    maxMatchTimer = null;
  }

  function finalizeTrainingTime() {
    if (!trainingStartedAt) return;

    state.usedMsToday += Date.now() - trainingStartedAt;
    trainingStartedAt = null;

    saveState(state);
  }

  function stopBots(reason = "stopped") {
    for (const bot of bots) {
      try {
        bot.stop(reason);
      } catch (_) {}
    }

    bots = [];
  }

  function stopAll(reason = "stopped") {
    intentionallyStopped = true;

    clearTimers();
    finalizeTrainingTime();
    stopBots(reason);

    state.currentRunId = null;
    state.currentRoomId = null;
    state.currentMatchStartedAt = null;
    state.lastStatus = reason;

    saveState(state);

    return getStatus();
  }

  function canTrain() {
    rolloverIfNeeded();

    if (String(DEFAULTS.game?.mode || "").trim().toLowerCase() !== "training") {
      return false;
    }

    if (!DEFAULTS.training?.enabled) {
      return false;
    }

    if (remainingMsToday() <= 0) {
      return false;
    }

    return true;
  }

  function startTrainingPair(reason = "start") {
    rolloverIfNeeded();

    intentionallyStopped = false;

    if (!canTrain()) {
      stopAll("Cannot train: mode disabled or daily limit reached");
      return getStatus();
    }

    if (bots.length > 0) {
      return getStatus();
    }

    clearTimers();

    const runId = `train_${Date.now()}_${Math.random()
      .toString(16)
      .slice(2)}`;

    trainingStartedAt = Date.now();

    state.currentRunId = runId;
    state.currentRoomId = null;
    state.currentMatchStartedAt = null;
    state.lastStatus = `Training pair started: ${reason}`;

    saveState(state);

    console.log("Starting training pair:", runId);

    bots = [
      createBotClient({
        serverUrl,
        botName: "Training Bot 1",
        botMode: "training",
        profileName: "bot1",
        runId,
      }),

      createBotClient({
        serverUrl,
        botName: "Training Bot 2",
        botMode: "training",
        profileName: "bot2",
        runId,
      }),
    ];

    const maxMatchMs =
      Math.max(15, Number(DEFAULTS.training?.maxMatchSeconds) || 180) * 1000;

    const timeoutMs = Math.min(maxMatchMs, Math.max(1000, remainingMsToday()));

    maxMatchTimer = setTimeout(() => {
      console.log("Training match timed out.");
      state.lastStatus = "Training match timed out";
      saveState(state);

      stopBots("training-match-timeout");

      setTimeout(() => {
        if (!intentionallyStopped) {
          finalizeTrainingTime();
          bots = [];
          scheduleNextIfAllowed();
        }
      }, 500);
    }, timeoutMs);

    return getStatus();
  }

  function ensureRunning(reason = "ensure") {
    rolloverIfNeeded();

    if (!DEFAULTS.training?.autoStart) {
      state.lastStatus = "Training autoStart disabled";
      saveState(state);
      return getStatus();
    }

    if (!canTrain()) {
      return stopAll("Daily training limit reached or training disabled");
    }

    if (bots.length === 0) {
      return startTrainingPair(reason);
    }

    return getStatus();
  }

  function scheduleNextIfAllowed() {
    clearTimers();

    if (intentionallyStopped) return;
    if (!canTrain()) {
      stopAll("Daily training limit reached or training disabled");
      return;
    }

    const delay = Math.max(
      250,
      Number(DEFAULTS.training?.restartDelayMs) || 1500
    );

    state.lastStatus = `Next training match in ${delay}ms`;
    saveState(state);

    restartTimer = setTimeout(() => {
      bots = [];
      startTrainingPair("next match");
    }, delay);
  }

  function onTrainingMatchStarted(meta) {
    state.currentRoomId = meta.roomId;
    state.currentMatchStartedAt = Date.now();
    state.lastStatus = "Training match active";

    saveState(state);
  }

  function onTrainingMatchEnded(summary) {
    if (intentionallyStopped) return;

    clearTimers();
    finalizeTrainingTime();
    stopBots("training-match-ended");

    state.matchesToday += 1;
    state.currentRunId = null;
    state.currentRoomId = null;
    state.currentMatchStartedAt = null;

    const winner = summary.players?.[summary.winnerSocketId] || null;

    state.lastWinner = winner?.botName || null;
    state.lastResult = summary.reason || "ended";

    if (winner?.profileName === "bot1") {
      state.bot1WinsToday += 1;
    } else if (winner?.profileName === "bot2") {
      state.bot2WinsToday += 1;
    } else {
      state.drawsToday += 1;
    }

    try {
      brainStore.recordMatchResult(summary);
    } catch (err) {
      console.error("Could not record training brain result:", err);
    }

    state.lastStatus =
      remainingMsToday() > 0
        ? "Training match ended"
        : "Daily training limit reached";

    saveState(state);

    scheduleNextIfAllowed();
  }

  function onSingleplayerMatchEnded(summary) {
    rolloverIfNeeded();

    state.singleplayerMatchesToday += 1;
    state.lastResult = summary.reason || "singleplayer-ended";

    try {
      brainStore.recordMatchResult(summary);
    } catch (err) {
      console.error("Could not record singleplayer brain result:", err);
    }

    saveState(state);
  }

  function getStatus() {
    rolloverIfNeeded();

    const used = usedMsToday();
    const limit = limitMs();

    let brain = null;

    try {
      brain = brainStore.loadBrain();
    } catch (_) {
      brain = {
        version: "unknown",
        profiles: {},
      };
    }

    return {
      mode: DEFAULTS.game?.mode || "multiplayer",
      trainingEnabled: !!DEFAULTS.training?.enabled,
      autoStart: !!DEFAULTS.training?.autoStart,

      active: bots.length > 0,

      dailyLimitMs: limit,
      usedMsToday: Math.min(used, limit),
      remainingMsToday: Math.max(0, limit - used),
      usedMinutesToday: Math.min(used, limit) / 60000,
      limitMinutes: limit / 60000,

      matchesToday: state.matchesToday,
      singleplayerMatchesToday: state.singleplayerMatchesToday,

      bot1WinsToday: state.bot1WinsToday,
      bot2WinsToday: state.bot2WinsToday,
      drawsToday: state.drawsToday,

      lastWinner: state.lastWinner,
      lastResult: state.lastResult,

      currentRunId: state.currentRunId,
      currentRoomId: state.currentRoomId,
      currentMatchMs: state.currentMatchStartedAt
        ? Date.now() - state.currentMatchStartedAt
        : 0,

      lastStatus: state.lastStatus,

      brainVersion: brain.version,
      profiles: brain.profiles,
    };
  }

  return {
    ensureRunning,
    startTrainingPair,
    stopAll,

    onTrainingMatchStarted,
    onTrainingMatchEnded,
    onSingleplayerMatchEnded,

    getStatus,
  };
}

module.exports = {
  createTrainingManager,
};
