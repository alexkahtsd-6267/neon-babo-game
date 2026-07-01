const shared = require("../shared");

const {
  angleTo,
  dist,
  hasLineOfSight,
  clamp,
} = shared;

const WALLS = Array.isArray(shared.WALLS) ? shared.WALLS : [];
const ARENA = shared.ARENA || { w: 2200, h: 1400 };
const FLAG_BASES = shared.FLAG_BASES || {
  p1: { x: 150, y: 700 },
  p2: { x: 2050, y: 700 },
};
const DEFAULTS = shared.DEFAULTS || {};

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

    currentWaypoint: null,
    waypointUntil: 0,

    lastX: null,
    lastY: null,
    lastProgressAt: Date.now(),

    advancedPath: [],
    advancedPathTargetKey: "",
    advancedPathUntil: 0,
    advancedStuckDir: Math.random() < 0.5 ? -1 : 1,
    advancedLastTargetReason: "",
    advancedLastObjective: null,
  };
}

function getBrainMode() {
  const raw = String(DEFAULTS.bots?.brainMode || "basic")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");

  if (raw === "advanced" || raw === "smart" || raw === "2") {
    return "advanced";
  }

  return "basic";
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
  return clamp(level / 5, 0, 2);
}

function radiusScale(level) {
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

function pointInsideWall(x, y, padding = 0) {
  for (const wall of WALLS) {
    if (
      x >= wall.x - padding &&
      x <= wall.x + wall.w + padding &&
      y >= wall.y - padding &&
      y <= wall.y + wall.h + padding
    ) {
      return true;
    }
  }

  return false;
}

function pointInArena(x, y, padding = 30) {
  return (
    x >= padding &&
    y >= padding &&
    x <= ARENA.w - padding &&
    y <= ARENA.h - padding
  );
}

function getClosestPointOnRect(x, y, rect) {
  return {
    x: clamp(x, rect.x, rect.x + rect.w),
    y: clamp(y, rect.y, rect.y + rect.h),
  };
}

function hasClearPath(ax, ay, bx, by, padding = 30) {
  const steps = Math.max(8, Math.ceil(dist(ax, ay, bx, by) / 32));

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;

    if (!pointInArena(x, y, 18)) return false;
    if (pointInsideWall(x, y, padding)) return false;
  }

  return true;
}

function getWallAvoidanceVector(x, y, radius = 95) {
  let ax = 0;
  let ay = 0;

  for (const wall of WALLS) {
    const closest = getClosestPointOnRect(x, y, wall);
    let dx = x - closest.x;
    let dy = y - closest.y;
    let d = Math.hypot(dx, dy);

    if (d < 0.001) {
      const centerX = wall.x + wall.w / 2;
      const centerY = wall.y + wall.h / 2;

      dx = x - centerX;
      dy = y - centerY;
      d = Math.hypot(dx, dy) || 1;
    }

    if (d < radius) {
      const strength = (radius - d) / radius;

      ax += (dx / d) * strength;
      ay += (dy / d) * strength;
    }
  }

  return { x: ax, y: ay };
}

function getWallWaypoints(padding = 85) {
  const points = [];

  for (const wall of WALLS) {
    const left = wall.x - padding;
    const right = wall.x + wall.w + padding;
    const top = wall.y - padding;
    const bottom = wall.y + wall.h + padding;
    const midX = wall.x + wall.w / 2;
    const midY = wall.y + wall.h / 2;

    points.push(
      { x: left, y: top },
      { x: right, y: top },
      { x: left, y: bottom },
      { x: right, y: bottom },

      { x: midX, y: top },
      { x: midX, y: bottom },
      { x: left, y: midY },
      { x: right, y: midY }
    );
  }

  return points.filter((p) => {
    return (
      pointInArena(p.x, p.y, 35) &&
      !pointInsideWall(p.x, p.y, 24)
    );
  });
}

