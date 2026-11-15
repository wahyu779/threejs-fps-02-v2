// tactics.js — criterion 3: sites, hearing, smoke, sniper, pre-aim.
// One job: the tactical layer — three rotating bomb sites, named callouts,
// a hearing bus with wall muffling, smoke clouds, the sixth weapon (scoped
// sniper), and grenade bounce physics. Pure logic, no DOM, unit-tested
// from node. Site geometry lives in map.js: A warehouse, B dock office,
// C east dock ("C Dock", 30, 8) — change it there and rotation, callouts,
// routing and plant checks all follow.
import { SITE_A, SITE_B, SITE_C, CALLOUTS as MAP_CALLOUTS, calloutAt as mapCalloutAt, hasLineOfSight, isBlockedPoint } from './map.js';
import { WEAPONS } from './weapons.js';

// Three rotating bomb sites: one live per round, A -> B -> C -> A.
// Attackers plant on the live site; defenders hold around it.
export const SITES = [
  { id: 'A', x: SITE_A.x, z: SITE_A.z, r: SITE_A.r },
  { id: 'B', x: SITE_B.x, z: SITE_B.z, r: SITE_B.r },
  { id: 'C', x: SITE_C.x, z: SITE_C.z, r: SITE_C.r },
];
export function siteById(id) { for (const s of SITES) if (s.id === id) return s; return SITES[0]; }
export function activeSiteForRound(round) { return SITES[((round - 1) % 3 + 3) % 3].id; }
export function siteAt(x, z) {
  for (const s of SITES) { const dx = x - s.x, dz = z - s.z; if (dx * dx + dz * dz <= s.r * s.r) return s.id; }
  return null;
}

// Callouts: the 21 map names (map.js is the single authority). This
// calloutAt always resolves: the map name in range, else the nearest zone overall.
export const CALLOUTS = MAP_CALLOUTS;
export function calloutAt(x, z) {
  const near = mapCalloutAt(x, z);
  if (near) return near;
  let best = MAP_CALLOUTS[0], bestD = Infinity;
  for (const c of MAP_CALLOUTS) { const d = (x - c[1]) ** 2 + (z - c[2]) ** 2; if (d < bestD) { bestD = d; best = c; } }
  return best[0];
}

// Hearing bus: bots hear shots (25 m), footsteps (13 m, 6 m crouched)
// and reloads (18 m). A wall between listener and source muffles the sound.
export const HEAR_RANGES = { shot: 25, footstep: 13, reload: 18 };
export const MUFFLE_FACTOR = 0.55;
export const QUIET_FOOTSTEP_RANGE = 6;
export function hearCheck(lx, lz, ex, ez, kind, opts) {
  let range = HEAR_RANGES[kind] || 10;
  if (kind === 'footstep' && opts && opts.quiet) range = QUIET_FOOTSTEP_RANGE;
  const d = Math.hypot(ex - lx, ez - lz);
  if (d > range) return null;
  const muffled = !hasLineOfSight(lx, lz, ex, ez);
  if (muffled && d > range * MUFFLE_FACTOR) return null;
  return { heard: true, muffled, range };
}

// Smoke grenades: a cloud blocks sight through it for 14 s. State lives
// here so bots and the main loop share it.
export const SMOKE_GRENADE = { name: 'Smoke Grenade', price: 250, radius: 4.5, duration: 14 };
const _smokes = []; // {x, z, t0} on the game clock
export function addSmoke(x, z, now) { _smokes.push({ x, z, t0: now }); return _smokes[_smokes.length - 1]; }
export function tickSmoke(now) {
  for (let i = _smokes.length - 1; i >= 0; i--) if (now - _smokes[i].t0 >= SMOKE_GRENADE.duration) _smokes.splice(i, 1);
  return _smokes.length;
}
export function smokeClouds() { return _smokes; }
export function clearSmokes() { _smokes.length = 0; }
export function isSmoked(x, z, now) {
  for (const s of _smokes) {
    if (now - s.t0 >= SMOKE_GRENADE.duration) continue;
    const dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz <= SMOKE_GRENADE.radius * SMOKE_GRENADE.radius) return true;
  }
  return false;
}
export function segmentSmoked(x0, z0, x1, z1, now) { // any point of the segment in a live cloud?
  const d = Math.hypot(x1 - x0, z1 - z0), steps = Math.max(1, Math.ceil(d));
  for (let i = 0; i <= steps; i++) { const t = i / steps; if (isSmoked(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, now)) return true; }
  return false;
}

// Grenade bounce: one fixed step — gravity, floor bounce (restitution
// 0.45, rolls to a stop below 2 m/s vertical), wall bounce (reflect the blocked axis at 0.4).
export function stepGrenade(g, dt) {
  g.vy -= 12 * dt;
  const nx = g.x + g.vx * dt, nz = g.z + g.vz * dt;
  if (isBlockedPoint(nx, g.z)) g.vx = -g.vx * 0.4; else g.x = nx;
  if (isBlockedPoint(g.x, nz)) g.vz = -g.vz * 0.4; else g.z = nz;
  g.y += g.vy * dt;
  if (g.y <= 0.12) {
    g.y = 0.12;
    if (Math.abs(g.vy) > 2) g.vy = -g.vy * 0.45; else { g.vy = 0; g.vx *= 0.6; g.vz *= 0.6; }
  }
  return g;
}

// Sixth weapon: scoped sniper, registered into the shared WEAPONS table at
// import time so fireHitscan, the buy menu and bot buying all see it
// without touching weapons.js. 110 damage, headshot x4, slow bolt (40 rpm),
// punishing spread on the move, 2.4x scope (zoom keys off scoped:true /
// zoomFov). Kill reward is low ($100).
export const SNIPER = {
  name: 'Sniper Pelabuhan', price: 4750, damage: 110, headMult: 4,
  rpm: 40, mag: 5, reserve: 15, auto: false, pellets: 1,
  spreadBase: 0.001, spreadMove: 0.05, spreadAir: 0.08, spreadCrouch: 0.0005,
  bloom: 0.02, recover: 0.05, recoil: [[0.09, 0.0]],
  range: 150, tracer: 0xffc46a, scoped: true, zoomFov: 2.4,
};
WEAPONS.sniper = SNIPER;
