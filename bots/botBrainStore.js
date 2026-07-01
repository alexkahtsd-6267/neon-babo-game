const fs = require("fs");
const path = require("path");

const BRAIN_FILE = path.join(__dirname, "botBrain.json");

const DEFAULT_BRAIN = {
  version: "simple-v1",

  profiles: {
    bot1: {
      aggression: 0.78,
      idealDistance: 520,
      strafeAmount: 0.65,
      grenadeChance: 0.08,
      sniperChance: 0.05,
      ballChance: 0.12,
      blockChance: 0.35,
      dashWhenHpBelow: 0.38,
      retreatWhenHpBelow: 0.28,
      rate: 15,
      speed: 1500,
      dpsMult: 1,
    },

    bot2: {
      aggression: 0.70,
      idealDistance: 620,
      strafeAmount: 0.80,
      grenadeChance: 0.12,
      sniperChance: 0.04,
      ballChance: 0.10,
      blockChance: 0.42,
      dashWhenHpBelow: 0.45,
      retreatWhenHpBelow: 0.32,
      rate: 15,
      speed: 1500,
      dpsMult: 1,
    },
  },

  history: [],
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function loadBrain() {
  if (!fs.existsSync(BRAIN_FILE)) {
    saveBrain(DEFAULT_BRAIN);
    return clone(DEFAULT_BRAIN);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(BRAIN_FILE, "utf8"));

    return {
      ...clone(DEFAULT_BRAIN),
      ...parsed,
      profiles: {
        ...clone(DEFAULT_BRAIN.profiles),
        ...(parsed.profiles || {}),
      },
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch (err) {
    console.error("Could not read botBrain.json:", err);
    return clone(DEFAULT_BRAIN);
  }
}

function saveBrain(brain) {
  fs.writeFileSync(BRAIN_FILE, JSON.stringify(brain, null, 2));
}

function getProfile(profileName = "bot1") {
  const brain = loadBrain();

  return clone(brain.profiles[profileName] || brain.profiles.bot1);
}

function mutateProfile(profile) {
  const next = clone(profile);

  const jitter = (amount) => (Math.random() * 2 - 1) * amount;

  next.aggression = clamp(next.aggression + jitter(0.08), 0.1, 1.0);
  next.idealDistance = clamp(next.idealDistance + jitter(120), 180, 1100);
  next.strafeAmount = clamp(next.strafeAmount + jitter(0.12), 0, 1);
  next.grenadeChance = clamp(next.grenadeChance + jitter(0.04), 0, 0.35);
  next.sniperChance = clamp(next.sniperChance + jitter(0.03), 0, 0.25);
  next.ballChance = clamp(next.ballChance + jitter(0.05), 0, 0.45);
  next.blockChance = clamp(next.blockChance + jitter(0.08), 0, 0.9);
  next.dashWhenHpBelow = clamp(next.dashWhenHpBelow + jitter(0.08), 0.1, 0.9);
  next.retreatWhenHpBelow = clamp(next.retreatWhenHpBelow + jitter(0.08), 0.05, 0.85);

  return next;
}

function recordMatchResult(summary) {
  const brain = loadBrain();
  const players = summary.players || {};
  const winnerSocketId = summary.winnerSocketId || null;

  const botPlayers = Object.values(players).filter(
    (p) => p && p.isBot && p.profileName
  );

  const winner = winnerSocketId ? players[winnerSocketId] : null;

  for (const bot of botPlayers) {
    const botLost = winner && winner.id !== bot.id;
    const noWinner = !winner;

    if (botLost || noWinner) {
      const oldProfile = brain.profiles[bot.profileName] || brain.profiles.bot1;
      brain.profiles[bot.profileName] = mutateProfile(oldProfile);
    }
  }

  brain.history.push({
    t: Date.now(),
    winnerSocketId,
    winnerName: winner?.botName || (winner?.isBot ? "bot" : winner ? "human" : null),
    matchType: summary.matchType,
  });

  brain.history = brain.history.slice(-200);

  saveBrain(brain);
}

module.exports = {
  getProfile,
  recordMatchResult,
  loadBrain,
};
