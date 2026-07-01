const fs = require("fs");
const path = require("path");

const LOG_ROOT = path.join(__dirname, "matchLogs");

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileForMatch(matchId) {
  const dir = path.join(LOG_ROOT, todayKey());

  ensureDir(dir);

  return path.join(dir, `${safeName(matchId)}.ndjson`);
}

function appendLine(filePath, obj) {
  const line = JSON.stringify({ t: Date.now(), ...obj }) + "\n";

  fs.appendFile(filePath, line, (err) => {
    if (err) console.error("Match log write error:", err);
  });
}

function startMatch(matchId, meta) {
  const filePath = fileForMatch(matchId);

  appendLine(filePath, {
    type: "match.start",
    meta,
  });

  return filePath;
}

function logEvent(matchId, type, payload = {}) {
  appendLine(fileForMatch(matchId), {
    type,
    payload,
  });
}

function endMatch(matchId, summary = {}) {
  appendLine(fileForMatch(matchId), {
    type: "match.end",
    summary,
  });
}

module.exports = {
  startMatch,
  logEvent,
  endMatch,
};
