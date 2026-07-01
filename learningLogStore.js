const fs = require("fs");
const path = require("path");
const { getManualEntries } = require("./manualLearningStore");

const BRAIN_FILE = path.join(__dirname, "bots", "botBrain.json");

function safeReadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("Could not read JSON:", filePath, err);
    return fallback;
  }
}

function getLearningLog({ limit = 100 } = {}) {
  const brain = safeReadJson(BRAIN_FILE, {
    version: "unknown",
    profiles: {},
    history: [],
  });

  const history = Array.isArray(brain.history) ? brain.history : [];
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));

  return {
    ok: true,
    generatedAt: new Date().toISOString(),

    brainFile: BRAIN_FILE,
    brainExists: fs.existsSync(BRAIN_FILE),

    version: brain.version || "unknown",
    profiles: brain.profiles || {},

    manualEntries: getManualEntries({ limit: safeLimit }),

    historyCount: history.length,
    history: history.slice(-safeLimit).reverse(),

    rawBrain: brain,
  };
}

module.exports = {
  getLearningLog,
};