function getNavigationPointBasic(me, target, memory) {
  if (!target) return null;

  const direct = {
    x: target.x,
    y: target.y,
    reason: target.reason || "direct",
    isWaypoint: false,
  };

  if (hasLineOfSight(me.x, me.y, target.x, target.y)) {
    memory.currentWaypoint = null;
    memory.waypointUntil = 0;
    return direct;
  }

  const now = Date.now();

  if (
    memory.currentWaypoint &&
    now < memory.waypointUntil &&
    dist(me.x, me.y, memory.currentWaypoint.x, memory.currentWaypoint.y) > 45 &&
    hasLineOfSight(me.x, me.y, memory.currentWaypoint.x, memory.currentWaypoint.y)
  ) {
    return memory.currentWaypoint;
  }

  const waypoints = getWallWaypoints(90);

  let bestTwoStep = null;
  let bestVisible = null;

  for (const point of waypoints) {
    const visibleFromMe = hasLineOfSight(me.x, me.y, point.x, point.y);

    if (!visibleFromMe) continue;

    const visibleToTarget = hasLineOfSight(point.x, point.y, target.x, target.y);

    const score =
      dist(me.x, me.y, point.x, point.y) +
      dist(point.x, point.y, target.x, target.y);

    const candidate = {
      x: point.x,
      y: point.y,
      score,
      reason: `waypoint around wall → ${target.reason || "target"}`,
      isWaypoint: true,
    };

    if (visibleToTarget) {
      if (!bestTwoStep || candidate.score < bestTwoStep.score) {
        bestTwoStep = candidate;
      }
    }

    if (!bestVisible || candidate.score < bestVisible.score) {
      bestVisible = candidate;
    }
  }

  const chosen = bestTwoStep || bestVisible || direct;

  if (chosen.isWaypoint) {
    memory.currentWaypoint = chosen;
    memory.waypointUntil = now + 900;
  }

  return chosen;
}

