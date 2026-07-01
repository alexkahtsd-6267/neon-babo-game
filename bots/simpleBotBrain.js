const {
  angleTo,
  dist,
  hasLineOfSight,
  clamp,
  FLAG_BASES,
  DEFAULTS,
} = require("../shared");

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

function n(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function bool(value, fallback) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function getAggressionLevel(name, fallback = 5) {
  const levels = DEFAULTS.bots?.aggressionLevel || {};
  const value = Number(levels[name]);

  return clamp(Number.isFinite(value) ? value : fallback, 0, 10);
}

function levelScale(level) {
  // 0 = 0x, 5 = 1x, 10 = 2x
  return clamp(level / 5, 0, 2);
}

function radiusScale(level) {
  // 0 = smaller awareness, 5 = normal, 10 = wider awareness
  return clamp(0.5 + level / 10, 0.5, 1.5);
}

function getBotConfig(profile = {}) {
  const flagPursuitLevel = getAggressionLevel("flagPursuit", 5);
  const flagDefenseLevel = getAggressionLevel("flagDefense", 5);
  const baseDefenseLevel = getAggressionLevel("baseDefense", 5);
  const basePursuitLevel = getAggressionLevel("basePursuit", 5);
  const recapturingOwnFlagLevel = getAggressionLevel("recapturingOwnFlag", 5);
  const recapturingEnemyFlagLevel = getAggressionLevel("recapturingEnemyFlag", 5);

  const flagPursuitBase = n(
    profile.flagPursuitWeight,
    n(profile.flagCaptureWeight, 0.75)
  );

  return {
    aggression: n(profile.aggression, 0.9),
    idealDistance: n(profile.idealDistance, 520),
    strafeAmount: n(profile.strafeAmount, 0.65),
    grenadeChance: n(profile.grenadeChance, 0.04),
    sniperChance: n(profile.sniperChance, 0.035),
    ballChance: n(profile.ballChance, 0.08),
    blockChance: n(profile.blockChance, 0.45),
    dashWhenHpBelow: n(profile.dashWhenHpBelow, 0.45),
    retreatWhenHpBelow: n(profile.retreatWhenHpBelow, 0.28),

    reactionMs: n(profile.reactionMs, 0),
    aimErrorRadians: n(profile.aimErrorRadians, 0),
    fireMultiplier: n(profile.fireMultiplier, 1),
    movementMultiplier: n(profile.movementMultiplier, 1),

    flagPursuitLevel,
    flagDefenseLevel,
    baseDefenseLevel,
    basePursuitLevel,
    recapturingOwnFlagLevel,
    recapturingEnemyFlagLevel,

    flagPursuitWeight:
      flagPursuitBase * levelScale(flagPursuitLevel),

    flagDefenseWeight:
      n(profile.flagDefenseWeight, 0.75) * levelScale(flagDefenseLevel),

    baseDefenseWeight:
      n(profile.baseDefenseWeight, 1.0) * levelScale(baseDefenseLevel),

    basePursuitWeight:
      n(profile.basePursuitWeight, n(profile.flagReturnWeight, 1.0)) *
      levelScale(basePursuitLevel),

    recapturingOwnFlagWeight:
      n(profile.recapturingOwnFlagWeight, 1.15) *
      levelScale(recapturingOwnFlagLevel),

    recapturingEnemyFlagWeight:
      n(profile.recapturingEnemyFlagWeight, 1.1) *
      levelScale(recapturingEnemyFlagLevel),

    flagThreatRadius:
      n(profile.flagThreatRadius, 520) * radiusScale(flagDefenseLevel),

    blockWhenEnemyHasFlagDistance:
      n(profile.blockWhenEnemyHasFlagDistance, 720) *
      radiusScale(baseDefenseLevel),

    allowBall: bool(profile.allowBall, true),
    allowGrenade: bool(profile.allowGrenade, true),
    allowSniper: bool(profile.allowSniper, true),
    allowMolotov: bool(profile.allowMolotov, true),
    allowKnife: bool(profile.allowKnife, true),
    allowBlock: bool(profile.allowBlock, true),
    allowDash: bool(profile.allowDash, true),

    rate: n(profile.rate, 15),
    speed: n(profile.speed, 1500),
    dpsMult: n(profile.dpsMult, 1),
  };
}

function flagCarrierIs(flag, socketId) {
  if (!flag || !socketId) return false;

  return (
    flag.carrier === socketId ||
    flag.carrierSocketId === socketId ||
    flag.carrierId === socketId
  );
}

function flagIsCarried(flag) {
  return !!(
    flag &&
    (
      flag.carrier ||
      flag.carrierSocketId ||
      flag.carrierId
    )
  );
}

function flagIsDropped(flag) {
  return !!(
    flag &&
    !flagIsCarried(flag) &&
    (
      flag.dropped ||
      flag.isDropped ||
      flag.state === "dropped"
    )
  );
}

function getPointFromObject(obj, fallback = null) {
  if (!obj) return fallback;

  const x = Number(obj.x);
  const y = Number(obj.y);

  if (Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y };
  }

  return fallback;
}

