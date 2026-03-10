const ARENA = { w: 2200, h: 1400 };
const TAU = Math.PI * 2;

const WALLS = [
  { x: 1020, y: 580, w: 160, h: 240 },
  { x: 520, y: 240, w: 240, h: 140 },
  { x: 1440, y: 240, w: 240, h: 140 },
  { x: 520, y: 1020, w: 240, h: 140 },
  { x: 1440, y: 1020, w: 240, h: 140 },
  { x: 240, y: 520, w: 140, h: 360 },
  { x: 1820, y: 520, w: 140, h: 360 },
  { x: 860, y: 360, w: 120, h: 120 },
  { x: 1220, y: 360, w: 120, h: 120 },
  { x: 860, y: 920, w: 120, h: 120 },
  { x: 1220, y: 920, w: 120, h: 120 },
  { x: 760, y: 640, w: 70, h: 120 },
  { x: 1370, y: 640, w: 70, h: 120 },
];

const SPAWN_POINTS = {
  p1: { x: 360, y: ARENA.h / 2 },
  p2: { x: ARENA.w - 360, y: ARENA.h / 2 },
};

const FLAG_BASES = {
  p1: { x: 150, y: ARENA.h / 2 },
  p2: { x: ARENA.w - 150, y: ARENA.h / 2 },
};

const DEFAULTS = {
  hpMax: 3000,
  manaMax: 10000,
  manaRegen: 1500,
  regenDelayAfterSpend: 0.4,

  drainX1: 2000,
  drainX2: 7000,

  knifeCd: 10,
  knifeDist: 58,
  knifeDamage: 2000,

  moloCd: 10,
  moloSpeed: 500,
  moloBurnDps: 150,
  moloBurnDuration: 5,

  grenCd: 15,
  grenSpeed: 300,
  grenDamage: 1500,
  grenRadius: 140,

  ballFactor: 0.2,
  ballLife: 10,

  sniperCost: 8000,
  sniperDamage: 500,

  blockStartCost: 5000,
  blockDrain: 4000,
  blockDuration: 1,

  timeMult: 1.2,
  timeDuration: 10,

  sizeBoostDefault: true,
  sizeBoostThreshold: 1800,
  sizeBoostRefSpeed: 1600,
  sizeBoostScale: 1.0,
  sizeBoostManaMult: 1.3,

  teleportTime: 1,
  teleportCost: 5000,
  teleportMinEnemyDist: 240,

  dashMax: 4,
  dashRechargeTime: 2.1,

  p1: { rate: 15, speed: 1500, dpsMult: 1.0 },
  p2: { rate: 15, speed: 1500, dpsMult: 1.0 },

  damageScalePoints: [
    { speed: 700, scale: 1 },
    { speed: 1600, scale: 1 },
    { speed: 3000, scale: 1 },
    { speed: 20000, scale: 1 },
  ],

  ctf: {
    enabled: true,
    pickupRadius: 36,
    baseRadius: 70,
    pickupCooldown: 10,
  },
};

const RATE_PRESETS = {
  "1": 1,
  "2": 4,
  "3": 11,
  "4": 30,
  "5": 120,
  "6": 1000,
};

const SPEED_PRESETS = {
  l: 1,
  z: 200,
  x: 400,
  c: 700,
  v: 1600,
  b: 3500,
  n: 8000,
  m: 20000,
};

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function dist(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function angleTo(ax, ay, bx, by) {
  return Math.atan2(by - ay, bx - ax);
}

function baseDpsFromRate(rate) {
  const r = clamp(rate, 1, 1000);
  const points = [
    { x: 1, y: 1000 },
    { x: 10, y: 900 },
    { x: 100, y: 750 },
    { x: 1000, y: 550 },
  ];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (r >= a.x && r <= b.x) {
      return lerp(a.y, b.y, (r - a.x) / (b.x - a.x));
    }
  }
  return 550;
}

function speedMultiplier(speed) {
  const s = clamp(speed, 1, 20000);
  const points = [
    { x: 1, y: 5.5 },
    { x: 2, y: 5.0 },
    { x: 20, y: 4.0 },
    { x: 200, y: 3.0 },
    { x: 2000, y: 2.0 },
    { x: 20000, y: 1.0 },
  ];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (s >= a.x && s <= b.x) {
      return lerp(a.y, b.y, (s - a.x) / (b.x - a.x));
    }
  }
  return 1;
}

