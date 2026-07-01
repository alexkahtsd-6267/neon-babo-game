const { angleTo, dist, hasLineOfSight, clamp } = require("../shared");

function makeMemory() {
  return {
    lastDecisionAt: 0,
    cachedInput: null,

    strafeDir: Math.random() < 0.5 ? -1 : 1,
    nextStrafeFlipAt: Date.now() + 800,

    nextGrenadeAt: 0,
    nextSniperAt: 0,
    nextBallUntil: 0,
    nextDashAt: 0,
    dashPulseUntil: 0,
    nextKnifeAt: 0,
    nextMolotovAt: 0,
  };
}

function vectorToKeys(x, y, movementMultiplier = 1) {
  const threshold = 0.25 / Math.max(0.2, movementMultiplier);

  return {
    up: y < -threshold,
    down: y > threshold,
    left: x < -threshold,
    right: x > threshold,
  };
}

function defaultInput(profile, aim = 0) {
  return {
    up: false,
    down: false,
    left: false,
    right: false,

    aim,
    fire: false,
    block: false,
    ball: false,

    dashPressed: false,

    teleportPressed: false,
    teleportX: 0,
    teleportY: 0,

    timePressed: false,
    sizeBoostTogglePressed: false,

    grenadePressed: false,
    grenadeX: 0,
    grenadeY: 0,

    knifePressed: false,
    sniperPressed: false,
    molotovPressed: false,

    rate: profile.rate,
    speed: profile.speed,
    dpsMult: profile.dpsMult,
  };
}

function addAimError(aim, profile) {
  const error = Number(profile.aimErrorRadians) || 0;

  if (error <= 0) return aim;

  return aim + (Math.random() * 2 - 1) * error;
}

function decideNow(snapshot, mySocketId, enemySocketId, profile, memory) {
  const me = snapshot?.players?.[mySocketId];
  const enemy = snapshot?.players?.[enemySocketId];

  if (!me || !enemy || !me.alive) {
    return defaultInput(profile, 0);
  }

  const now = Date.now();
  const d = dist(me.x, me.y, enemy.x, enemy.y);
  const trueAim = angleTo(me.x, me.y, enemy.x, enemy.y);
  const aim = addAimError(trueAim, profile);
  const los = hasLineOfSight(me.x, me.y, enemy.x, enemy.y);

  const hpPct = me.hp / Math.max(1, me.hpMax);
  const enemyHpPct = enemy.hp / Math.max(1, enemy.hpMax);

  if (now >= memory.nextStrafeFlipAt) {
    memory.strafeDir *= -1;
    memory.nextStrafeFlipAt = now + 600 + Math.random() * 1200;
  }

  let toward = 0;

  if (d > profile.idealDistance + 90) toward = 1;
  if (d < profile.idealDistance - 90) toward = -1;
  if (hpPct < profile.retreatWhenHpBelow) toward = -1;
  if (enemyHpPct < 0.25 && hpPct > 0.35) toward = 1;

  toward *= Number(profile.movementMultiplier) || 1;

  const ux = Math.cos(trueAim);
  const uy = Math.sin(trueAim);

  const sx = -uy * memory.strafeDir;
  const sy = ux * memory.strafeDir;

  const moveX = ux * toward + sx * profile.strafeAmount * profile.movementMultiplier;
  const moveY = uy * toward + sy * profile.strafeAmount * profile.movementMultiplier;

  const mag = Math.hypot(moveX, moveY) || 1;

  const keys = vectorToKeys(
    moveX / mag,
    moveY / mag,
    profile.movementMultiplier
  );

  const enemyShooting = !!enemy.shooting;

  const shouldBlock =
    !!profile.allowBlock &&
    enemyShooting &&
    d < 800 &&
    Math.random() < profile.blockChance;

  let dashPressed = false;

  if (
    !!profile.allowDash &&
    hpPct < profile.dashWhenHpBelow &&
    now >= memory.nextDashAt
  ) {
    memory.dashPulseUntil = now + 100;
    memory.nextDashAt = now + 1800 + Math.random() * 1600;
  }

  if (!!profile.allowDash && now < memory.dashPulseUntil) {
    dashPressed = true;
  }

  let grenadePressed = false;

  if (
    !!profile.allowGrenade &&
    los &&
    d < 1000 &&
    now >= memory.nextGrenadeAt &&
    Math.random() < profile.grenadeChance
  ) {
    grenadePressed = true;
    memory.nextGrenadeAt = now + 3500 + Math.random() * 4000;
  }

  let sniperPressed = false;

  if (
    !!profile.allowSniper &&
    los &&
    d < 1400 &&
    now >= memory.nextSniperAt &&
    me.mana >= 8000 &&
    Math.random() < profile.sniperChance
  ) {
    sniperPressed = true;
    memory.nextSniperAt = now + 2500 + Math.random() * 4500;
  }

  let knifePressed = false;

  if (
    !!profile.allowKnife &&
    d < 74 &&
    now >= memory.nextKnifeAt
  ) {
    knifePressed = true;
    memory.nextKnifeAt = now + 5000 + Math.random() * 6000;
  }

  let molotovPressed = false;

  if (
    !!profile.allowMolotov &&
    los &&
    d < 700 &&
    now >= memory.nextMolotovAt &&
    Math.random() < 0.025
  ) {
    molotovPressed = true;
    memory.nextMolotovAt = now + 5000 + Math.random() * 7000;
  }

  const ball =
    !!profile.allowBall &&
    los &&
    d < 950 &&
    Math.random() < profile.ballChance;

  const fire =
    los &&
    !shouldBlock &&
    d < 1300 &&
    Math.random() < profile.aggression * profile.fireMultiplier;

  return {
    ...keys,

    aim,
    fire,
    block: shouldBlock,
    ball,

    dashPressed,

    teleportPressed: false,
    teleportX: enemy.x,
    teleportY: enemy.y,

    timePressed: false,
    sizeBoostTogglePressed: false,

    grenadePressed,
    grenadeX: enemy.x,
    grenadeY: enemy.y,

    knifePressed,
    sniperPressed,
    molotovPressed,

    rate: clamp(profile.rate, 1, 1000),
    speed: clamp(profile.speed, 1, 20000),
    dpsMult: clamp(profile.dpsMult, 1, 2),
  };
}

function decide(snapshot, mySocketId, enemySocketId, profile, memory) {
  const now = Date.now();
  const reactionMs = Math.max(0, Number(profile.reactionMs) || 0);

  if (
    memory.cachedInput &&
    reactionMs > 0 &&
    now - memory.lastDecisionAt < reactionMs
  ) {
    return memory.cachedInput;
  }

  const nextInput = decideNow(snapshot, mySocketId, enemySocketId, profile, memory);

  memory.cachedInput = nextInput;
  memory.lastDecisionAt = now;

  return nextInput;
}

module.exports = {
  makeMemory,
  decide,
};