function getTacticalTargetBasic(snapshot, me, enemy, mySocketId, enemySocketId, cfg) {
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

function updateStuckState(memory, me, now) {
  if (memory.lastX === null || memory.lastY === null) {
    memory.lastX = me.x;
    memory.lastY = me.y;
    memory.lastProgressAt = now;
    return false;
  }

  const moved = dist(me.x, me.y, memory.lastX, memory.lastY);

  if (moved > 7) {
    memory.lastX = me.x;
    memory.lastY = me.y;
    memory.lastProgressAt = now;
    return false;
  }

  return now - memory.lastProgressAt > 900;
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

function decideNowBasic(snapshot, mySocketId, enemySocketId, profile, memory) {
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

  const tacticalTarget = getTacticalTargetBasic(
    snapshot,
    me,
    enemy,
    mySocketId,
    enemySocketId,
    cfg
  );

  if (tacticalTarget && tacticalTarget.weight > 0) {
    const navigationTarget = getNavigationPointBasic(me, tacticalTarget, memory);

    if (navigationTarget) {
      const tacticalAngle = angleTo(
        me.x,
        me.y,
        navigationTarget.x,
        navigationTarget.y
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

      const stuck = updateStuckState(memory, me, now);

      if (stuck) {
        moveX += -Math.sin(tacticalAngle) * memory.strafeDir * 1.25;
        moveY += Math.cos(tacticalAngle) * memory.strafeDir * 1.25;
        memory.waypointUntil = 0;
      }
    }
  } else {
    memory.currentWaypoint = null;
    memory.waypointUntil = 0;
  }

  const avoid = getWallAvoidanceVector(me.x, me.y, 105);

  moveX += avoid.x * 1.15;
  moveY += avoid.y * 1.15;

  return finalizeCombatInput({
    snapshot,
    me,
    enemy,
    mySocketId,
    enemySocketId,
    cfg,
    memory,
    now,
    d,
    los,
    aim,
    hpPct,
    moveX,
    moveY,
  });
}

/* ============================
   ADVANCED BRAIN STARTS HERE
   ============================ */

function cellKey(cx, cy) {
  return `${cx},${cy}`;
}

function worldToCell(x, y, cellSize) {
  return {
    cx: clamp(Math.floor(x / cellSize), 0, Math.floor(ARENA.w / cellSize)),
    cy: clamp(Math.floor(y / cellSize), 0, Math.floor(ARENA.h / cellSize)),
  };
}

function cellToWorld(cx, cy, cellSize) {
  return {
    x: clamp(cx * cellSize + cellSize / 2, 24, ARENA.w - 24),
    y: clamp(cy * cellSize + cellSize / 2, 24, ARENA.h - 24),
  };
}

function isWalkableWorld(x, y, padding = 34) {
  return pointInArena(x, y, 24) && !pointInsideWall(x, y, padding);
}

function nearestWalkableCell(cx, cy, cellSize) {
  const start = cellToWorld(cx, cy, cellSize);

  if (isWalkableWorld(start.x, start.y)) {
    return { cx, cy };
  }

  for (let r = 1; r <= 6; r++) {
    for (let ox = -r; ox <= r; ox++) {
      for (let oy = -r; oy <= r; oy++) {
        const nx = cx + ox;
        const ny = cy + oy;
        const p = cellToWorld(nx, ny, cellSize);

        if (
          nx >= 0 &&
          ny >= 0 &&
          p.x >= 0 &&
          p.y >= 0 &&
          p.x <= ARENA.w &&
          p.y <= ARENA.h &&
          isWalkableWorld(p.x, p.y)
        ) {
          return { cx: nx, cy: ny };
        }
      }
    }
  }

  return { cx, cy };
}

function findPathAStar(start, target, options = {}) {
  const cellSize = options.cellSize || 80;
  const maxIterations = options.maxIterations || 1400;

  const startCellRaw = worldToCell(start.x, start.y, cellSize);
  const targetCellRaw = worldToCell(target.x, target.y, cellSize);

  const startCell = nearestWalkableCell(startCellRaw.cx, startCellRaw.cy, cellSize);
  const targetCell = nearestWalkableCell(targetCellRaw.cx, targetCellRaw.cy, cellSize);

  const maxCx = Math.floor(ARENA.w / cellSize);
  const maxCy = Math.floor(ARENA.h / cellSize);

  const open = [];
  const openMap = new Map();
  const closed = new Set();
  const cameFrom = new Map();
  const gScore = new Map();

  function h(cx, cy) {
    return Math.hypot(cx - targetCell.cx, cy - targetCell.cy);
  }

  function pushNode(node) {
    open.push(node);
    openMap.set(cellKey(node.cx, node.cy), node);
  }

  const firstKey = cellKey(startCell.cx, startCell.cy);

  gScore.set(firstKey, 0);
  pushNode({
    cx: startCell.cx,
    cy: startCell.cy,
    f: h(startCell.cx, startCell.cy),
  });

  const dirs = [
    { x: 1, y: 0, cost: 1 },
    { x: -1, y: 0, cost: 1 },
    { x: 0, y: 1, cost: 1 },
    { x: 0, y: -1, cost: 1 },
    { x: 1, y: 1, cost: 1.42 },
    { x: 1, y: -1, cost: 1.42 },
    { x: -1, y: 1, cost: 1.42 },
    { x: -1, y: -1, cost: 1.42 },
  ];

  let iterations = 0;
  let foundKey = null;

  while (open.length > 0 && iterations < maxIterations) {
    iterations++;

    let bestIndex = 0;

    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIndex].f) {
        bestIndex = i;
      }
    }

    const current = open.splice(bestIndex, 1)[0];
    const currentKey = cellKey(current.cx, current.cy);

    openMap.delete(currentKey);

    if (current.cx === targetCell.cx && current.cy === targetCell.cy) {
      foundKey = currentKey;
      break;
    }

    closed.add(currentKey);

    for (const dir of dirs) {
      const nx = current.cx + dir.x;
      const ny = current.cy + dir.y;

      if (nx < 0 || ny < 0 || nx > maxCx || ny > maxCy) continue;

      const nextKey = cellKey(nx, ny);

      if (closed.has(nextKey)) continue;

      const point = cellToWorld(nx, ny, cellSize);

      if (!isWalkableWorld(point.x, point.y, 38)) continue;

      const currentPoint = cellToWorld(current.cx, current.cy, cellSize);

      if (!hasClearPath(currentPoint.x, currentPoint.y, point.x, point.y, 28)) {
        continue;
      }

      const tentativeG = (gScore.get(currentKey) || 0) + dir.cost;

      if (tentativeG >= (gScore.get(nextKey) ?? Infinity)) {
        continue;
      }

      cameFrom.set(nextKey, currentKey);
      gScore.set(nextKey, tentativeG);

      const f = tentativeG + h(nx, ny);

      const existing = openMap.get(nextKey);

      if (existing) {
        existing.f = f;
      } else {
        pushNode({ cx: nx, cy: ny, f });
      }
    }
  }

  if (!foundKey) return [];

  const cells = [];
  let cur = foundKey;

  while (cur) {
    const [cxRaw, cyRaw] = cur.split(",");
    cells.push({
      cx: Number(cxRaw),
      cy: Number(cyRaw),
    });

    cur = cameFrom.get(cur);
  }

  cells.reverse();

  const path = cells.map((cell) => cellToWorld(cell.cx, cell.cy, cellSize));

  path.push({
    x: target.x,
    y: target.y,
  });

  return smoothPath(path);
}