function totalAttackDps(rate, speed) {
  return baseDpsFromRate(rate) * speedMultiplier(speed);
}

function projectileRadiusFromSpeed(speed) {
  const t = 1 - (clamp(speed, 1, 20000) - 1) / (20000 - 1);
  const m = speedMultiplier(speed);
  return 4 + t * 16 + (m - 1) * 1.2;
}

function damageScaleFromSpeed(speed) {
  const pts = [...DEFAULTS.damageScalePoints]
    .map((p) => ({
      speed: clamp(Number(p.speed) || 1, 1, 20000),
      scale: Math.max(0, Number(p.scale) || 0),
    }))
    .sort((a, b) => a.speed - b.speed);

  if (speed <= pts[0].speed) return pts[0].scale;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (speed >= a.speed && speed <= b.speed) {
      const t = (speed - a.speed) / Math.max(1e-9, b.speed - a.speed);
      return lerp(a.scale, b.scale, t);
    }
  }

  return pts[pts.length - 1].scale;
}

function manaDrainPerSecond(mult) {
  const t = clamp(mult, 1, 2) - 1;
  return lerp(DEFAULTS.drainX1, DEFAULTS.drainX2, t);
}

function manaCostPerShot(mult, rate) {
  const r = clamp(rate, 1, 1000);
  return manaDrainPerSecond(mult) / r;
}

function currentSizeBoostActive(player) {
  return !!player.sizeBoostEnabled && player.speed > DEFAULTS.sizeBoostThreshold;
}

function currentProjectileManaMultiplier(player) {
  return currentSizeBoostActive(player) ? DEFAULTS.sizeBoostManaMult : 1;
}

function projectileRadiusForPlayer(player) {
  if (currentSizeBoostActive(player)) {
    return (
      projectileRadiusFromSpeed(DEFAULTS.sizeBoostRefSpeed) *
      DEFAULTS.sizeBoostScale
    );
  }
  return projectileRadiusFromSpeed(player.speed);
}

function attackManaDrainPerSecond(player) {
  return manaDrainPerSecond(player.dpsMult) * currentProjectileManaMultiplier(player);
}

function ballManaCostPerShot(player) {
  return (
    manaCostPerShot(player.dpsMult, player.rate) *
    currentProjectileManaMultiplier(player)
  );
}

function perShotDamage(player) {
  const scale = damageScaleFromSpeed(player.speed);
  return (totalAttackDps(player.rate, player.speed) * player.dpsMult / Math.max(player.rate, 1)) * scale;
}

function circleRectPush(circle, rect) {
  const cx = circle.x;
  const cy = circle.y;
  const r = circle.r;

  const closestX = clamp(cx, rect.x, rect.x + rect.w);
  const closestY = clamp(cy, rect.y, rect.y + rect.h);

  const dx = cx - closestX;
  const dy = cy - closestY;
  const d2 = dx * dx + dy * dy;

  if (d2 < r * r) {
    const d = Math.sqrt(d2) || 0.0001;
    const overlap = r - d;
    circle.x += (dx / d) * overlap;
    circle.y += (dy / d) * overlap;
    if ("vx" in circle) circle.vx *= 0.6;
    if ("vy" in circle) circle.vy *= 0.6;
    return true;
  }

  return false;
}

function keepInArena(entity) {
  entity.x = clamp(entity.x, entity.r, ARENA.w - entity.r);
  entity.y = clamp(entity.y, entity.r, ARENA.h - entity.r);
}

function resolveWallsForCircle(entity) {
  keepInArena(entity);
  for (let pass = 0; pass < 3; pass++) {
    for (const wall of WALLS) {
      circleRectPush(entity, wall);
    }
    keepInArena(entity);
  }
}

function bulletHitsRect(bullet, wall) {
  const cx = clamp(bullet.x, wall.x, wall.x + wall.w);
  const cy = clamp(bullet.y, wall.y, wall.y + wall.h);
  const dx = bullet.x - cx;
  const dy = bullet.y - cy;
  return dx * dx + dy * dy < bullet.r * bullet.r;
}

