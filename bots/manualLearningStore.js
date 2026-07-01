const fs = require("fs");
const path = require("path");
const brainStore = require("./bots/botBrainStore");

const MANUAL_ENTRIES_FILE = path.join(__dirname, "manualLearningEntries.json");

const CATEGORY_EFFECTS = {
  flag_defense: {
    label: "Improve flag defense",
    description: "Bots should defend their own flag more strongly.",
    changes: {
      flagDefenseWeight: 0.3,
      flagThreatRadius: 80,
      blockChance: 0.05,
    },
  },

  flag_capture: {
    label: "Improve flag capture",
    description: "Bots should push toward the enemy flag more often.",
    changes: {
      flagCaptureWeight: 0.3,
      aggression: 0.04,
      idealDistance: 25,
    },
  },

  base_defense_when_enemy_has_flag: {
    label: "Defend base when enemy has flag",
    description: "Bots should chase, block, and defend when the enemy is carrying the flag.",
    changes: {
      baseDefenseWeight: 0.35,
      blockChance: 0.08,
      blockWhenEnemyHasFlagDistance: 80,
    },
  },

  custom_note: {
    label: "Custom note only",
    description: "Stores the note but does not directly adjust the bot brain.",
    changes: {},
  },
};

const LIMITS = {
  aggression: [0.1, 1],
  idealDistance: [180, 1100],
  strafeAmount: [0, 1.5],
  grenadeChance: [0, 0.3],
  sniperChance: [0, 0.25],
  ballChance: [0, 0.35],
  blockChance: [0, 0.95],
  dashWhenHpBelow: [0.05, 0.95],
  retreatWhenHpBelow: [0.03, 0.75],
  rate: [1, 1000],
  speed: [1, 20000],
  dpsMult: [1, 2],

  flagDefenseWeight: [0, 3],
  flagCaptureWeight: [0, 3],
  baseDefenseWeight: [0, 3],
  flagReturnWeight: [0, 3],
  flagThreatRadius: [100, 1200],
  blockWhenEnemyHasFlagDistance: [150, 1400],
};

function readEntries() {
  if (!fs.existsSync(MANUAL_ENTRIES_FILE)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(MANUAL_ENTRIES_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("Could not read manualLearningEntries.json:", err);
    return [];
  }
}

function saveEntries(entries) {
  fs.writeFileSync(MANUAL_ENTRIES_FILE, JSON.stringify(entries, null, 2));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundValue(value) {
  if (Math.abs(value) >= 100) return Math.round(value);
  return Math.round(value * 1000) / 1000;
}

function applyChangesToProfile(profile, changes) {
  const applied = [];

  for (const [field, delta] of Object.entries(changes || {})) {
    const [min, max] = LIMITS[field] || [-Infinity, Infinity];

    const before = Number(profile[field] ?? 0);
    const after = roundValue(clamp(before + Number(delta), min, max));

    profile[field] = after;

    applied.push({
      field,
      before,
      after,
      delta: roundValue(after - before),
    });
  }

  return applied;
}

function addManualEntry({
  title = "",
  note = "",
  category = "custom_note",
  profiles = ["bot1", "bot2"],
  applyToBrain = true,
} = {}) {
  const safeCategory = CATEGORY_EFFECTS[category] ? category : "custom_note";
  const effect = CATEGORY_EFFECTS[safeCategory];

  const safeProfiles = Array.isArray(profiles) && profiles.length
    ? profiles
    : ["bot1", "bot2"];

  const entry = {
    id: `manual_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    title: String(title || effect.label),
    note: String(note || ""),
    category: safeCategory,
    categoryLabel: effect.label,
    categoryDescription: effect.description,
    profiles: safeProfiles,
    applyToBrain: !!applyToBrain,
    appliedProfiles: [],
  };

  if (entry.applyToBrain && Object.keys(effect.changes).length > 0) {
    const brain = brainStore.loadBrain();

    for (const profileName of safeProfiles) {
      if (!brain.profiles[profileName]) continue;

      const appliedChanges = applyChangesToProfile(
        brain.profiles[profileName],
        effect.changes
      );

      entry.appliedProfiles.push({
        profileName,
        changes: appliedChanges,
      });
    }

    brain.history = Array.isArray(brain.history) ? brain.history : [];

    brain.history.push({
      timestamp: entry.timestamp,
      matchType: "manual_coaching",
      reason: entry.categoryLabel,
      title: entry.title,
      note: entry.note,
      category: entry.category,
      mutatedProfiles: entry.appliedProfiles.map((p) => ({
        profileName: p.profileName,
        reason: entry.categoryLabel,
        changes: p.changes,
      })),
      manualEntryId: entry.id,
    });

    brain.history = brain.history.slice(-500);
    brainStore.saveBrain(brain);
  }

  const entries = readEntries();
  entries.push(entry);
  saveEntries(entries.slice(-500));

  return entry;
}

function getManualEntries({ limit = 100 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return readEntries().slice(-safeLimit).reverse();
}

module.exports = {
  CATEGORY_EFFECTS,
  addManualEntry,
  getManualEntries,
};
