// bots.js — the nine AI fighters (4 allies, 5 foes).
// One job: decide what each bot does every fixed step — where to walk,
// when to shoot, and how to fight a duel. Every bot shot is fireHitscan()
// from weapons.js — the same ray-against-capsules the player fires, so a
// bot kill means a ray really crossed a body. Pathing is A* over the map
// grid with line-of-sight smoothing, in a 5v5. A bot that sees an enemy
// strafes sideways, flipping direction every 0.4-0.9 s or at once when a
// 0.7 m wall probe ahead hits a blocked cell, while firing. Below 30 HP
// it strafes faster and blends a retreat step. Bots hear: a gunshot
// within 25 m marks the shooter's spot for 2 s — they investigate, and
// the minimap shows the red blip. Senja pick a site, walk it by A*,
// plant when clear; Bayang hold, rotate on a plant, defuse when clear.
import { findPath, hasLineOfSight, isBlockedPoint, HOLD_SPOTS } from './map.js';
import { makeBody, stepMove, stepJump, WALK_SPEED, CROUCH_SPEED } from './mover.js';
import { makeGunState, tickGun, currentSpread, fireHitscan, reloadGun, WEAPONS } from './weapons.js';
import { makeWallet, buyWeapon, buyArmor, buyGrenade, buySmoke, buyHelmet } from './economy.js';
import { siteById, calloutAt, hearCheck, segmentSmoked } from './tactics.js';
import { range, pick, clamp } from './rng.js';

export const BOT_NAMES_SENJA = ['Rani', 'Dimas', 'Sari', 'Bimo'];
export const BOT_NAMES_BAYANG = ['Kala', 'Wira', 'Nara', 'Gilang', 'Tara'];
const LOADOUTS = ['rifle', 'rifle', 'shotgun', 'marksman', 'rifle'];
// Combat role per slot (what the bot BUYS and how it fights): carrier
// rifle + armor (carries the plant); awper sniper/marksman; rifler rifle;
// support shotgun + grenades + smoke; anchor rifle, holds the live site.
const COMBAT_ROLES = {
  senja: ['carrier', 'awper', 'rifler', 'support'],
  bayang: ['awper', 'rifler', 'support', 'rifler', 'anchor'],
};

export function makeBot(team, name, spawn, rng, idx) {
  const bot = {
    team, name, alive: true, isPlayer: false,
    body: makeBody(spawn.x, spawn.z),
    hp: 100,
    gun: makeGunState(LOADOUTS[idx % LOADOUTS.length]),
    wallet: makeWallet(),
    grenades: 0, smokes: 0, hasBomb: false,
    planting: 0, defusing: 0,
    kills: 0, deaths: 0,
    // AI state
    role: team === 'senja' ? 'attack' : 'defend',
    combatRole: COMBAT_ROLES[team][idx % COMBAT_ROLES[team].length],
    idx,
    site: team === 'senja' ? (idx % 2 === 0 ? 'A' : 'B') : null,
    hold: team === 'bayang' ? HOLD_SPOTS[idx % HOLD_SPOTS.length] : null,
    path: null, pathI: 0, repathT: 0,
    target: null,           // fighter currently visible
    lastSeen: null,         // {x, z, t} last known enemy position
    heard: null,            // {x, z, t, kind, callout, muffled} last heard sound
    radioT: 0,              // last radio callout (spam guard, 4 s)
    onRadio: null,          // set by main.js: (text) => feedLine(...)
    preAimYaw: 0,           // yaw of the angle this bot is holding
    peek: null,             // staged peek state {stage, t, dirX, dirZ, ox, oz}
    strafeDir: 1, strafeUntil: 0, strafeWallT: 0, strafing: false,
    aimErr: 0.02,           // radians of aim error, grows with range
    burstLeft: 0, burstT: 0,
    thinkT: 0, idleT: 0,
    shots: 0, hits: 0,     // lifetime accuracy counters (A/B evidence)
    rng,
  };
  bot.body.yaw = Math.atan2(spawn.x, spawn.z); // face the map centre
  return bot;
}

