const fs = require("fs");
const path = require("path");

const BRAIN_FILE = path.join(__dirname, "botBrain.json");

const DEFAULT_BRAIN = {
  version: "simple-learning-v2",
  profiles: {
    bot1: {
      aggression: 0.82,
      idealDistance: 520,
      strafeAmount: 0.65,
      grenadeChance: 0.04,
      sniperChance: 0.03,
      ballChance: 0.08,
      blockChance: 0.42,
      dashWhenHpBelow: 0.45,
      retreatWhenHpBelow: 0.28,
      rate: 15,
      speed: 1500,
      dpsMult: 1,
    },

    bot2: {
      aggression: 0.82,
      idealDistance: 520,
      strafeAmount: 0.65,
      grenadeChance: 0.04,
      sniperChance: 0.03,
      ballChance: 0.08,
      blockChance: 0.42,
      dashWhenHpBelow: 0.45,
      retreatWhenHpBelow: 0.28,
      rate: 15,
      speed: 1500,
      dpsMult: 1,
    },
  },
  history: [],
};

const LIMITS = {
  aggression: [0.2, 1],
  idealDistance: [220, 1000],
  strafeAmount: [0, 1.4],
  grenadeChance: [0, 0.22],
  sniperChance: [0, 0.18],
  ballChance: [0, 0.28],
  blockChance: [0, 0.9],
  dashWhenHpBelow: [0.08, 0.9],
  retreatWhenHpBelow: [0.05, 0.65],
  rate: [5, 28],
  speed: [700, 2200],
  dpsMult: [1, 1.2],
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundValue(value) {
  if (Math.abs(value) >= 100) return Math.round(value);
  return Math.round(value * 1000) / 1000;
}

function loadBrain() {
  if (!fs.existsSync(BRAIN_FILE)) {
    const fresh = deepClone(DEFAULT_BRAIN);
    saveBrain(fresh);
    return fresh;
  }

  try {
    const loaded = JSON.parse(fs.readFileSync(BRAIN_FILE, "utf8"));

    const brain = {
      ...deepClone(DEFAULT_BRAIN),
      ...loaded,
      profiles: {
        ...deepClone(DEFAULT_BRAIN.profiles),
        ...(loaded.profiles || {}),
      },
      history: Array.isArray(loaded.history) ? loaded.history : [],
    };

    for (const profileName of ["bot1", "bot2"]) {
      brain.profiles[profileName] = {
        ...deepClone(DEFAULT_BRAIN.profiles[profileName]),
        ...(brain.profiles[profileName] || {}),
      };
    }

    return brain;
  } catch (err) {
    console.error("Could not load bot brain:", err);
    const fresh = deepClone(DEFAULT_BRAIN);
    saveBrain(fresh);
    return fresh;
  }
}

function saveBrain(brain) {
  fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
}

function getProfile(profileName = "bot1") {
  const brain = loadBrain();
  const safeName = brain.profiles[profileName] ? profileName : "bot1";

  return deepClone(brain.profiles[safeName]);
}

function mutateNumber(field, value, strength) {
  const [min, max] = LIMITS[field] || [0, 1];
  const range = max - min;
  const delta = (Math.random() * 2 - 1) * range * strength;
  return roundValue(clamp(Number(value) + delta, min, max));
}

function mutateProfile(profile, strength = 0.055) {
  const before = deepClone(profile);
  const after = deepClone(profile);
  const changes = [];

  for (const field of Object.keys(LIMITS)) {
    if (!(field in after)) continue;

    const chance = field === "rate" || field === "speed" ? 0.35 : 0.55;
    if (Math.random() > chance) continue;

    const oldValue = Number(after[field]);
    const newValue = mutateNumber(field, oldValue, strength);

    if (newValue !== oldValue) {
      after[field] = newValue;

      changes.push({
        field,
        before: oldValue,
        after: newValue,
        delta: roundValue(newValue - oldValue),
      });
    }
  }

  return {
    before,
    after,
    changes,
  };
}

function getWinnerInfo(summary) {
  const players = summary.players || {};
  const winnerSocketId = summary.winnerSocketId || null;
  const winner = winnerSocketId ? players[winnerSocketId] : null;

  return {
    winnerSocketId,
    winner,
    winnerProfile: winner?.profileName || null,
    winnerBotName: winner?.botName || null,
  };
}

function getBotProfilesInMatch(summary) {
  const players = Object.values(summary.players || {});

  return players
    .filter((p) => p && p.isBot && p.profileName)
    .map((p) => p.profileName)
    .filter((name, index, arr) => arr.indexOf(name) === index);
}

function chooseProfilesToMutate(summary) {
  const matchType = summary.matchType || "unknown";
  const { winnerProfile } = getWinnerInfo(summary);
  const botProfiles = getBotProfilesInMatch(summary);

  if (matchType === "training") {
    if (winnerProfile === "bot1") return ["bot2"];
    if (winnerProfile === "bot2") return ["bot1"];

    return botProfiles.length ? botProfiles : ["bot1", "bot2"];
  }

  if (matchType === "singleplayer") {
    const botProfile = botProfiles[0] || "bot1";

    if (winnerProfile === botProfile) {
      return [];
    }

    return [botProfile];
  }

  return [];
}

function recordMatchResult(summary = {}) {
  const brain = loadBrain();

  const {
    winnerSocketId,
    winner,
    winnerProfile,
    winnerBotName,
  } = getWinnerInfo(summary);

  const profilesToMutate = chooseProfilesToMutate(summary);
  const mutatedProfiles = [];

  for (const profileName of profilesToMutate) {
    if (!brain.profiles[profileName]) continue;

    const mutation = mutateProfile(brain.profiles[profileName], 0.055);

    brain.profiles[profileName] = mutation.after;

    mutatedProfiles.push({
      profileName,
      reason: winnerProfile
        ? `${profileName} lost against ${winnerProfile}`
        : "draw / timeout / unknown result",
      changes: mutation.changes,
      before: mutation.before,
      after: mutation.after,
    });
  }

  const historyEntry = {
    timestamp: new Date().toISOString(),

    matchId: summary.matchId || null,
    roomId: summary.roomId || null,
    matchType: summary.matchType || "unknown",
    reason: summary.reason || "ended",
    durationMs: summary.durationMs || 0,

    winnerSocketId,
    winnerProfile,
    winnerBotName,
    winner,

    mutatedProfiles,

    summary: {
      matchId: summary.matchId || null,
      roomId: summary.roomId || null,
      matchType: summary.matchType || null,
      reason: summary.reason || null,
      durationMs: summary.durationMs || 0,
      winnerSocketId: summary.winnerSocketId || null,
      disconnectedSocketId: summary.disconnectedSocketId || null,
    },
  };

  brain.history.push(historyEntry);
  brain.history = brain.history.slice(-500);

  saveBrain(brain);

  console.log(
    "Learning recorded:",
    historyEntry.matchType,
    historyEntry.reason,
    "winner:",
    winnerProfile || "draw/unknown",
    "mutations:",
    mutatedProfiles.length
  );

  return historyEntry;
}

module.exports = {
  loadBrain,
  saveBrain,
  getProfile,
  mutateProfile,
  recordMatchResult,
};
