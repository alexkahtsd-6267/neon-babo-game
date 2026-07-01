const { io } = require("socket.io-client");
const { DEFAULTS } = require("../shared");
const brainStore = require("./botBrainStore");
const simpleBrain = require("./simpleBotBrain");
const { applyDifficulty, normalizeDifficulty } = require("./difficultyProfiles");

function createBotClient({
  serverUrl,
  botName = "AI Bot",
  botMode = "singleplayer",
  profileName = "bot1",
  runId = "manual",
  difficulty = null,
}) {
  const baseProfile = brainStore.getProfile(profileName);

  const difficultyValue =
    difficulty ||
    DEFAULTS.singleplayer?.difficulty ||
    "easy";

  const profile =
    botMode === "singleplayer"
      ? applyDifficulty(baseProfile, difficultyValue)
      : baseProfile;

  const memory = simpleBrain.makeMemory();

  const socket = io(serverUrl, {
    reconnection: false,
    transports: ["websocket", "polling"],
    query: {
      bot: "1",
      botName,
      botMode,
      profileName,
      runId,
      difficulty: normalizeDifficulty(difficultyValue),
    },
  });

  const state = {
    roomId: null,
    mySocketId: null,
    enemySocketId: null,
    snapshot: null,
    stopped: false,
  };

  function findEnemyId(snapshot) {
    if (!snapshot?.players || !state.mySocketId) return null;

    return Object.keys(snapshot.players).find((id) => id !== state.mySocketId) || null;
  }

  socket.on("connect", () => {
    state.mySocketId = socket.id;
    console.log(
      `${botName} connected: ${socket.id}`,
      botMode === "singleplayer" ? `difficulty=${profile.difficultyLabel}` : ""
    );
  });

  socket.on("matchFound", (data) => {
    state.roomId = data.roomId;
    state.mySocketId = data.you?.id || socket.id;
    state.enemySocketId = data.enemy?.id || null;

    console.log(`${botName} matched in ${state.roomId}`);
  });

  socket.on("worldSnapshot", (snapshot) => {
    state.snapshot = snapshot;
    state.enemySocketId = findEnemyId(snapshot);
  });

  socket.on("matchEnded", () => {
    stop("match-ended");
  });

  socket.on("opponentLeft", () => {
    stop("opponent-left");
  });

  socket.on("disconnect", () => {
    state.stopped = true;
  });

  const inputTimer = setInterval(() => {
    if (state.stopped) return;
    if (!state.roomId || !state.snapshot || !state.mySocketId || !state.enemySocketId) return;

    const input = simpleBrain.decide(
      state.snapshot,
      state.mySocketId,
      state.enemySocketId,
      profile,
      memory
    );

    socket.emit("inputUpdate", {
      roomId: state.roomId,
      input,
    });
  }, 1000 / 30);

  function stop(reason = "stopped") {
    if (state.stopped) return;

    state.stopped = true;
    clearInterval(inputTimer);

    try {
      socket.disconnect();
    } catch (_) {}

    console.log(`${botName} stopped: ${reason}`);
  }

  return {
    socket,
    state,
    stop,
    botName,
    botMode,
    profileName,
    runId,
    difficulty: profile.difficulty || null,
  };
}

module.exports = {
  createBotClient,
};