export function resetBot(bot, spawn) {
  bot.body.pos.x = spawn.x; bot.body.pos.z = spawn.z;
  bot.body.vel.x = 0; bot.body.vel.z = 0;
  bot.body.y = 0; bot.body.vy = 0; bot.body.airborne = false;
  bot.hp = 100; bot.alive = true;
  bot.planting = 0; bot.defusing = 0;
  bot.path = null; bot.pathI = 0; bot.target = null;
  bot.lastSeen = null; bot.heard = null; bot.strafing = false;
  bot.peek = null; bot.preAimYaw = 0; bot.radioT = 0;
  bot.strafeDir = 1; bot.strafeUntil = 0; bot.strafeWallT = 0;
  bot.burstLeft = 0; bot.burstT = 0;
  bot.gun = makeGunState(bot.gun.weaponId);
  bot.grenades = 0; bot.smokes = 0; bot.hasBomb = false;
}

// Buy phase: bots buy BY ROLE — awper sniper (or marksman when broke),
// rifler rifle, support shotgun + smoke, carrier/anchor rifle + armor + helmet.
export function botBuy(bot) {
  const w = bot.wallet;
  const role = bot.combatRole;
  const take = (id) => { if (buyWeapon(w, id).ok) bot.gun = makeGunState(id); };
  if (role === 'awper') {
    if (w.money >= 4750 && bot.gun.weaponId !== 'sniper') take('sniper');
    else if (w.money >= 3500 && bot.gun.weaponId !== 'marksman') take('marksman');
    else if (w.money >= 2700 && bot.gun.weaponId !== 'rifle') take('rifle');
  } else if (role === 'support') {
    if (w.money >= 1800 && bot.gun.weaponId !== 'shotgun') take('shotgun');
    else if (w.money >= 2700 && bot.gun.weaponId !== 'rifle') take('rifle');
  } else if (w.money >= 2700 && bot.gun.weaponId !== 'rifle') {
    take('rifle');
  }
  if (w.money >= 650) buyArmor(w);
  if ((role === 'awper' || role === 'carrier') && w.money >= 400) buyHelmet(w);
  if (w.money >= 300 && bot.grenades === 0) {
    if (buyGrenade(w).ok) bot.grenades = 1;
  }
  if ((role === 'support' || role === 'awper') && w.money >= 250 && bot.smokes === 0) {
    if (buySmoke(w).ok) bot.smokes = 1;
  }
}

// Can this bot see that fighter? Range 45 m, 100-degree cone, grid LOS,
// no live smoke cloud on the sightline. now is needed for the smoke check.
export function canSee(bot, foe, now) {
  if (!foe.alive) return false;
  const dx = foe.body.pos.x - bot.body.pos.x;
  const dz = foe.body.pos.z - bot.body.pos.z;
  const d = Math.hypot(dx, dz);
  if (d > 45) return false;
  const fx = -Math.sin(bot.body.yaw), fz = -Math.cos(bot.body.yaw);
  const dot = (dx * fx + dz * fz) / (d || 1);
  if (dot < 0.35 && d > 4) return false; // outside the vision cone
  if (!hasLineOfSight(bot.body.pos.x, bot.body.pos.z, foe.body.pos.x, foe.body.pos.z)) return false;
  if (typeof now === 'number' &&
    segmentSmoked(bot.body.pos.x, bot.body.pos.z, foe.body.pos.x, foe.body.pos.z, now)) return false;
  return true;
}

// Hearing bus: one entry per sound kind. Range + wall muffling come from
// tactics.hearCheck; Senja bots radio the callout (spam-guarded, 4 s).
function hear(bot, x, z, now, kind, opts) {
  if (!bot.alive) return;
  const r = hearCheck(bot.body.pos.x, bot.body.pos.z, x, z, kind, opts);
  if (!r) return;
  const callout = calloutAt(x, z);
  bot.heard = { x, z, t: now, kind, callout, muffled: r.muffled };
  if (bot.team === 'senja' && typeof bot.onRadio === 'function' && now - bot.radioT > 4) {
    bot.radioT = now;
    const what = kind === 'shot' ? 'shots' : kind === 'footstep' ? 'footsteps' : 'reloading';
    bot.onRadio(`${bot.name}: ${what} ${callout}${r.muffled ? ' (muffled)' : ''}`);
  }
}