function reflectOnRect(body, wall) {
  const left = wall.x;
  const right = wall.x + wall.w;
  const top = wall.y;
  const bottom = wall.y + wall.h;

  const cx = clamp(body.x, left, right);
  const cy = clamp(body.y, top, bottom);
  const dx = body.x - cx;
  const dy = body.y - cy;

  if (Math.abs(dx) > Math.abs(dy)) {
    body.vx *= -1;
    body.x = dx > 0 ? right + body.r : left - body.r;
  } else {
    body.vy *= -1;
    body.y = dy > 0 ? bottom + body.r : top - body.r;
  }
}

function hasLineOfSight(ax, ay, bx, by) {
  const steps = 28;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = lerp(ax, bx, t);
    const y = lerp(ay, by, t);

    for (const wall of WALLS) {
      if (
        x >= wall.x &&
        x <= wall.x + wall.w &&
        y >= wall.y &&
        y <= wall.y + wall.h
      ) {
        return false;
      }
    }
  }
  return true;
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

function raycastBeamEnd(x, y, ang, maxLen = 5000) {
  const step = 8;
  let px = x;
  let py = y;
  const dx = Math.cos(ang) * step;
  const dy = Math.sin(ang) * step;
  const steps = Math.ceil(maxLen / step);

  for (let i = 0; i < steps; i++) {
    px += dx;
    py += dy;

    if (px < 0 || py < 0 || px > ARENA.w || py > ARENA.h) {
      return { x: clamp(px, 0, ARENA.w), y: clamp(py, 0, ARENA.h), hitWall: true };
    }

    for (const wall of WALLS) {
      if (
        px >= wall.x &&
        px <= wall.x + wall.w &&
        py >= wall.y &&
        py <= wall.y + wall.h
      ) {
        return { x: px - dx, y: py - dy, hitWall: true };
      }
    }
  }

  return { x: px, y: py, hitWall: false };
}

function makePlayerState(id, slot) {
  const team = slot === 1 ? "p1" : "p2";
  const spawn = SPAWN_POINTS[team];
  const playerDefaults = DEFAULTS[team];

  return {
    id,
    slot,
    team,

    x: spawn.x,
    y: spawn.y,
    r: 18,
    vx: 0,
    vy: 0,
    aim: 0,

    hp: DEFAULTS.hpMax,
    hpMax: DEFAULTS.hpMax,

    mana: DEFAULTS.manaMax,
    manaMax: DEFAULTS.manaMax,
    manaRegen: DEFAULTS.manaRegen,

    regenDelayAfterSpend: DEFAULTS.regenDelayAfterSpend,
    regenDelayT: 0,
    wasSpending: false,

    dash: DEFAULTS.dashMax,
    dashMax: DEFAULTS.dashMax,
    dashRechargeT: 0,
    dashRechargeTime: DEFAULTS.dashRechargeTime,

    rate: playerDefaults.rate,
    speed: playerDefaults.speed,
    dpsMult: playerDefaults.dpsMult,

    shootCd: 0,
    moloCd: 0,
    knifeCd: 0,
    grenCd: 0,
    ballCd: 0,

    tpT: 0,
    tpMax: DEFAULTS.teleportTime,
    tpTx: 0,
    tpTy: 0,

    blocking: false,
    blockT: 0,
    blockUnlocked: true,

    timeT: 0,
    sizeBoostEnabled: DEFAULTS.sizeBoostDefault,

    status: {
      burnT: 0,
      burnDps: 0,
      timeT: 0,
      timeDps: 0,
    },

    alive: true,
  };
}

module.exports = {
  ARENA,
  TAU,
  WALLS,
  SPAWN_POINTS,
  FLAG_BASES,
  DEFAULTS,
  RATE_PRESETS,
  SPEED_PRESETS,
  clamp,
  lerp,
  dist,
  angleTo,
  baseDpsFromRate,
  speedMultiplier,
  totalAttackDps,
  projectileRadiusFromSpeed,
  damageScaleFromSpeed,
  manaDrainPerSecond,
  manaCostPerShot,
  currentSizeBoostActive,
  currentProjectileManaMultiplier,
  projectileRadiusForPlayer,
  attackManaDrainPerSecond,
  ballManaCostPerShot,
  perShotDamage,
  circleRectPush,
  keepInArena,
  resolveWallsForCircle,
  bulletHitsRect,
  reflectOnRect,
  hasLineOfSight,
  pointToSegmentDistance,
  raycastBeamEnd,
  makePlayerState,
};
