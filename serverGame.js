const {
  ARENA,
  DEFAULTS,
  FLAG_BASES,
  TAU,
  clamp,
  lerp,
  dist,
  angleTo,
  projectileRadiusForPlayer,
  perShotDamage,
  ballManaCostPerShot,
  attackManaDrainPerSecond,
  resolveWallsForCircle,
  bulletHitsRect,
  reflectOnRect,
  hasLineOfSight,
  pointToSegmentDistance,
  raycastBeamEnd,
  makePlayerState,
} = require("./shared");

const SERVER_TICK_RATE = 30;
const SERVER_TICK_MS = Math.floor(1000 / SERVER_TICK_RATE);

function makeBlankInput() {
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

    rate: DEFAULTS.p1.rate,
    speed: DEFAULTS.p1.speed,
    dpsMult: DEFAULTS.p1.dpsMult,

    _prevDashPressed: false,
    _prevTeleportPressed: false,
    _prevTimePressed: false,
    _prevSizeBoostTogglePressed: false,
    _prevGrenadePressed: false,
    _prevKnifePressed: false,
    _prevSniperPressed: false,
    _prevMolotovPressed: false,
  };
}

function clonePublicPlayer(player, input) {
  return {
    id: player.id,
    slot: player.slot,
    team: player.team,

    x: player.x,
    y: player.y,
    r: player.r,
    vx: player.vx,
    vy: player.vy,
    aim: player.aim,

    hp: player.hp,
    hpMax: player.hpMax,

    mana: player.mana,
    manaMax: player.manaMax,

    alive: player.alive,
    blocking: player.blocking,
    blockT: player.blockT,

    dash: player.dash,
    dashMax: player.dashMax,

    rate: player.rate,
    speed: player.speed,
    dpsMult: player.dpsMult,

    sizeBoostEnabled: player.sizeBoostEnabled,
    timeT: player.timeT,

    status: {
      burnT: player.status.burnT,
      timeT: player.status.timeT,
    },

    shooting:
      !!input.fire &&
      !player.blocking &&
      player.alive &&
      player.mana > 10 &&
      player.tpT <= 0,
  };
}

