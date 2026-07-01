const fs = require("fs");
const path = require("path");
const { DEFAULTS } = require("./shared");

const DEFAULTS_FILE = path.join(__dirname, "defaults.json");

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function mergeKnownKeys(target, incoming) {
  if (!isPlainObject(target) || !isPlainObject(incoming)) return;

  for (const [key, incomingValue] of Object.entries(incoming)) {
    if (!(key in target)) continue;

    const targetValue = target[key];

    if (Array.isArray(targetValue) && Array.isArray(incomingValue)) {
      const template = targetValue[0];

      if (isPlainObject(template)) {
        target[key] = incomingValue.map((item) => {
          const cleanItem = deepClone(template);
          mergeKnownKeys(cleanItem, item);
          return cleanItem;
        });
      } else {
        target[key] = incomingValue.slice();
      }

      continue;
    }

    if (isPlainObject(targetValue) && isPlainObject(incomingValue)) {
      mergeKnownKeys(targetValue, incomingValue);
      continue;
    }

    if (typeof targetValue === "number") {
      const n = Number(incomingValue);
      if (Number.isFinite(n)) target[key] = n;
      continue;
    }

    if (typeof targetValue === "boolean") {
      target[key] = incomingValue === true || incomingValue === "true";
      continue;
    }

    if (typeof targetValue === "string") {
      target[key] = String(incomingValue);
    }
  }
}

function loadSavedDefaults() {
  if (!fs.existsSync(DEFAULTS_FILE)) return;

  try {
    const saved = JSON.parse(fs.readFileSync(DEFAULTS_FILE, "utf8"));
    mergeKnownKeys(DEFAULTS, saved);
    console.log("Loaded defaults.json");
  } catch (err) {
    console.error("Could not load defaults.json:", err);
  }
}

function saveCurrentDefaults() {
  fs.writeFileSync(DEFAULTS_FILE, JSON.stringify(DEFAULTS, null, 2));
}

function getDefaults() {
  return deepClone(DEFAULTS);
}

function updateDefaults(incoming) {
  mergeKnownKeys(DEFAULTS, incoming);
  saveCurrentDefaults();
  return getDefaults();
}

module.exports = {
  loadSavedDefaults,
  getDefaults,
  updateDefaults,
};
