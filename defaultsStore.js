const fs = require("fs");
const path = require("path");
const { DEFAULTS } = require("./shared");

const DEFAULTS_FILE = path.join(__dirname, "savedDefaults.json");

function isPlainObject(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, override) {
  const result = deepClone(base);

  if (!isPlainObject(override)) {
    return result;
  }

  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function replaceObjectContents(target, source) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }

  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
}

function loadJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("Could not read saved defaults:", err);
    return null;
  }
}

function saveDefaults() {
  try {
    fs.writeFileSync(DEFAULTS_FILE, JSON.stringify(DEFAULTS, null, 2));
  } catch (err) {
    console.error("Could not save defaults:", err);
  }
}

function loadSavedDefaults() {
  const saved = loadJsonFile(DEFAULTS_FILE);

  const merged = deepMerge(DEFAULTS, saved || {});

  replaceObjectContents(DEFAULTS, merged);

  saveDefaults();

  return DEFAULTS;
}

function getDefaults() {
  const saved = loadJsonFile(DEFAULTS_FILE);

  const merged = deepMerge(DEFAULTS, saved || {});

  replaceObjectContents(DEFAULTS, merged);

  saveDefaults();

  return DEFAULTS;
}

function updateDefaults(nextDefaults = {}) {
  const merged = deepMerge(DEFAULTS, nextDefaults);

  replaceObjectContents(DEFAULTS, merged);

  saveDefaults();

  return DEFAULTS;
}

module.exports = {
  loadSavedDefaults,
  getDefaults,
  updateDefaults,
};