function smoothPath(path) {
  if (!Array.isArray(path) || path.length <= 2) return path || [];

  const result = [];
  let i = 0;

  result.push(path[0]);

  while (i < path.length - 1) {
    let best = i + 1;

    for (let j = path.length - 1; j > i + 1; j--) {
      if (hasClearPath(path[i].x, path[i].y, path[j].x, path[j].y, 30)) {
        best = j;
        break;
      }
    }

    result.push(path[best]);
    i = best;
  }

  return result;
}

function targetKey(target) {
  if (!target) return "";

  return [
    Math.round(target.x / 50),
    Math.round(target.y / 50),
    target.reason || "",
  ].join(":");
}

function getAdvancedNavigationPoint(me, target, memory) {
  if (!target) return null;

  if (hasClearPath(me.x, me.y, target.x, target.y, 30)) {
    memory.advancedPath = [];
    memory.advancedPathTargetKey = "";
    memory.advancedPathUntil = 0;

    return {
      x: target.x,
      y: target.y,
      reason: target.reason || "direct clear path",
      isWaypoint: false,
    };
  }

  const now = Date.now();
  const key = targetKey(target);

  if (
    memory.advancedPathTargetKey !== key ||
    now > memory.advancedPathUntil ||
    !Array.isArray(memory.advancedPath) ||
    memory.advancedPath.length === 0
  ) {
    memory.advancedPath = findPathAStar(
      { x: me.x, y: me.y },
      { x: target.x, y: target.y },
      {
        cellSize: 80,
        maxIterations: 1600,
      }
    );

    memory.advancedPathTargetKey = key;
    memory.advancedPathUntil = now + 700;
  }

  while (
    memory.advancedPath.length > 1 &&
    dist(me.x, me.y, memory.advancedPath[0].x, memory.advancedPath[0].y) < 55
  ) {
    memory.advancedPath.shift();
  }

  const next = memory.advancedPath[0];

  if (next && hasClearPath(me.x, me.y, next.x, next.y, 32)) {
    return {
      x: next.x,
      y: next.y,
      reason: `A* path → ${target.reason || "target"}`,
      isWaypoint: true,
    };
  }

  return getNavigationPointBasic(me, target, memory);
}

function addObjective(candidates, data) {
  if (!data) return;
  if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
  if (!Number.isFinite(data.weight) || data.weight <= 0) return;

  candidates.push(data);
}