export function hearShot(bot, x, z, now) {
  hear(bot, x, z, now, 'shot');
}
export function hearFootstep(bot, x, z, now, quiet) {
  hear(bot, x, z, now, 'footstep', { quiet: !!quiet });
}
export function hearReload(bot, x, z, now) {
  hear(bot, x, z, now, 'reload');
}

// Where this bot wants to be right now. attackers = the team planting
// this half (rounds.js); it flips at half-time. Attackers walk the live
// site, recover a dropped bomb, guard a planted one; defenders hold near
// the live site, investigate sounds, retake on a plant.
function pickDestination(bot, bomb, now, attackers) {
  const attacking = bot.team === attackers;
  if (bomb.state === 'planted') {
    const site = siteById(bomb.site);
    if (attacking) return { x: site.x + range(bot.rng, -4, 4), z: site.z + range(bot.rng, -4, 4) };
    return { x: site.x, z: site.z }; // retake
  }
  if (attacking && bomb.state === 'dropped') return { x: bomb.x, z: bomb.z };
  // Only defenders rotate on sound / lost contact: attackers stick to the
// site plan — a footstep must never drag the plant off course.
  if (!attacking) {
    if (bot.heard && now - bot.heard.t < 2) return { x: bot.heard.x, z: bot.heard.z };
    if (bot.lastSeen && now - bot.lastSeen.t < 3) return { x: bot.lastSeen.x, z: bot.lastSeen.z };
  }
  if (attacking) {
    const site = siteById(bomb.activeSite);
    return { x: site.x + range(bot.rng, -3, 3), z: site.z + range(bot.rng, -3, 3) };
  }
  const site = siteById(bomb.activeSite);
  return bot.hold || { x: site.x, z: site.z };
}

function aimAt(bot, tx, ty, tz, err, out) {
  const ox = bot.body.pos.x, oy = 1.45 + bot.body.y, oz = bot.body.pos.z;
  let dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  const a = bot.rng() * Math.PI * 2;
  const r = Math.sqrt(bot.rng()) * err;
  let ux = 0, uy = 1, uz = 0;
  if (Math.abs(dy) > 0.9) { ux = 1; uy = 0; uz = 0; }
  let bx = dy * uz - dz * uy, by = dz * ux - dx * uz, bz = dx * uy - dy * ux;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;
  const cx = dy * bz - dz * by, cy = dz * bx - dx * bz, cz = dx * by - dy * bx;
  out.x = dx + (bx * Math.cos(a) + cx * Math.sin(a)) * r;
  out.y = dy + (by * Math.cos(a) + cy * Math.sin(a)) * r;
  out.z = dz + (bz * Math.cos(a) + cz * Math.sin(a)) * r;
  const ol = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= ol; out.y /= ol; out.z /= ol;
  return out;
}
const _aim = { x: 0, y: 0, z: 0 };
const _origin = { x: 0, y: 0, z: 0 };
const _pelletOut = [];