function createServerGame(io, roomId, player1SocketId, player2SocketId) {
  const players = {
    [player1SocketId]: makePlayerState(player1SocketId, 1),
    [player2SocketId]: makePlayerState(player2SocketId, 2),
  };

  const inputs = {
    [player1SocketId]: makeBlankInput(),
    [player2SocketId]: makeBlankInput(),
  };

  const state = {
    roomId,
    ended: false,
    winner: null,

    bullets: [],
    balls: [],
    molotovs: [],
    grenades: [],
    sniperBeams: [],
    knifeBursts: [],

    flags: {
      p1: {
        team: "p1",
        x: FLAG_BASES.p1.x,
        y: FLAG_BASES.p1.y,
        homeX: FLAG_BASES.p1.x,
        homeY: FLAG_BASES.p1.y,
        carrier: null,
        dropped: false,
        cooldowns: { p1: 0, p2: 0 },
      },
      p2: {
        team: "p2",
        x: FLAG_BASES.p2.x,
        y: FLAG_BASES.p2.y,
        homeX: FLAG_BASES.p2.x,
        homeY: FLAG_BASES.p2.y,
        carrier: null,
        dropped: false,
        cooldowns: { p1: 0, p2: 0 },
      },
    },
  };

  let interval = null;
  let lastTick = Date.now();

  function getEnemySocketId(socketId) {
    return socketId === player1SocketId ? player2SocketId : player1SocketId;
  }

  function getPlayer(socketId) {
    return players[socketId] || null;
  }

  function getInput(socketId) {
    return inputs[socketId] || null;
  }

  function resetFlagHome(team) {
    const flag = state.flags[team];
    flag.x = flag.homeX;
    flag.y = flag.homeY;
    flag.carrier = null;
    flag.dropped = false;
  }

  function pickupFlag(carrierTeam, flagTeam) {
    const flag = state.flags[flagTeam];
    flag.carrier = carrierTeam;
    flag.dropped = false;
  }

  function dropCarriedFlag(carrierTeam, x, y) {
    for (const team of ["p1", "p2"]) {
      const flag = state.flags[team];
      if (flag.carrier === carrierTeam) {
        flag.carrier = null;
        flag.dropped = true;
        flag.x = x;
        flag.y = y;
        flag.cooldowns[carrierTeam] = DEFAULTS.ctf.pickupCooldown;
      }
    }
  }

  function applyBurn(player, dps, duration) {
    player.status.burnDps = Math.max(player.status.burnDps, dps);
    player.status.burnT = Math.max(player.status.burnT, duration);
  }

  function applyTimeDot(player, extraTotal, duration) {
    if (duration <= 0 || extraTotal <= 0) return;
    player.status.timeDps += extraTotal / duration;
    player.status.timeT = Math.max(player.status.timeT, duration);
  }

  function hitPlayer(target, attacker, dmg) {
    if (!target.alive) return false;
    if (target.blocking) return false;

    if (DEFAULTS.ctf.enabled) {
      dropCarriedFlag(target.team, target.x, target.y);
    }

    target.hp = Math.max(0, target.hp - dmg);
    if (target.hp <= 0) {
      target.alive = false;
      target.vx = 0;
      target.vy = 0;
    }

    if (attacker && attacker.timeT > 0 && DEFAULTS.timeMult > 1) {
      const extra = dmg * (DEFAULTS.timeMult - 1);
      applyTimeDot(target, extra, DEFAULTS.timeDuration);
    }

    return true;
  }

  function updateStatus(player, dt) {
    if (!player.alive) return;

    if (player.status.burnT > 0) {
      player.hp = Math.max(0, player.hp - player.status.burnDps * dt);
      player.status.burnT -= dt;
      if (player.status.burnT <= 0) {
        player.status.burnT = 0;
        player.status.burnDps = 0;
      }
      if (player.hp <= 0) player.alive = false;
    }

    if (player.status.timeT > 0) {
      player.hp = Math.max(0, player.hp - player.status.timeDps * dt);
      player.status.timeT -= dt;
      if (player.status.timeT <= 0) {
        player.status.timeT = 0;
        player.status.timeDps = 0;
      }
      if (player.hp <= 0) player.alive = false;
    }
  }

  function rechargeDash(player, dt) {
    player.dashRechargeT += dt;
    while (player.dashRechargeT >= player.dashRechargeTime) {
      player.dashRechargeT -= player.dashRechargeTime;
      if (player.dash < player.dashMax) {
        player.dash += 1;
      }
    }
  }

  function updateCooldowns(player, dt) {
    player.shootCd = Math.max(0, player.shootCd - dt);
    player.moloCd = Math.max(0, player.moloCd - dt);
    player.knifeCd = Math.max(0, player.knifeCd - dt);
    player.grenCd = Math.max(0, player.grenCd - dt);
    player.ballCd = Math.max(0, player.ballCd - dt);
    player.timeT = Math.max(0, player.timeT - dt);
    rechargeDash(player, dt);
  }

  function updateMana(player, dt, spending) {
    if (spending && player.mana > 10) {
      player.mana = Math.max(0, player.mana - attackManaDrainPerSecond(player) * dt);
    }

    if (player.wasSpending && !spending) {
      player.regenDelayT = player.regenDelayAfterSpend;
    }

    player.wasSpending = spending;

    if (!spending && player.regenDelayT > 0) {
      player.regenDelayT -= dt;
      if (player.regenDelayT < 0) player.regenDelayT = 0;
    }

    if (!spending && player.regenDelayT === 0) {
      player.mana = Math.min(player.manaMax, player.mana + player.manaRegen * dt);
    }
  }

  function updateAim(player, input) {
    if (!player.alive) return;
    if (Number.isFinite(input.aim)) player.aim = input.aim;
  }

  function updateOneShotToggles(player, input) {
    const sizeBoostEdge =
      input.sizeBoostTogglePressed && !input._prevSizeBoostTogglePressed;
    if (sizeBoostEdge) {
      player.sizeBoostEnabled = !player.sizeBoostEnabled;
    }

    const timeEdge = input.timePressed && !input._prevTimePressed;
    if (timeEdge && player.alive) {
      player.timeT = DEFAULTS.timeDuration;
    }
  }

  function dashPlayer(player, input) {
    const dashEdge = input.dashPressed && !input._prevDashPressed;
    if (!dashEdge) return;
    if (player.dash < 1) return;

    let mx = 0;
    let my = 0;
    if (input.up) my -= 1;
    if (input.down) my += 1;
    if (input.left) mx -= 1;
    if (input.right) mx += 1;

    const mag = Math.hypot(mx, my);
    if (mag < 1e-6) return;

    player.dash -= 1;
    const nx = mx / mag;
    const ny = my / mag;
    const burst = 960;

    player.vx += nx * burst;
    player.vy += ny * burst;
  }

  function updateTeleport(player, input, enemy, dt) {
    const teleportEdge = input.teleportPressed && !input._prevTeleportPressed;

    if (teleportEdge && player.tpT <= 0 && player.mana >= DEFAULTS.teleportCost) {
      const tx = clamp(input.teleportX, 0, ARENA.w);
      const ty = clamp(input.teleportY, 0, ARENA.h);

      const probe = { x: tx, y: ty, r: player.r, vx: 0, vy: 0 };
      resolveWallsForCircle(probe);

      if (
        enemy.alive &&
        dist(probe.x, probe.y, enemy.x, enemy.y) >= DEFAULTS.teleportMinEnemyDist &&
        dist(player.x, player.y, enemy.x, enemy.y) >= DEFAULTS.teleportMinEnemyDist
      ) {
        player.mana = Math.max(0, player.mana - DEFAULTS.teleportCost);
        player.wasSpending = true;
        player.regenDelayT = player.regenDelayAfterSpend;

        player.tpTx = probe.x;
        player.tpTy = probe.y;
        player.tpMax = DEFAULTS.teleportTime;
        player.tpT = DEFAULTS.teleportTime;
      }
    }

    if (player.tpT > 0) {
      player.tpT -= dt;
      if (player.tpT <= 0) {
        player.tpT = 0;
        player.x = player.tpTx;
        player.y = player.tpTy;
        player.vx = 0;
        player.vy = 0;
        resolveWallsForCircle(player);
      }
    }
  }

  function updateBlock(player, input, dt) {
    if (!input.block) {
      player.blocking = false;
      player.blockT = 0;
      player.blockUnlocked = true;
      return;
    }

    if (!player.blocking && player.blockUnlocked) {
      if (player.mana < DEFAULTS.blockStartCost) return;

      player.mana = Math.max(0, player.mana - DEFAULTS.blockStartCost);
      player.wasSpending = true;
      player.regenDelayT = player.regenDelayAfterSpend;
      player.blocking = true;
      player.blockT = DEFAULTS.blockDuration;
      player.blockUnlocked = false;
    }

    if (!player.blocking) return;

    const drain = DEFAULTS.blockDrain * dt;
    if (player.mana < drain) {
      player.blocking = false;
      player.blockT = 0;
      return;
    }

    player.mana = Math.max(0, player.mana - drain);
    player.wasSpending = true;
    player.regenDelayT = player.regenDelayAfterSpend;
    player.blockT -= dt;

    if (player.blockT <= 0) {
      player.blocking = false;
      player.blockT = 0;
    }
  }

  function updateMovement(player, input, dt) {
    if (!player.alive) return;
    if (player.tpT > 0) return;

    let mx = 0;
    let my = 0;
    if (input.up) my -= 1;
    if (input.down) my += 1;
    if (input.left) mx -= 1;
    if (input.right) mx += 1;

    const mag = Math.hypot(mx, my);
    if (mag > 1e-6) {
      mx /= mag;
      my /= mag;
    }

    const moveSpeed = 360;
    player.vx = lerp(player.vx, mx * moveSpeed, dt * 12);
    player.vy = lerp(player.vy, my * moveSpeed, dt * 12);

    player.vx *= 1 - dt * 2.4;
    player.vy *= 1 - dt * 2.4;

    player.x += player.vx * dt;
    player.y += player.vy * dt;

    resolveWallsForCircle(player);
  }

  function fireAttack(player) {
    if (!player.alive) return;
    if (player.shootCd > 0) return;
    if (player.blocking) return;

    player.shootCd = 1 / Math.max(player.rate, 1);

    const dmg = perShotDamage(player);
    const spd = player.speed;
    const r = projectileRadiusForPlayer(player);
    const spread = clamp((Math.max(player.rate, 1) / 1000) * 0.05, 0, 0.05);
    const ang = player.aim + (Math.random() * spread * 2 - spread);

    const spawnX = player.x + Math.cos(ang) * (player.r + 6);
    const spawnY = player.y + Math.sin(ang) * (player.r + 6);

    state.bullets.push({
      id: `b_${Date.now()}_${Math.random()}`,
      ownerSocketId: player.id,
      ownerTeam: player.team,
      x: spawnX,
      y: spawnY,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      r,
      dmg,
      boosted: Math.abs(player.dpsMult - 2) < 1e-6,
    });
  }

  function fireBall(player) {
    if (!player.alive) return;
    if (player.ballCd > 0) return;
    if (player.blocking) return;

    const cost = ballManaCostPerShot(player);
    if (player.mana <= 10 || player.mana < cost) return;

    player.mana = Math.max(0, player.mana - cost);
    player.wasSpending = true;
    player.regenDelayT = player.regenDelayAfterSpend;
    player.ballCd = 1 / Math.max(player.rate, 1);

    const spd = player.speed;
    const r = Math.max(8, projectileRadiusForPlayer(player) + 6);
    const dmg = perShotDamage(player) * DEFAULTS.ballFactor;

    state.balls.push({
      id: `ball_${Date.now()}_${Math.random()}`,
      ownerSocketId: player.id,
      ownerTeam: player.team,
      x: player.x + Math.cos(player.aim) * (player.r + 10),
      y: player.y + Math.sin(player.aim) * (player.r + 10),
      vx: Math.cos(player.aim) * spd,
      vy: Math.sin(player.aim) * spd,
      r,
      dmg,
      life: DEFAULTS.ballLife,
    });
  }

  function fireMolotov(player) {
    if (!player.alive) return;
    if (player.moloCd > 0) return;

    player.moloCd = DEFAULTS.moloCd;
    const spd = Math.max(1, DEFAULTS.moloSpeed);

    state.molotovs.push({
      id: `molo_${Date.now()}_${Math.random()}`,
      ownerSocketId: player.id,
      ownerTeam: player.team,
      x: player.x + Math.cos(player.aim) * (player.r + 10),
      y: player.y + Math.sin(player.aim) * (player.r + 10),
      vx: Math.cos(player.aim) * spd,
      vy: Math.sin(player.aim) * spd,
      r: 10,
      spin: (Math.random() * 12) - 6,
    });
  }

  function triggerKnives(player, enemy) {
    if (!player.alive) return;
    if (player.knifeCd > 0) return;

    player.knifeCd = DEFAULTS.knifeCd;
    state.knifeBursts.push({
      id: `knife_${Date.now()}_${Math.random()}`,
      ownerSocketId: player.id,
      x: player.x,
      y: player.y,
      t: 0.22,
      max: 0.22,
      radius: DEFAULTS.knifeDist,
    });

    if (
      enemy.alive &&
      dist(player.x, player.y, enemy.x, enemy.y) <= DEFAULTS.knifeDist &&
      hasLineOfSight(player.x, player.y, enemy.x, enemy.y)
    ) {
      hitPlayer(enemy, player, DEFAULTS.knifeDamage);
    }
  }

  function fireSniper(player, enemy) {
    if (!player.alive) return;
    if (player.blocking) return;
    if (player.mana < DEFAULTS.sniperCost) return;

    player.mana = Math.max(0, player.mana - DEFAULTS.sniperCost);
    player.wasSpending = true;
    player.regenDelayT = player.regenDelayAfterSpend;

    const sx = player.x;
    const sy = player.y;
    const end = raycastBeamEnd(sx, sy, player.aim, 5000);
    let hit = false;

    if (enemy.alive) {
      const along =
        (enemy.x - sx) * Math.cos(player.aim) +
        (enemy.y - sy) * Math.sin(player.aim);
      const beamLen = dist(sx, sy, end.x, end.y);
      const d = pointToSegmentDistance(enemy.x, enemy.y, sx, sy, end.x, end.y);

      if (along >= 0 && along <= beamLen + enemy.r && d <= enemy.r + 8) {
        hitPlayer(enemy, player, DEFAULTS.sniperDamage);
        hit = true;
      }
    }

    state.sniperBeams.push({
      id: `sniper_${Date.now()}_${Math.random()}`,
      x1: sx,
      y1: sy,
      x2: end.x,
      y2: end.y,
      t: 0.16,
      max: 0.16,
      hit,
      ownerTeam: player.team,
    });
  }

  function throwGrenade(player, targetX, targetY) {
    if (!player.alive) return;
    if (player.grenCd > 0) return;

    player.grenCd = DEFAULTS.grenCd;

    const tx = clamp(targetX, 0, ARENA.w);
    const ty = clamp(targetY, 0, ARENA.h);
    const dx = tx - player.x;
    const dy = ty - player.y;
    const d = Math.hypot(dx, dy) || 1;
    const spd = Math.max(1, DEFAULTS.grenSpeed);

    state.grenades.push({
      id: `gren_${Date.now()}_${Math.random()}`,
      ownerSocketId: player.id,
      ownerTeam: player.team,
      x: player.x,
      y: player.y,
      vx: (dx / d) * spd,
      vy: (dy / d) * spd,
      tx,
      ty,
      r: 9,
      t: d / spd,
    });
  }

  function explodeGrenade(grenade) {
    const attacker = getPlayer(grenade.ownerSocketId);
    const enemy = getPlayer(getEnemySocketId(grenade.ownerSocketId));
    if (!attacker || !enemy || !enemy.alive) return;

    const d = dist(grenade.x, grenade.y, enemy.x, enemy.y);
    if (d <= DEFAULTS.grenRadius) {
      const t = 1 - d / DEFAULTS.grenRadius;
      const dmg = DEFAULTS.grenDamage * clamp(t, 0, 1);
      if (dmg > 0) {
        hitPlayer(enemy, attacker, dmg);
      }
    }
  }

  function updateBullets(dt) {
    for (let i = state.bullets.length - 1; i >= 0; i--) {
      const b = state.bullets[i];
      const attacker = getPlayer(b.ownerSocketId);
      const enemy = getPlayer(getEnemySocketId(b.ownerSocketId));

      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.x < 0 || b.y < 0 || b.x > ARENA.w || b.y > ARENA.h) {
        state.bullets.splice(i, 1);
        continue;
      }

      let wallHit = false;
      for (const wall of require("./shared").WALLS) {
        if (bulletHitsRect(b, wall)) {
          wallHit = true;
          break;
        }
      }
      if (wallHit) {
        state.bullets.splice(i, 1);
        continue;
      }

      if (attacker && enemy && enemy.alive && dist(b.x, b.y, enemy.x, enemy.y) < b.r + enemy.r) {
        hitPlayer(enemy, attacker, b.dmg);
        state.bullets.splice(i, 1);
      }
    }
  }

  function updateBalls(dt) {
    for (let i = state.balls.length - 1; i >= 0; i--) {
      const b = state.balls[i];
      const attacker = getPlayer(b.ownerSocketId);
      const enemy = getPlayer(getEnemySocketId(b.ownerSocketId));

      b.life -= dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      if (b.x - b.r < 0) {
        b.x = b.r;
        b.vx *= -1;
      }
      if (b.x + b.r > ARENA.w) {
        b.x = ARENA.w - b.r;
        b.vx *= -1;
      }
      if (b.y - b.r < 0) {
        b.y = b.r;
        b.vy *= -1;
      }
      if (b.y + b.r > ARENA.h) {
        b.y = ARENA.h - b.r;
        b.vy *= -1;
      }

      for (const wall of require("./shared").WALLS) {
        if (bulletHitsRect(b, wall)) {
          reflectOnRect(b, wall);
          break;
        }
      }

      if (attacker && enemy && enemy.alive && dist(b.x, b.y, enemy.x, enemy.y) < b.r + enemy.r) {
        hitPlayer(enemy, attacker, b.dmg);
        state.balls.splice(i, 1);
        continue;
      }

      if (b.life <= 0) {
        state.balls.splice(i, 1);
      }
    }
  }

  function updateMolotovs(dt) {
    for (let i = state.molotovs.length - 1; i >= 0; i--) {
      const m = state.molotovs[i];
      const attacker = getPlayer(m.ownerSocketId);
      const enemy = getPlayer(getEnemySocketId(m.ownerSocketId));

      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.spin += dt * 4.5;

      if (m.x < 0 || m.y < 0 || m.x > ARENA.w || m.y > ARENA.h) {
        state.molotovs.splice(i, 1);
        continue;
      }

      let wallHit = false;
      for (const wall of require("./shared").WALLS) {
        const cx = clamp(m.x, wall.x, wall.x + wall.w);
        const cy = clamp(m.y, wall.y, wall.y + wall.h);
        const dx = m.x - cx;
        const dy = m.y - cy;
        if (dx * dx + dy * dy < m.r * m.r) {
          wallHit = true;
          break;
        }
      }
      if (wallHit) {
        state.molotovs.splice(i, 1);
        continue;
      }

      if (attacker && enemy && enemy.alive && dist(m.x, m.y, enemy.x, enemy.y) <= enemy.r + m.r) {
        applyBurn(enemy, DEFAULTS.moloBurnDps, DEFAULTS.moloBurnDuration);
        state.molotovs.splice(i, 1);
      }
    }
  }

  function updateGrenades(dt) {
    for (let i = state.grenades.length - 1; i >= 0; i--) {
      const g = state.grenades[i];
      const step = Math.min(dt, g.t);
      g.x += g.vx * step;
      g.y += g.vy * step;
      g.t -= step;

      if (g.t <= 0) {
        g.x = g.tx;
        g.y = g.ty;
        explodeGrenade(g);
        state.grenades.splice(i, 1);
      }
    }
  }

  function updateKnifeBursts(dt) {
    for (let i = state.knifeBursts.length - 1; i >= 0; i--) {
      const k = state.knifeBursts[i];
      k.t -= dt;
      if (k.t <= 0) state.knifeBursts.splice(i, 1);
    }
  }

  function updateSniperBeams(dt) {
    for (let i = state.sniperBeams.length - 1; i >= 0; i--) {
      const beam = state.sniperBeams[i];
      beam.t -= dt;
      if (beam.t <= 0) state.sniperBeams.splice(i, 1);
    }
  }

  function updateFlags(dt) {
    if (!DEFAULTS.ctf.enabled) return;

    for (const team of ["p1", "p2"]) {
      const flag = state.flags[team];
      flag.cooldowns.p1 = Math.max(0, flag.cooldowns.p1 - dt);
      flag.cooldowns.p2 = Math.max(0, flag.cooldowns.p2 - dt);

      if (flag.carrier) {
        const carrierSocketId = flag.carrier === "p1" ? player1SocketId : player2SocketId;
        const carrier = players[carrierSocketId];
        if (carrier) {
          flag.x = carrier.x;
          flag.y = carrier.y;
        }
      }
    }

    for (const team of ["p1", "p2"]) {
      const flag = state.flags[team];
      const ownerTeam = team;
      const enemyTeam = team === "p1" ? "p2" : "p1";
      const owner = ownerTeam === "p1" ? players[player1SocketId] : players[player2SocketId];
      const enemy = enemyTeam === "p1" ? players[player1SocketId] : players[player2SocketId];

      if (flag.carrier) continue;

      if (flag.dropped && owner.alive && dist(owner.x, owner.y, flag.x, flag.y) <= owner.r + DEFAULTS.ctf.pickupRadius) {
        resetFlagHome(team);
        continue;
      }

      if (enemy.alive && flag.cooldowns[enemyTeam] <= 0 && dist(enemy.x, enemy.y, flag.x, flag.y) <= enemy.r + DEFAULTS.ctf.pickupRadius) {
        pickupFlag(enemyTeam, team);
      }
    }

    for (const carrierTeam of ["p1", "p2"]) {
      const enemyFlag = state.flags[carrierTeam === "p1" ? "p2" : "p1"];
      if (enemyFlag.carrier !== carrierTeam) continue;

      const base = FLAG_BASES[carrierTeam];
      const carrier = carrierTeam === "p1" ? players[player1SocketId] : players[player2SocketId];

      if (carrier.alive && dist(carrier.x, carrier.y, base.x, base.y) <= DEFAULTS.ctf.baseRadius) {
        state.ended = true;
        state.winner = carrier.id;
        io.to(roomId).emit("matchEnded", { winnerSocketId: state.winner });
      }
    }
  }

  function updateInputEdgeMemory(input) {
    input._prevDashPressed = input.dashPressed;
    input._prevTeleportPressed = input.teleportPressed;
    input._prevTimePressed = input.timePressed;
    input._prevSizeBoostTogglePressed = input.sizeBoostTogglePressed;
    input._prevGrenadePressed = input.grenadePressed;
    input._prevKnifePressed = input.knifePressed;
    input._prevSniperPressed = input.sniperPressed;
    input._prevMolotovPressed = input.molotovPressed;
  }

  function setInput(socketId, incoming) {
    const input = getInput(socketId);
    const player = getPlayer(socketId);
    if (!input || !player || state.ended) return;

    input.up = !!incoming.up;
    input.down = !!incoming.down;
    input.left = !!incoming.left;
    input.right = !!incoming.right;

    input.aim = Number.isFinite(incoming.aim) ? incoming.aim : input.aim;
    input.fire = !!incoming.fire;
    input.block = !!incoming.block;
    input.ball = !!incoming.ball;

    input.dashPressed = !!incoming.dashPressed;
    input.teleportPressed = !!incoming.teleportPressed;
    input.teleportX = Number.isFinite(incoming.teleportX) ? incoming.teleportX : input.teleportX;
    input.teleportY = Number.isFinite(incoming.teleportY) ? incoming.teleportY : input.teleportY;

    input.timePressed = !!incoming.timePressed;
    input.sizeBoostTogglePressed = !!incoming.sizeBoostTogglePressed;

    input.grenadePressed = !!incoming.grenadePressed;
    input.grenadeX = Number.isFinite(incoming.grenadeX) ? incoming.grenadeX : input.grenadeX;
    input.grenadeY = Number.isFinite(incoming.grenadeY) ? incoming.grenadeY : input.grenadeY;

    input.knifePressed = !!incoming.knifePressed;
    input.sniperPressed = !!incoming.sniperPressed;
    input.molotovPressed = !!incoming.molotovPressed;

    if (Number.isFinite(incoming.rate)) {
      player.rate = clamp(Math.round(incoming.rate), 1, 1000);
    }
    if (Number.isFinite(incoming.speed)) {
      player.speed = clamp(Math.round(incoming.speed), 1, 20000);
    }
    if (Number.isFinite(incoming.dpsMult)) {
      player.dpsMult = clamp(Math.round(incoming.dpsMult * 100) / 100, 1, 2);
    }
  }

  function tick() {
    if (state.ended) return;

    const now = Date.now();
    const dt = clamp((now - lastTick) / 1000, 0, 0.05);
    lastTick = now;

    for (const socketId of [player1SocketId, player2SocketId]) {
      const player = getPlayer(socketId);
      const enemy = getPlayer(getEnemySocketId(socketId));
      const input = getInput(socketId);

      if (!player || !enemy || !input) continue;

      updateStatus(player, dt);
      updateCooldowns(player, dt);
      updateAim(player, input);
      updateOneShotToggles(player, input);
      updateTeleport(player, input, enemy, dt);
      updateBlock(player, input, dt);
      dashPlayer(player, input);
      updateMovement(player, input, dt);

      const spending =
        !!input.fire &&
        !player.blocking &&
        player.alive &&
        player.mana > 10 &&
        player.tpT <= 0;

      updateMana(player, dt, spending);

      const molotovEdge = input.molotovPressed && !input._prevMolotovPressed;
      const knifeEdge = input.knifePressed && !input._prevKnifePressed;
      const sniperEdge = input.sniperPressed && !input._prevSniperPressed;
      const grenadeEdge = input.grenadePressed && !input._prevGrenadePressed;

      if (spending) {
        fireAttack(player);
      }

      if (input.ball && player.alive && !player.blocking && player.tpT <= 0) {
        fireBall(player);
      }

      if (molotovEdge) {
        fireMolotov(player);
      }

      if (knifeEdge) {
        triggerKnives(player, enemy);
      }

      if (sniperEdge) {
        fireSniper(player, enemy);
      }

      if (grenadeEdge) {
        throwGrenade(player, input.grenadeX, input.grenadeY);
      }

      updateInputEdgeMemory(input);
    }

    updateBullets(dt);
    updateBalls(dt);
    updateMolotovs(dt);
    updateGrenades(dt);
    updateKnifeBursts(dt);
    updateSniperBeams(dt);
    updateFlags(dt);

    const p1 = players[player1SocketId];
    const p2 = players[player2SocketId];

    if (!state.ended && p1 && p2) {
      if (!p1.alive || !p2.alive) {
        state.ended = true;
        state.winner = p1.alive ? player1SocketId : player2SocketId;
        io.to(roomId).emit("matchEnded", { winnerSocketId: state.winner });
      }
    }

    emitSnapshot();
  }

  function getSnapshot() {
    return {
      roomId,
      serverTime: Date.now(),
      players: {
        [player1SocketId]: clonePublicPlayer(players[player1SocketId], inputs[player1SocketId]),
        [player2SocketId]: clonePublicPlayer(players[player2SocketId], inputs[player2SocketId]),
      },
      bullets: state.bullets.map((b) => ({ ...b })),
      balls: state.balls.map((b) => ({ ...b })),
      molotovs: state.molotovs.map((m) => ({ ...m })),
      grenades: state.grenades.map((g) => ({ ...g })),
      sniperBeams: state.sniperBeams.map((s) => ({ ...s })),
      knifeBursts: state.knifeBursts.map((k) => ({ ...k })),
      flags: {
        p1: { ...state.flags.p1, cooldowns: { ...state.flags.p1.cooldowns } },
        p2: { ...state.flags.p2, cooldowns: { ...state.flags.p2.cooldowns } },
      },
      winner: state.winner,
    };
  }

  function emitSnapshot() {
    io.to(roomId).emit("worldSnapshot", getSnapshot());
  }

  function getMatchFoundPayload(forSocketId) {
    const enemySocketId = getEnemySocketId(forSocketId);
    return {
      roomId,
      you: clonePublicPlayer(players[forSocketId], inputs[forSocketId]),
      enemy: clonePublicPlayer(players[enemySocketId], inputs[enemySocketId]),
    };
  }

  function start() {
    if (interval) return;
    lastTick = Date.now();
    interval = setInterval(tick, SERVER_TICK_MS);
  }

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
    state.ended = true;
  }

  function onDisconnect() {
    if (state.ended) return;
    io.to(roomId).emit("opponentLeft");
    stop();
  }

  return {
    roomId,
    players,
    inputs,
    state,
    start,
    stop,
    setInput,
    getSnapshot,
    getMatchFoundPayload,
    onDisconnect,
  };
}

module.exports = {
  createServerGame,
};