function getObjectiveCandidates(snapshot, me, enemy, mySocketId, enemySocketId, cfg) {
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

  const candidates = [];

  if (meHasEnemyFlag && ownBase) {
    addObjective(candidates, {
      x: ownBase.x,
      y: ownBase.y,
      weight: 10 + cfg.basePursuitWeight * 5,
      urgency: 10,
      reason: "ADVANCED: return home to score",
      mode: "score",
    });
  }

  if (enemyHasMyFlag) {
    addObjective(candidates, {
      x: enemy.x,
      y: enemy.y,
      weight: 9 + cfg.baseDefenseWeight * 5,
      urgency: 10,
      reason: "ADVANCED: intercept enemy flag carrier",
      mode: "intercept",
    });
  }

  if (ownFlagDropped) {
    const ownFlagPoint = getPointFromObject(ownFlag, ownBase);

    if (ownFlagPoint) {
      addObjective(candidates, {
        x: ownFlagPoint.x,
        y: ownFlagPoint.y,
        weight: 8 + cfg.recapturingOwnFlagWeight * 5,
        urgency: 9,
        reason: "ADVANCED: return own dropped flag",
        mode: "return-own-flag",
      });
    }
  }

  if (enemyFlagDropped) {
    const enemyFlagPoint = getPointFromObject(enemyFlag, enemyBase);

    if (enemyFlagPoint) {
      addObjective(candidates, {
        x: enemyFlagPoint.x,
        y: enemyFlagPoint.y,
        weight: 7 + cfg.recapturingEnemyFlagWeight * 4,
        urgency: 8,
        reason: "ADVANCED: steal dropped enemy flag",
        mode: "take-dropped-enemy-flag",
      });
    }
  }

  if (ownFlag && enemy) {
    const ownFlagPoint = getPointFromObject(ownFlag, ownBase);

    if (ownFlagPoint) {
      const enemyDistToOwnFlag = dist(enemy.x, enemy.y, ownFlagPoint.x, ownFlagPoint.y);

      if (enemyDistToOwnFlag < cfg.flagThreatRadius) {
        addObjective(candidates, {
          x: ownFlagPoint.x,
          y: ownFlagPoint.y,
          weight: 5 + cfg.flagDefenseWeight * 4,
          urgency: clamp(1 - enemyDistToOwnFlag / cfg.flagThreatRadius, 0, 1) * 8,
          reason: "ADVANCED: defend own flag zone",
          mode: "flag-defense",
        });
      }
    }
  }

  if (enemyFlag && !flagIsCarried(enemyFlag)) {
    const enemyFlagPoint = getPointFromObject(enemyFlag, enemyBase);

    if (enemyFlagPoint) {
      addObjective(candidates, {
        x: enemyFlagPoint.x,
        y: enemyFlagPoint.y,
        weight: 4 + cfg.flagPursuitWeight * 4,
        urgency: cfg.flagPursuitLevel,
        reason: "ADVANCED: capture enemy flag",
        mode: "capture",
      });
    }
  }

  addObjective(candidates, {
    x: enemy.x,
    y: enemy.y,
    weight: 1.5 + cfg.aggression,
    urgency: 2,
    reason: "ADVANCED: pressure enemy",
    mode: "combat-pressure",
  });

  return candidates;
}