// One fixed step for one bot. events collects {fired, tracerFrom, tracerTo,
// hit, head, target, reloaded} for the main loop. attackers = the team
// planting this half ('senja' default, flips at half).
export function stepBot(bot, foes, bomb, now, dt, events, stats, attackers) {
  events.fired = false; events.hit = false; events.reloaded = false;
  attackers = attackers || 'senja';
  if (!bot.alive) return;
  const b = bot.body;
  tickGun(bot.gun, dt);
  bot.thinkT -= dt;
  bot.repathT -= dt;

  // --- perception: nearest visible foe --------------------------------
  bot.target = null;
  let bestD = Infinity;
  for (const f of foes) {
    if (!f.alive) continue;
    if (canSee(bot, f, now)) {
      const d = Math.hypot(f.body.pos.x - b.pos.x, f.body.pos.z - b.pos.z);
      if (d < bestD) { bestD = d; bot.target = f; }
    }
  }
  if (bot.target) {
    bot.lastSeen = { x: bot.target.body.pos.x, z: bot.target.body.pos.z, t: now };
    // First sight of a new target: call it out over the radio (H3).
    if (bot._contactTarget !== bot.target) {
      bot._contactTarget = bot.target;
      if (typeof bot.onRadio === 'function') bot.onRadio(`${bot.name}: Contact — ${calloutAt(bot.target.body.pos.x, bot.target.body.pos.z)}`);
    }
  } else bot._contactTarget = null;

  // --- combat: strafe + burst fire ---
// STRAFE state machine. Duel = visible enemy within 32 m. strafeUntil is
// a TIMESTAMP (contract): the direction flips deterministically when now
// reaches strafeUntil, or at once when the 0.7 m wall probe ahead hits a
// blocked cell. Random only for the initial direction + the 0.4-0.9 s
// duration — never for hit/miss (every shot goes through fireHitscan).
  const inDuel = !!bot.target && bestD < 32;
  if (inDuel) {
    const dx = bot.target.body.pos.x - b.pos.x;
    const dz = bot.target.body.pos.z - b.pos.z;
    b.yaw = Math.atan2(-dx, -dz);
    if (!bot.strafing) {
      bot.strafing = true;
      bot.strafeDir = bot.rng() < 0.5 ? -1 : 1;
      bot.strafeUntil = now + range(bot.rng, 0.4, 0.9);
    } else if (now >= bot.strafeUntil) {
      bot.strafeDir *= -1;
      bot.strafeUntil = now + range(bot.rng, 0.4, 0.9);
    } else {
// Wall probe: 0.7 m ahead. On a hit, flip at once so the bot never hugs
// a wall for a full interval. 0.25 s cooldown (strafeWallT) stops
// per-tick ping-pong when BOTH directions are blocked.
      const lx = Math.cos(b.yaw) * bot.strafeDir;
      const lz = -Math.sin(b.yaw) * bot.strafeDir;
      const px = b.pos.x + lx * 0.7, pz = b.pos.z + lz * 0.7;
      if (now - bot.strafeWallT > 0.25 && isBlockedPoint(px, pz)) {
        bot.strafeDir *= -1;
        bot.strafeUntil = now + range(bot.rng, 0.4, 0.9);
        bot.strafeWallT = now;
      }
    }
    const fx = Math.cos(b.yaw) * bot.strafeDir;
    const fz = -Math.sin(b.yaw) * bot.strafeDir;
    let wishX = fx, wishZ = fz;
    let strafeSpeed = WALK_SPEED * 0.62;
    if (bot.hp < 30) {
      const ad = Math.hypot(dx, dz) || 1;
      wishX = fx + (-dx / ad) * 0.6;
      wishZ = fz + (-dz / ad) * 0.6;
      strafeSpeed *= 1.3;
    }
    stepMove(b, wishX, wishZ, strafeSpeed, dt);
    bot.burstT -= dt;
    if (bot.burstLeft <= 0 && bot.burstT <= 0 && bot.gun.cooldown <= 0) {
      bot.burstLeft = 3 + Math.floor(bot.rng() * 3);
      bot.burstT = range(bot.rng, 0.5, 1.0);
    }
    if (bot.burstLeft > 0 && bot.gun.cooldown <= 0) {
      if (bot.gun.ammo <= 0) { if (reloadGun(bot.gun)) events.reloaded = true; }
      else {
        bot.burstLeft--;
        const moving = true;
        bot.gun._spread = currentSpread(bot.gun, moving, b.airborne, false);
        _origin.x = b.pos.x; _origin.y = 1.45 + b.y; _origin.z = b.pos.z;
        const aimY = bot.rng() < 0.3 ? 1.52 : 1.05; // sometimes head height
        // Aim error stays inside the torso's angular size at duel range:
        // a bot that sees a chest at 20 m should hit it about half the time.
        const err = 0.006 + bestD * 0.0004 + bot.gun._spread * 0.3;
        aimAt(bot, bot.target.body.pos.x, aimY, bot.target.body.pos.z, err, _aim);
        fireHitscan(_origin, _aim, bot.gun, bot.rng, bot, foes, _pelletOut);
        bot.shots += _pelletOut.length;
        events.fired = true;
        events.from = { x: _origin.x, y: _origin.y, z: _origin.z };
        for (const r of _pelletOut) {
          if (r.hit) {
            bot.hits++;
            events.hit = true; events.head = r.head; events.target = r.target;
            events.dmg = r.damage; events.to = hitPoint(_origin, (r.dx !== undefined ? { x: r.dx, y: r.dy, z: r.dz } : _aim), r.dist);
            break;
          }
        }
        if (!events.hit && _pelletOut.length) {
          const r0 = _pelletOut[0];
          events.to = hitPoint(_origin, (r0.dx !== undefined ? { x: r0.dx, y: r0.dy, z: r0.dz } : _aim), r0.dist);
        }
        stats.shots += _pelletOut.length;
        if (events.hit) stats.hits++;
      }
    }
    return; // duelling bots do not walk their path this step
  }
  bot.strafing = false;

  // --- staged peek ---
  // A bot that knows where the enemy is (lastSeen < 3 s) but has no line
// of sight edges out in 3 short stages — 0.45 m per stage, 0.22 s hold,
// sight re-checked at each stage — instead of walking blind into the
// angle. A stage that opens the angle clears the peek; three blind
// stages give up and the bot walks to lastSeen.
  let peeking = false;
  if (!bot.target && bot.lastSeen && now - bot.lastSeen.t < 3) {
    const lx = bot.lastSeen.x, lz = bot.lastSeen.z;
    const dSeen = Math.hypot(lx - b.pos.x, lz - b.pos.z);
    if (dSeen < 20 && dSeen > 0.5 && !hasLineOfSight(b.pos.x, b.pos.z, lx, lz)) {
      peeking = true;
      if (!bot.peek) {
        const dl = dSeen || 1;
        bot.peek = { stage: 0, t: 0, dirX: -(lz - b.pos.z) / dl, dirZ: (lx - b.pos.x) / dl,
                     ox: b.pos.x, oz: b.pos.z };
      }
      const pk = bot.peek;
      pk.t += dt;
      b.yaw = Math.atan2(-(lx - b.pos.x), -(lz - b.pos.z));
      if (pk.stage < 3) {
        const want = (pk.stage + 1) * 0.45;
        const moved = Math.hypot(b.pos.x - pk.ox, b.pos.z - pk.oz);
        if (moved < want) {
          stepMove(b, pk.dirX, pk.dirZ, WALK_SPEED * 0.5, dt);
        } else if (pk.t > 0.22) {
          pk.stage++; pk.t = 0;
          if (hasLineOfSight(b.pos.x, b.pos.z, lx, lz)) { bot.peek = null; peeking = false; }
        }
      } else { bot.peek = null; peeking = false; }
    } else bot.peek = null;
  } else bot.peek = null;

  // --- navigation: A* path to the destination ---
  if (!peeking) {
  const dest = pickDestination(bot, bomb, now, attackers);
  const dx = dest.x - b.pos.x, dz = dest.z - b.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > 1.2) {
    if (!bot.path || bot.repathT <= 0 || bot.pathI >= bot.path.length) {
      bot.path = findPath(b.pos.x, b.pos.z, dest.x, dest.z);
      bot.pathI = 0;
      bot.repathT = 2.5;
    }
    if (bot.path && bot.pathI < bot.path.length) {
      const wp = bot.path[bot.pathI];
      const wx = wp.x - b.pos.x, wz = wp.z - b.pos.z;
      const wd = Math.hypot(wx, wz);
      if (wd < 0.9) bot.pathI++;
      else {
        b.yaw = Math.atan2(-wx, -wz);
        stepMove(b, wx / wd, wz / wd, WALK_SPEED, dt);
        if (Math.hypot(b.vel.x, b.vel.z) < 0.4) {
          bot.idleT += dt;
          if (bot.idleT > 0.7) { stepJump(b, true, dt); bot.idleT = 0; bot.repathT = 0; }
        } else bot.idleT = 0;
      }
    }
  } else if (bot.target) {
    const tx = bot.target.body.pos.x - b.pos.x;
    const tz = bot.target.body.pos.z - b.pos.z;
    b.yaw = Math.atan2(-tx, -tz);
  } else {
    const site = siteById(bomb.activeSite);
    bot.preAimYaw = Math.atan2(-(site.x - b.pos.x), -(site.z - b.pos.z)) + Math.sin(now * 0.5 + (bot.idx || 0)) * 0.25;
    b.yaw = bot.preAimYaw;
  }
  }
  if (bot.gun.ammo === 0 && reloadGun(bot.gun)) events.reloaded = true;
}

function hitPoint(origin, dir, dist) {
  return { x: origin.x + dir.x * dist, y: origin.y + dir.y * dist, z: origin.z + dir.z * dist };
}