function getBasePoint(team, flag) {
  const base = FLAG_BASES?.[team] || null;

  return (
    getPointFromObject(base) ||
    getPointFromObject(flag) ||
    null
  );
}

function getTacticalTarget(snapshot, me, enemy, mySocketId, enemySocketId, cfg) {
  const flags = snapshot?.flags || {};

  const myTeam = me.team || "p1";
  const enemyTeam = myTeam === "p1" ? "p2" : "p1";

  const ownFlag = flags[myTeam];
  const enemyFlag = flags[enemyTeam];

  const ownBase = getBasePoint(myTeam, ownFlag);
  const enemyBase = getBasePoint(enemyTeam, enemyFlag);

  const meHasEnemyFlag = flagCarrierIs(enemyFlag, mySocketId);
  const enemyHasMyFlag = flagCarrierIs(ownFlag, enemySocketId);

  const ownFlagDropped = flagIsDropped(ownFlag);
  const enemyFlagDropped = flagIsDropped(enemyFlag);

  if (meHasEnemyFlag && ownBase) {
    return {
      x: ownBase.x,
      y: ownBase.y,
      weight: cfg.basePursuitWeight,
      reason: "base pursuit: return to base with enemy flag",
    };
  }

  if (enemyHasMyFlag) {
    return {
      x: enemy.x,
      y: enemy.y,
      weight: cfg.baseDefenseWeight,
      reason: "base defense: stop enemy flag carrier",
    };
  }

  if (ownFlagDropped) {
    const ownFlagPoint = getPointFromObject(ownFlag, ownBase);

    if (ownFlagPoint) {
      return {
        x: ownFlagPoint.x,
        y: ownFlagPoint.y,
        weight: cfg.recapturingOwnFlagWeight,
        reason: "recapturing own flag",
      };
    }
  }

  if (enemyFlagDropped) {
    const enemyFlagPoint = getPointFromObject(enemyFlag, enemyBase);

    if (enemyFlagPoint) {
      return {
        x: enemyFlagPoint.x,
        y: enemyFlagPoint.y,
        weight: cfg.recapturingEnemyFlagWeight,
        reason: "recapturing enemy flag",
      };
    }
  }

  if (ownFlag && enemy) {
    const ownFlagPoint = getPointFromObject(ownFlag, ownBase);

    if (ownFlagPoint) {
      const enemyDistToOwnFlag = dist(
        enemy.x,
        enemy.y,
        ownFlagPoint.x,
        ownFlagPoint.y
      );

      if (enemyDistToOwnFlag < cfg.flagThreatRadius) {
        return {
          x: ownFlagPoint.x,
          y: ownFlagPoint.y,
          weight: cfg.flagDefenseWeight,
          reason: "flag defense: enemy near own flag",
        };
      }
    }
  }

  if (enemyFlag && !flagIsCarried(enemyFlag)) {
    const enemyFlagPoint = getPointFromObject(enemyFlag, enemyBase);

    if (enemyFlagPoint) {
      return {
        x: enemyFlagPoint.x,
        y: enemyFlagPoint.y,
        weight: cfg.flagPursuitWeight,
        reason: "flag pursuit: capture enemy flag",
      };
    }
  }

  return null;
}

function vectorToKeys(x, y, movementMultiplier = 1) {
  const safeMove = Math.max(0.2, n(movementMultiplier, 1));
  const threshold = 0.25 / safeMove;

  return {
    up: y < -threshold,
    down: y > threshold,
    left: x < -threshold,
    right: x > threshold,
  };
}

function defaultInput(profile, aim = 0) {
  const cfg = getBotConfig(profile);

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

    rate: cfg.rate,
    speed: cfg.speed,
    dpsMult: cfg.dpsMult,
  };
}

function addAimError(aim, cfg) {
  const error = n(cfg.aimErrorRadians, 0);

  if (error <= 0) return aim;

  return aim + (Math.random() * 2 - 1) * error;
}

