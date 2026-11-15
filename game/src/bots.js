// bots.js — the nine AI fighters of Pelabuhan Senja v2 (4 allies, 5 foes).
// One job: decide what each bot does every fixed step — where to walk,
// when to shoot, and how to fight a duel.
//
// What v1 got wrong and this fixes, all in this file:
//   * Shooting was a dice roll. Here every bot shot is fireHitscan() from
//     weapons.js — the same ray-against-spheres the player fires. A bot
//     kill means a ray really crossed a body.
//   * Pathing was BFS waypoints in 3v3. Here it is A* over the map grid
//     with line-of-sight smoothing, in a 5v5.
//   * Bots stood still in duels. Here a bot that sees an enemy strafes:
//     it runs sideways, flipping direction every 0.4-0.9 s (timestamped
//     strafeUntil, deterministic flip — never a coin re-roll that can
//     repeat the same direction), or immediately when a wall probe
//     0.7 m ahead in the strafe direction hits a blocked cell, while
//     firing. Below 30 HP it strafes faster and blends a retreat step
//     away from the foe.
//   * Bots were deaf. Here a gunshot within 25 m marks the shooter's spot
//     for 2 s — bots investigate, and the minimap shows the red blip.
//
// Roles: Senja (attackers) pick a site, walk it by A*, plant when the site
// is clear. Bayang (defenders) hold a site or a mid spot, rotate when the
// bomb is planted, defuse when the site is clear.
import { findPath, hasLineOfSight, isBlockedPoint, SITE_A, SITE_B, HOLD_SPOTS } from './map.js';
import { makeBody, stepMove, stepJump, WALK_SPEED, CROUCH_SPEED } from './mover.js';
import { makeGunState, tickGun, currentSpread, fireHitscan, reloadGun, WEAPONS } from './weapons.js';
import { makeWallet, buyWeapon, buyArmor, buyGrenade } from './economy.js';
import { range, pick, clamp } from './rng.js';

export const BOT_NAMES_SENJA = ['Rani', 'Dimas', 'Sari', 'Bimo'];
export const BOT_NAMES_BAYANG = ['Kala', 'Wira', 'Nara', 'Gilang', 'Tara'];
const LOADOUTS = ['rifle', 'rifle', 'shotgun', 'marksman', 'rifle'];

