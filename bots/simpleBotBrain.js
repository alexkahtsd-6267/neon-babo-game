const { angleTo, dist, hasLineOfSight, clamp } = require("../shared");

function makeMemory() {
  return {
    lastDecisionAt: 0,
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

function vectorToKeys(x, y) {
  return {
    up: y < -0.25,
    down: y > 0.25,
    left: x < -0.25,
    right: x > 0.25,
  };
}

function decide(snapshot, mySocketId, enemySocketId, profile, memory) {
  const me = snapshot?.players?.[mySocketId];
  const enemy = snapshot?.players?.[enemySocketId];

  if (!me || !enemy || !me.alive) {
    return {
      up: false,
      down: false,
      left: false,
      right: false,
      aim: 0,
      fire: false,
      block: false,
      ball: false,
      dashPressed: false,
      grenadePressed: false,
      knifePressed: false,
      sniperPressed: false,
      molotovPressed: false,
      rate: profile.rate,
      speed: profile.speed,
      dpsMult: profile.dpsMult,
    };
  }

  const now = Date.now();
  const d = dist(me.x, me.y, enemy.x, enemy.y);
  const aim = angleTo(me.x, me.y, enemy.x, enemy.y);
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

  const ux = Math.cos(aim);
  const uy = Math.sin(aim);

  const sx = -uy * memory.strafeDir;
  const sy = ux * memory.strafeDir;

  const moveX = ux * toward + sx * profile.strafeAmount;
  const moveY = uy * toward + sy * profile.strafeAmount;

  const mag = Math.hypot(moveX, moveY) || 1;
  const keys = vectorToKeys(moveX / mag, moveY / mag);

  const enemyShooting = !!enemy.shooting;
  const shouldBlock = enemyShooting && d < 800 && Math.random() < profile.blockChance;

  let dashPressed = false;

  if (hpPct < profile.dashWhenHpBelow && now >= memory.nextDashAt) {
    memory.dashPulseUntil = now + 100;
    memory.nextDashAt = now + 1800 + Math.random() * 1600;
  }

  if (now < memory.dashPulseUntil) dashPressed = true;

  let grenadePressed = false;

  if (
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

  if (d < 74 && now >= memory.nextKnifeAt) {
    knifePressed = true;
    memory.nextKnifeAt = now + 5000 + Math.random() * 6000;
  }

  let molotovPressed = false;

  if (los && d < 700 && now >= memory.nextMolotovAt && Math.random() < 0.025) {
    molotovPressed = true;
    memory.nextMolotovAt = now + 5000 + Math.random() * 7000;
  }

  const ball = los && d < 950 && Math.random() < profile.ballChance;
  const fire = los && !shouldBlock && d < 1300 && Math.random() < profile.aggression;

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

module.exports = {
  makeMemory,
  decide,
};
