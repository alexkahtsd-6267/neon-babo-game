const DIFFICULTIES = {
  easy: {
    label: "Easy",

    reactionMs: 420,
    aimErrorRadians: 0.32,
    fireMultiplier: 0.35,
    movementMultiplier: 0.45,

    allowBall: false,
    allowGrenade: false,
    allowSniper: false,
    allowMolotov: false,
    allowKnife: false,
    allowBlock: false,
    allowDash: false,

    rate: 8,
    speed: 900,
    dpsMult: 1,
  },

  medium: {
    label: "Medium",

    reactionMs: 250,
    aimErrorRadians: 0.18,
    fireMultiplier: 0.58,
    movementMultiplier: 0.7,

    allowBall: true,
    allowGrenade: false,
    allowSniper: false,
    allowMolotov: false,
    allowKnife: true,
    allowBlock: true,
    allowDash: true,

    rate: 12,
    speed: 1200,
    dpsMult: 1,
  },

  hard: {
    label: "Hard",

    reactionMs: 130,
    aimErrorRadians: 0.08,
    fireMultiplier: 0.78,
    movementMultiplier: 0.9,

    allowBall: true,
    allowGrenade: true,
    allowSniper: false,
    allowMolotov: true,
    allowKnife: true,
    allowBlock: true,
    allowDash: true,

    rate: 15,
    speed: 1500,
    dpsMult: 1,
  },

  extreme: {
    label: "Extremely Hard",

    reactionMs: 60,
    aimErrorRadians: 0.025,
    fireMultiplier: 0.92,
    movementMultiplier: 1,

    allowBall: true,
    allowGrenade: true,
    allowSniper: true,
    allowMolotov: true,
    allowKnife: true,
    allowBlock: true,
    allowDash: true,

    rate: 18,
    speed: 1700,
    dpsMult: 1,
  },

  machine: {
    label: "Machine Level Hard",

    reactionMs: 0,
    aimErrorRadians: 0,
    fireMultiplier: 1,
    movementMultiplier: 1,

    allowBall: true,
    allowGrenade: true,
    allowSniper: true,
    allowMolotov: true,
    allowKnife: true,
    allowBlock: true,
    allowDash: true,

    rate: 25,
    speed: 1900,
    dpsMult: 1,
  },
};

function normalizeDifficulty(value) {
  const raw = String(value || "easy").trim().toLowerCase().replace(/\s+/g, "");

  if (raw === "1" || raw === "easy") return "easy";
  if (raw === "2" || raw === "medium") return "medium";
  if (raw === "3" || raw === "hard") return "hard";
  if (raw === "4" || raw === "extreme" || raw === "extremelyhard") return "extreme";
  if (raw === "5" || raw === "machine" || raw === "machinelevelhard") return "machine";

  return "easy";
}

function applyDifficulty(baseProfile, difficultyValue) {
  const difficultyKey = normalizeDifficulty(difficultyValue);
  const d = DIFFICULTIES[difficultyKey];

  return {
    ...baseProfile,

    difficulty: difficultyKey,
    difficultyLabel: d.label,

    reactionMs: d.reactionMs,
    aimErrorRadians: d.aimErrorRadians,
    fireMultiplier: d.fireMultiplier,
    movementMultiplier: d.movementMultiplier,

    allowBall: d.allowBall,
    allowGrenade: d.allowGrenade,
    allowSniper: d.allowSniper,
    allowMolotov: d.allowMolotov,
    allowKnife: d.allowKnife,
    allowBlock: d.allowBlock,
    allowDash: d.allowDash,

    rate: d.rate,
    speed: d.speed,
    dpsMult: d.dpsMult,
  };
}

module.exports = {
  DIFFICULTIES,
  normalizeDifficulty,
  applyDifficulty,
};