export function makeBot(team, name, spawn, rng, idx) {
  const bot = {
    team, name, alive: true, isPlayer: false,
    body: makeBody(spawn.x, spawn.z),
    hp: 100,
    gun: makeGunState(LOADOUTS[idx % LOADOUTS.length]),
    wallet: makeWallet(),
    grenades: 0, hasBomb: false,
    planting: 0, defusing: 0,
    kills: 0, deaths: 0,
    // AI state
    role: team === 'senja' ? 'attack' : 'defend',
    site: team === 'senja' ? (idx % 2 === 0 ? 'A' : 'B') : null,
    hold: team === 'bayang' ? HOLD_SPOTS[idx % HOLD_SPOTS.length] : null,
    path: null, pathI: 0, repathT: 0,
    target: null,           // fighter currently visible
    lastSeen: null,         // {x, z, t} last known enemy position
    heard: null,            // {x, z, t} last heard gunshot
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
  bot.strafeDir = 1; bot.strafeUntil = 0; bot.strafeWallT = 0;
  bot.burstLeft = 0; bot.burstT = 0;
  bot.gun = makeGunState(bot.gun.weaponId);
  bot.grenades = 0; bot.hasBomb = false;
}

// Buy phase: bots spend sensibly — rifle first, kevlar when they can,
// a grenade when rich. Keeps the economy visible in the match.
export function botBuy(bot) {
  const w = bot.wallet;
  if (w.money >= 2700 && bot.gun.weaponId !== 'rifle') {
    if (buyWeapon(w, 'rifle').ok) bot.gun = makeGunState('rifle');
  }
  if (w.money >= 650) buyArmor(w);
  if (w.money >= 300 && bot.grenades === 0) {
    if (buyGrenade(w).ok) bot.grenades = 1;
  }
}

// Can this bot see that fighter? Range 45 m, 100-degree cone, grid LOS.
export function canSee(bot, foe) {
  if (!foe.alive) return false;
  const dx = foe.body.pos.x - bot.body.pos.x;
  const dz = foe.body.pos.z - bot.body.pos.z;
  const d = Math.hypot(dx, dz);
  if (d > 45) return false;
  const fx = -Math.sin(bot.body.yaw), fz = -Math.cos(bot.body.yaw);
  const dot = (dx * fx + dz * fz) / (d || 1);
  if (dot < 0.35 && d > 4) return false; // outside the vision cone
  return hasLineOfSight(bot.body.pos.x, bot.body.pos.z, foe.body.pos.x, foe.body.pos.z);
}

// Every bot hears every shot within 25 m (main.js calls this on fire).
export function hearShot(bot, x, z, now) {
  if (!bot.alive) return;
  const dx = x - bot.body.pos.x, dz = z - bot.body.pos.z;
  if (dx * dx + dz * dz < 25 * 25) bot.heard = { x, z, t: now };
}

// Where this bot wants to be right now.
function pickDestination(bot, bomb, now) {
  if (bot.team === 'bayang') {
    if (bomb.state === 'planted') {
      const site = bomb.site === 'A' ? SITE_A : SITE_B;
      return { x: site.x, z: site.z };
    }
    if (bot.heard && now - bot.heard.t < 2) return { x: bot.heard.x, z: bot.heard.z };
    if (bot.lastSeen && now - bot.lastSeen.t < 3) return { x: bot.lastSeen.x, z: bot.lastSeen.z };
    return bot.hold;
  }
  // Senja: walk the assigned site; if the bomb is planted, hold near it.
  if (bomb.state === 'planted') {
    const site = bomb.site === 'A' ? SITE_A : SITE_B;
    return { x: site.x + range(bot.rng, -4, 4), z: site.z + range(bot.rng, -4, 4) };
  }
  if (bot.lastSeen && now - bot.lastSeen.t < 3) return { x: bot.lastSeen.x, z: bot.lastSeen.z };
  const site = bot.site === 'A' ? SITE_A : SITE_B;
  return { x: site.x + range(bot.rng, -3, 3), z: site.z + range(bot.rng, -3, 3) };
}

// Aim direction from bot to a point, with error. Returns via out {x,y,z}.
function aimAt(bot, tx, ty, tz, err, out) {
  const ox = bot.body.pos.x, oy = 1.45 + bot.body.y, oz = bot.body.pos.z;
  let dx = tx - ox, dy = ty - oy, dz = tz - oz;
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len; dy /= len; dz /= len;
  // Jitter the aim by the error cone (uniform disc, deterministic rng).
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
// hit, head, target} for the main loop to render and sound.
export function stepBot(bot, foes, bomb, now, dt, events, stats) {
  events.fired = false; events.hit = false;
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
    if (canSee(bot, f)) {
      const d = Math.hypot(f.body.pos.x - b.pos.x, f.body.pos.z - b.pos.z);
      if (d < bestD) { bestD = d; bot.target = f; }
    }
  }
  if (bot.target) {
    bot.lastSeen = { x: bot.target.body.pos.x, z: bot.target.body.pos.z, t: now };
  }

  // --- combat: strafe + burst fire -------------------------------------
  // STRAFE state machine (Lane S). Duel = musuh terlihat + dalam 32 m.
  // strafeUntil adalah TIMESTAMP (kontrak): arah dibalik secara
  // deterministik (strafeDir *= -1) saat now mencapai strafeUntil, atau
  // segera saat probe dinding 0.7 m di depan arah strafe mengenai sel
  // blocked. Random hanya untuk arah awal + durasi 0.4-0.9 dtk — tidak
  // pernah untuk hit/miss (semua tembakan lewat fireHitscan di bawah).
  const inDuel = !!bot.target && bestD < 32;
  if (inDuel) {
    // Face the target first — lateral axis depends on yaw.
    const dx = bot.target.body.pos.x - b.pos.x;
    const dz = bot.target.body.pos.z - b.pos.z;
    b.yaw = Math.atan2(-dx, -dz);
    if (!bot.strafing) {
      // Duel entry: arah awal acak, interval pertama 0.4-0.9 dtk.
      bot.strafing = true;
      bot.strafeDir = bot.rng() < 0.5 ? -1 : 1;
      bot.strafeUntil = now + range(bot.rng, 0.4, 0.9);
    } else if (now >= bot.strafeUntil) {
      // Timer habis: BALIK arah (bukan lempar koin — koin bisa mengulang
      // arah yang sama dan bot diam di tempat selama satu interval).
      bot.strafeDir *= -1;
      bot.strafeUntil = now + range(bot.rng, 0.4, 0.9);
    } else {
      // Probe dinding: 0.7 m di depan arah strafe. Kalau mentok, balik
      // segera supaya bot tidak menempel dinding satu interval penuh.
      // Cooldown 0.25 dtk (strafeWallT) mencegah ping-pong tiap tick
      // saat KEDUA arah terhalang (lorong sempit / sudut).
      const lx = Math.cos(b.yaw) * bot.strafeDir;
      const lz = -Math.sin(b.yaw) * bot.strafeDir;
      const px = b.pos.x + lx * 0.7, pz = b.pos.z + lz * 0.7;
      if (now - bot.strafeWallT > 0.25 && isBlockedPoint(px, pz)) {
        bot.strafeDir *= -1;
        bot.strafeUntil = now + range(bot.rng, 0.4, 0.9);
        bot.strafeWallT = now;
      }
    }
    // Lateral wish (dihitung ulang setelah flip di atas, bila ada).
    const fx = Math.cos(b.yaw) * bot.strafeDir;
    const fz = -Math.sin(b.yaw) * bot.strafeDir;
    // Low HP (<30): strafe lebih cepat + blend mundur menjauhi musuh.
    // stepMove menormalisasi wish vector-nya sendiri.
    let wishX = fx, wishZ = fz;
    let strafeSpeed = WALK_SPEED * 0.62;
    if (bot.hp < 30) {
      const ad = Math.hypot(dx, dz) || 1;
      wishX = fx + (-dx / ad) * 0.6;
      wishZ = fz + (-dz / ad) * 0.6;
      strafeSpeed *= 1.3;
    }
    stepMove(b, wishX, wishZ, strafeSpeed, dt);
    // Burst fire: 3-5 round bursts with pauses, aim error grows with range.
    bot.burstT -= dt;
    if (bot.burstLeft <= 0 && bot.burstT <= 0 && bot.gun.cooldown <= 0) {
      bot.burstLeft = 3 + Math.floor(bot.rng() * 3);
      bot.burstT = range(bot.rng, 0.5, 1.0);
    }
    if (bot.burstLeft > 0 && bot.gun.cooldown <= 0) {
      if (bot.gun.ammo <= 0) { reloadGun(bot.gun); }
      else {
        bot.burstLeft--;
        const moving = true;
        bot.gun._spread = currentSpread(bot.gun, moving, b.airborne, false);
        _origin.x = b.pos.x; _origin.y = 1.45 + b.y; _origin.z = b.pos.z;
        const aimY = bot.rng() < 0.3 ? 1.52 : 1.05; // sometimes head height
        // Aim error stays inside the torso's angular size at duel range:
        // a bot that can see a chest at 20 m should hit it about half
        // the time, before spread and the target's strafe are counted.
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
            // Tracer endpoint from the pellet's true fired direction
            // (aim + recoil + spread), not the pre-recoil aim.
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

  // --- navigation: A* path to the destination ---------------------------
  const dest = pickDestination(bot, bomb, now);
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
        // Face along the path and walk it.
        b.yaw = Math.atan2(-wx, -wz);
        stepMove(b, wx / wd, wz / wd, WALK_SPEED, dt);
        // Hop a crate-height step if blocked head-on for a while.
        if (Math.hypot(b.vel.x, b.vel.z) < 0.4) {
          bot.idleT += dt;
          if (bot.idleT > 0.7) { stepJump(b, true, dt); bot.idleT = 0; bot.repathT = 0; }
        } else bot.idleT = 0;
      }
    }
  } else if (bot.target) {
    // Close but not in duel range band: face the enemy, hold ground.
    const tx = bot.target.body.pos.x - b.pos.x;
    const tz = bot.target.body.pos.z - b.pos.z;
    b.yaw = Math.atan2(-tx, -tz);
  } else {
    // At destination: scan — slow yaw sweep for new contacts.
    b.yaw += dt * 0.5;
  }
  // Reload when the magazine is dry and nobody is shooting at us.
  if (bot.gun.ammo === 0) reloadGun(bot.gun);
}

function hitPoint(origin, dir, dist) {
  return { x: origin.x + dir.x * dist, y: origin.y + dir.y * dist, z: origin.z + dir.z * dist };
}