function chooseBestObjective(candidates, me) {
  let best = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const d = dist(me.x, me.y, candidate.x, candidate.y);
    const distancePenalty = d / 900;
    const urgencyBonus = n(candidate.urgency, 0) * 0.35;
    const score = candidate.weight + urgencyBonus - distancePenalty;

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function getDangerVector(snapshot, me, enemySocketId) {
  let ax = 0;
  let ay = 0;

  const buckets = [
    snapshot?.projectiles,
    snapshot?.bullets,
    snapshot?.balls,
    snapshot?.grenades,
    snapshot?.molotovs,
  ];

  for (const bucket of buckets) {
    if (!bucket) continue;

    const items = Array.isArray(bucket)
      ? bucket
      : Object.values(bucket);

    for (const item of items) {
      if (!item) continue;

      const x = Number(item.x);
      const y = Number(item.y);

      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

      const owner =
        item.owner ||
        item.ownerId ||
        item.ownerSocketId ||
        item.playerId ||
        null;

      if (owner && owner !== enemySocketId) continue;

      const d = dist(me.x, me.y, x, y);

      if (d > 190) continue;

      const dx = me.x - x;
      const dy = me.y - y;
      const mag = Math.hypot(dx, dy) || 1;
      const strength = (190 - d) / 190;

      ax += (dx / mag) * strength * 1.8;
      ay += (dy / mag) * strength * 1.8;
    }
  }

  return { x: ax, y: ay };
}

function predictiveAim(me, enemy, cfg) {
  const evx = n(enemy.vx, 0);
  const evy = n(enemy.vy, 0);

  const d = dist(me.x, me.y, enemy.x, enemy.y);

  const leadSeconds = clamp(d / 2600, 0.04, 0.32);

  const predictedX = enemy.x + evx * leadSeconds;
  const predictedY = enemy.y + evy * leadSeconds;

  return addAimError(
    angleTo(me.x, me.y, predictedX, predictedY),
    cfg
  );
}

function decideNowAdvanced(snapshot, mySocketId, enemySocketId, profile, memory) {
  const cfg = getBotConfig(profile);

  const me = snapshot?.players?.[mySocketId];
  const enemy = snapshot?.players?.[enemySocketId];

  if (!me || !enemy || !me.alive) {
    return defaultInput(cfg, 0);
  }

  const now = Date.now();

  if (now >= memory.nextStrafeFlipAt) {
    memory.strafeDir *= -1;
    memory.nextStrafeFlipAt = now + 500 + Math.random() * 900;
  }

  const d = dist(me.x, me.y, enemy.x, enemy.y);
  const trueAim = angleTo(me.x, me.y, enemy.x, enemy.y);
  const aim = predictiveAim(me, enemy, cfg);
  const los = hasLineOfSight(me.x, me.y, enemy.x, enemy.y);

  const hpPct = me.hp / Math.max(1, me.hpMax);
  const enemyHpPct = enemy.hp / Math.max(1, enemy.hpMax);

  const candidates = getObjectiveCandidates(
    snapshot,
    me,
    enemy,
    mySocketId,
    enemySocketId,
    cfg
  );

  const objective = chooseBestObjective(candidates, me);

  memory.advancedLastObjective = objective || null;
  memory.advancedLastTargetReason = objective?.reason || "";

  let moveX = 0;
  let moveY = 0;

  if (objective) {
    const navTarget = getAdvancedNavigationPoint(me, objective, memory);
    const navAngle = angleTo(me.x, me.y, navTarget.x, navTarget.y);
    const objectiveDistance = dist(me.x, me.y, objective.x, objective.y);

    const objectiveStrength =
      clamp(objective.weight / 5, 0.5, 3.4) *
      clamp(objectiveDistance / 260, 0.45, 1.45);

    moveX += Math.cos(navAngle) * objectiveStrength;
    moveY += Math.sin(navAngle) * objectiveStrength;
  }

  const combatAngle = trueAim;
  const ux = Math.cos(combatAngle);
  const uy = Math.sin(combatAngle);

  const sx = -uy * memory.strafeDir;
  const sy = ux * memory.strafeDir;

  let toward = 0;

  if (d > cfg.idealDistance + 130) toward = 0.7;
  if (d < cfg.idealDistance - 130) toward = -0.8;
  if (hpPct < cfg.retreatWhenHpBelow) toward = -1.4;
  if (enemyHpPct < 0.22 && hpPct > 0.38) toward = 1.1;

  if (objective?.mode === "score") {
    toward *= 0.25;
  }

  if (objective?.mode === "intercept") {
    toward += 0.9;
  }

  moveX += ux * toward * cfg.movementMultiplier;
  moveY += uy * toward * cfg.movementMultiplier;

  const strafeStrength =
    cfg.strafeAmount *
    cfg.movementMultiplier *
    (
      los && d < 1000
        ? 1.15
        : 0.55
    );

  moveX += sx * strafeStrength;
  moveY += sy * strafeStrength;

  const avoidWall = getWallAvoidanceVector(me.x, me.y, 125);
  const avoidDanger = getDangerVector(snapshot, me, enemySocketId);

  moveX += avoidWall.x * 1.65;
  moveY += avoidWall.y * 1.65;

  moveX += avoidDanger.x * 1.85;
  moveY += avoidDanger.y * 1.85;

  const stuck = updateStuckState(memory, me, now);

  if (stuck) {
    memory.advancedStuckDir *= -1;

    moveX += -Math.sin(trueAim) * memory.advancedStuckDir * 2.2;
    moveY += Math.cos(trueAim) * memory.advancedStuckDir * 2.2;

    memory.advancedPathUntil = 0;
    memory.waypointUntil = 0;
  }

  return finalizeCombatInput({
    snapshot,
    me,
    enemy,
    mySocketId,
    enemySocketId,
    cfg,
    memory,
    now,
    d,
    los,
    aim,
    hpPct,
    moveX,
    moveY,
    advanced: true,
    objective,
  });
}

function finalizeCombatInput({
  snapshot,
  me,
  enemy,
  mySocketId,
  enemySocketId,
  cfg,
  memory,
  now,
  d,
  los,
  aim,
  hpPct,
  moveX,
  moveY,
  advanced = false,
  objective = null,
}) {
  const mag = Math.hypot(moveX, moveY) || 1;

  const keys = vectorToKeys(
    moveX / mag,
    moveY / mag,
    cfg.movementMultiplier
  );

  const flags = snapshot?.flags || {};
  const myTeam = me.team || "p1";
  const ownFlag = flags[myTeam];
  const enemyHasMyFlag = flagCarrierIs(ownFlag, enemySocketId);

  const enemyShooting = !!enemy.shooting;

  const shouldBlock =
    cfg.allowBlock &&
    (
      enemyShooting ||
      (
        enemyHasMyFlag &&
        d < cfg.blockWhenEnemyHasFlagDistance
      ) ||
      (
        advanced &&
        objective?.mode === "intercept" &&
        d < cfg.blockWhenEnemyHasFlagDistance
      )
    ) &&
    d < 950 &&
    Math.random() < (
      advanced && enemyHasMyFlag
        ? clamp(cfg.blockChance + 0.25, 0, 0.98)
        : cfg.blockChance
    );

  let dashPressed = false;

  const shouldEmergencyDash =
    cfg.allowDash &&
    (
      hpPct < cfg.dashWhenHpBelow ||
      (
        advanced &&
        objective?.mode === "score" &&
        d < 650
      ) ||
      (
        advanced &&
        objective?.mode === "intercept" &&
        d > 420
      )
    ) &&
    now >= memory.nextDashAt;

  if (shouldEmergencyDash) {
    memory.dashPulseUntil = now + 100;
    memory.nextDashAt = now + 1400 + Math.random() * 1200;
  }

  if (cfg.allowDash && now < memory.dashPulseUntil) {
    dashPressed = true;
  }

  let grenadePressed = false;

  const grenadeChance = advanced
    ? cfg.grenadeChance * (objective?.mode === "intercept" ? 1.9 : 1.35)
    : cfg.grenadeChance;

  if (
    cfg.allowGrenade &&
    los &&
    d < 1000 &&
    d > 180 &&
    now >= memory.nextGrenadeAt &&
    Math.random() < grenadeChance
  ) {
    grenadePressed = true;
    memory.nextGrenadeAt = now + 3000 + Math.random() * 3500;
  }

  let sniperPressed = false;

  const sniperChance = advanced
    ? cfg.sniperChance * (los && d > 450 ? 1.6 : 0.9)
    : cfg.sniperChance;

  if (
    cfg.allowSniper &&
    los &&
    d < 1500 &&
    me.mana >= 8000 &&
    now >= memory.nextSniperAt &&
    Math.random() < sniperChance
  ) {
    sniperPressed = true;
    memory.nextSniperAt = now + 2200 + Math.random() * 4000;
  }

  let knifePressed = false;

  if (
    cfg.allowKnife &&
    d < 74 &&
    now >= memory.nextKnifeAt
  ) {
    knifePressed = true;
    memory.nextKnifeAt = now + 4200 + Math.random() * 5200;
  }

  let molotovPressed = false;

  if (
    cfg.allowMolotov &&
    los &&
    d < 760 &&
    d > 130 &&
    now >= memory.nextMolotovAt &&
    Math.random() < (advanced ? 0.04 : 0.025)
  ) {
    molotovPressed = true;
    memory.nextMolotovAt = now + 4200 + Math.random() * 6200;
  }

  const ball =
    cfg.allowBall &&
    los &&
    d < 950 &&
    Math.random() < (
      advanced
        ? cfg.ballChance * 1.25
        : cfg.ballChance
    );

  const fireChance =
    advanced
      ? cfg.aggression * cfg.fireMultiplier * (
          objective?.mode === "score" ? 0.65 : 1.08
        )
      : cfg.aggression * cfg.fireMultiplier;

  const fire =
    los &&
    !shouldBlock &&
    d < 1350 &&
    Math.random() < fireChance;

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

  const mode = getBrainMode();

  const nextInput =
    mode === "advanced"
      ? decideNowAdvanced(snapshot, mySocketId, enemySocketId, cfg, memory)
      : decideNowBasic(snapshot, mySocketId, enemySocketId, cfg, memory);

  memory.cachedInput = nextInput;
  memory.lastDecisionAt = now;

  return nextInput;
}

module.exports = {
  makeMemory,
  decide,
};