function decideNow(snapshot, mySocketId, enemySocketId, profile, memory) {
  const cfg = getBotConfig(profile);

  const me = snapshot?.players?.[mySocketId];
  const enemy = snapshot?.players?.[enemySocketId];

  if (!me || !enemy || !me.alive) {
    return defaultInput(cfg, 0);
  }

  const now = Date.now();
  const d = dist(me.x, me.y, enemy.x, enemy.y);
  const trueAim = angleTo(me.x, me.y, enemy.x, enemy.y);
  const aim = addAimError(trueAim, cfg);
  const los = hasLineOfSight(me.x, me.y, enemy.x, enemy.y);

  const hpPct = me.hp / Math.max(1, me.hpMax);
  const enemyHpPct = enemy.hp / Math.max(1, enemy.hpMax);

  if (now >= memory.nextStrafeFlipAt) {
    memory.strafeDir *= -1;
    memory.nextStrafeFlipAt = now + 600 + Math.random() * 1200;
  }

  let toward = 0;

  if (d > cfg.idealDistance + 90) toward = 1;
  if (d < cfg.idealDistance - 90) toward = -1;
  if (hpPct < cfg.retreatWhenHpBelow) toward = -1;
  if (enemyHpPct < 0.25 && hpPct > 0.35) toward = 1;

  toward *= cfg.movementMultiplier;

  const ux = Math.cos(trueAim);
  const uy = Math.sin(trueAim);

  const sx = -uy * memory.strafeDir;
  const sy = ux * memory.strafeDir;

  let moveX = ux * toward + sx * cfg.strafeAmount * cfg.movementMultiplier;
  let moveY = uy * toward + sy * cfg.strafeAmount * cfg.movementMultiplier;

  const tacticalTarget = getTacticalTarget(
    snapshot,
    me,
    enemy,
    mySocketId,
    enemySocketId,
    cfg
  );

  if (tacticalTarget && tacticalTarget.weight > 0) {
    const tacticalAngle = angleTo(
      me.x,
      me.y,
      tacticalTarget.x,
      tacticalTarget.y
    );

    const tacticalDist = dist(
      me.x,
      me.y,
      tacticalTarget.x,
      tacticalTarget.y
    );

    const tacticalStrength =
      tacticalTarget.weight *
      clamp(tacticalDist / 420, 0.25, 1.4);

    moveX += Math.cos(tacticalAngle) * tacticalStrength;
    moveY += Math.sin(tacticalAngle) * tacticalStrength;
  }

  const mag = Math.hypot(moveX, moveY) || 1;

  const keys = vectorToKeys(
    moveX / mag,
    moveY / mag,
    cfg.movementMultiplier
  );

  const flags = snapshot?.flags || {};
  const ownFlag = flags[me.team];
  const enemyHasMyFlag = flagCarrierIs(ownFlag, enemySocketId);

  const enemyShooting = !!enemy.shooting;

  const shouldBlock =
    cfg.allowBlock &&
    (
      enemyShooting ||
      (
        enemyHasMyFlag &&
        d < cfg.blockWhenEnemyHasFlagDistance
      )
    ) &&
    d < 900 &&
    Math.random() < cfg.blockChance;

  let dashPressed = false;

  if (
    cfg.allowDash &&
    hpPct < cfg.dashWhenHpBelow &&
    now >= memory.nextDashAt
  ) {
    memory.dashPulseUntil = now + 100;
    memory.nextDashAt = now + 1800 + Math.random() * 1600;
  }

  if (cfg.allowDash && now < memory.dashPulseUntil) {
    dashPressed = true;
  }

  let grenadePressed = false;

  if (
    cfg.allowGrenade &&
    los &&
    d < 1000 &&
    now >= memory.nextGrenadeAt &&
    Math.random() < cfg.grenadeChance
  ) {
    grenadePressed = true;
    memory.nextGrenadeAt = now + 3500 + Math.random() * 4000;
  }

  let sniperPressed = false;

  if (
    cfg.allowSniper &&
    los &&
    d < 1400 &&
    now >= memory.nextSniperAt &&
    me.mana >= 8000 &&
    Math.random() < cfg.sniperChance
  ) {
    sniperPressed = true;
    memory.nextSniperAt = now + 2500 + Math.random() * 4500;
  }

  let knifePressed = false;

  if (
    cfg.allowKnife &&
    d < 74 &&
    now >= memory.nextKnifeAt
  ) {
    knifePressed = true;
    memory.nextKnifeAt = now + 5000 + Math.random() * 6000;
  }

  let molotovPressed = false;

  if (
    cfg.allowMolotov &&
    los &&
    d < 700 &&
    now >= memory.nextMolotovAt &&
    Math.random() < 0.025
  ) {
    molotovPressed = true;
    memory.nextMolotovAt = now + 5000 + Math.random() * 7000;
  }

  const ball =
    cfg.allowBall &&
    los &&
    d < 950 &&
    Math.random() < cfg.ballChance;

  const fire =
    los &&
    !shouldBlock &&
    d < 1300 &&
    Math.random() < cfg.aggression * cfg.fireMultiplier;

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

    rate: clamp(cfg.rate, 1, 1000),
    speed: clamp(cfg.speed, 1, 20000),
    dpsMult: clamp(cfg.dpsMult, 1, 2),
  };
}

function decide(snapshot, mySocketId, enemySocketId, profile, memory) {
  const cfg = getBotConfig(profile);

  const now = Date.now();
  const reactionMs = Math.max(0, n(cfg.reactionMs, 0));

  if (
    memory.cachedInput &&
    reactionMs > 0 &&
    now - memory.lastDecisionAt < reactionMs
  ) {
    return memory.cachedInput;
  }

  const nextInput = decideNow(snapshot, mySocketId, enemySocketId, cfg, memory);

  memory.cachedInput = nextInput;
  memory.lastDecisionAt = now;

  return nextInput;
}

module.exports = {
  makeMemory,
  decide,
};
