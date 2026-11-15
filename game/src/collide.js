// collide.js — 3D AABB collision.
// One job: move a box-bodied fighter through a 3D world — walls with real
// heights, ledges you can step onto, gravity and smooth crouch. Player and
// bots share moveBody, so both sides play by the same physics. rayCapsule
// is the hit test weapons.js uses.
import { WALLS, wallHeight } from './map.js';
import { clamp } from './rng.js';

export const WALK_SPEED = 5.2, CROUCH_SPEED = 2.6;
export const AIR_CONTROL = 0.25, ACCEL = 42, FRICTION = 10;
export const STAND_HEIGHT = 1.7, CROUCH_HEIGHT = 1.15;
export const STAND_EYE = 1.62, CROUCH_EYE = 1.15;
const STEP_UP = 0.5, GRAVITY = 14, JUMP_VY = 5.4; // step-up, gravity, jump

// Wall heights come from map.js wallHeight (one rule for render + collision).

// Step ledges: low pallets (0.45 m, one step-up) and a two-step platform
// (0.45 then 0.9 m — the second step is only climbable from the first),
// all on open ground, clear of walls, spawns, hold spots and sites.
export const STEP_OBSTACLES = [
  { x0: 3, z0: -19, x1: 5, z1: -17, h: 0.45 },
  { x0: -5, z0: 17, x1: -3, z1: 19, h: 0.45 },
  { x0: 13, z0: -9, x1: 15, z1: -7, h: 0.45 },
  { x0: -15, z0: -9, x1: -13, z1: -7, h: 0.45 },
  { x0: -15, z0: -7, x1: -13, z1: -5, h: 0.9 },
];

const _s = [0, 0, 0, 0, 0]; // scratch solid [x0, z0, x1, z1, top]
const NSOLID = WALLS.length + STEP_OBSTACLES.length;
function solidAt(i, out) {
  if (i < WALLS.length) {
    const w = WALLS[i];
    out[0] = w[0]; out[1] = w[1]; out[2] = w[2]; out[3] = w[3]; out[4] = wallHeight(i);
  } else {
    const s = STEP_OBSTACLES[i - WALLS.length];
    out[0] = s.x0; out[1] = s.z0; out[2] = s.x1; out[3] = s.z1; out[4] = s.h;
  }
  return out;
}

// Highest solid top under the footprint at or below the feet (0 = the quay).
function groundUnder(body) {
  const r = body.radius;
  const x0 = body.pos.x - r, x1 = body.pos.x + r, z0 = body.pos.z - r, z1 = body.pos.z + r;
  let g = 0;
  for (let i = 0; i < NSOLID; i++) {
    solidAt(i, _s);
    if (x1 <= _s[0] || x0 >= _s[2] || z1 <= _s[1] || z0 >= _s[3]) continue;
    if (_s[4] <= body.y + 0.05 && _s[4] > g) g = _s[4];
  }
  return g;
}

// Move along one axis (dx or dz is zero). Slides along walls, steps up
// ledges no taller than STEP_UP above the feet, clamps and kills velocity
// on a wall face. False when a wall stopped this axis. Walls are checked
// before steps, so a taller wall always blocks before a step is taken.
function moveAxis(body, dx, dz) {
  const r = body.radius;
  const nx = body.pos.x + dx, nz = body.pos.z + dz;
  const x0 = nx - r, x1 = nx + r, z0 = nz - r, z1 = nz + r;
  for (let i = 0; i < NSOLID; i++) {
    solidAt(i, _s);
    if (x1 <= _s[0] || x0 >= _s[2] || z1 <= _s[1] || z0 >= _s[3]) continue;
    if (_s[4] <= body.y + 0.001) continue; // below the feet: walk over it
    if (_s[4] <= body.y + STEP_UP) { body.y = _s[4]; continue; } // step up
    if (dx > 0) body.pos.x = _s[0] - r - 0.001;
    else if (dx < 0) body.pos.x = _s[2] + r + 0.001;
    else if (dz > 0) body.pos.z = _s[1] - r - 0.001;
    else body.pos.z = _s[3] + r + 0.001;
    if (dx !== 0) body.vel.x = 0; else body.vel.z = 0;
    return false;
  }
  body.pos.x = nx; body.pos.z = nz;
  return true;
}

// One fixed step of 3D movement. Quake-style accelerate/friction plus
// smooth crouch and gravity. No allocation, no randomness: deterministic.
export function moveBody(body, wishX, wishZ, speed, dt) {
  const target = body.crouched ? 1 : 0; // smooth crouch, never a snap
  body.crouchAmt += clamp(target - body.crouchAmt, -dt * 8, dt * 8);
  body.height = STAND_HEIGHT - (STAND_HEIGHT - CROUCH_HEIGHT) * body.crouchAmt;
  body.eyeHeight = STAND_EYE - (STAND_EYE - CROUCH_EYE) * body.crouchAmt;
  const onGround = !body.airborne;
  const accel = onGround ? ACCEL : ACCEL * AIR_CONTROL;
  const wl = Math.hypot(wishX, wishZ);
  if (wl > 0.01) {
    body.vel.x += (wishX / wl) * accel * dt;
    body.vel.z += (wishZ / wl) * accel * dt;
  }
  const sp = Math.hypot(body.vel.x, body.vel.z);
  if (sp > 0.001) {
    const targetSp = wl > 0.01 ? speed : 0;
    const drop = onGround ? FRICTION * dt : 0.4 * dt;
    const ns = Math.max(targetSp, sp - sp * drop);
    const capped = Math.min(sp, Math.max(ns, targetSp === 0 ? 0 : sp));
    body.vel.x *= capped / sp;
    body.vel.z *= capped / sp;
  }
  const sp2 = Math.hypot(body.vel.x, body.vel.z);
  const maxSp = speed * 1.15;
  if (sp2 > maxSp) { body.vel.x *= maxSp / sp2; body.vel.z *= maxSp / sp2; }
  moveAxis(body, body.vel.x * dt, 0);
  moveAxis(body, 0, body.vel.z * dt);
  body.pos.x = clamp(body.pos.x, -39, 39);
  body.pos.z = clamp(body.pos.z, -39, 39);
  body.vy -= GRAVITY * dt; // gravity: feet land on the highest solid under them
  body.y += body.vy * dt;
  const g = groundUnder(body);
  if (body.y <= g) { body.y = g; body.vy = 0; body.airborne = false; }
  else body.airborne = true;
}

// Jump: jump + 0.5 m step-up mantles onto a 1.4 m crate (apex 1.04 m + 0.5 m > 1.4 m).
export function jumpBody(body) {
  if (!body.airborne) { body.vy = JUMP_VY; body.airborne = true; }
}

// Ray vs a VERTICAL capsule: axis (cx, cz), y from y0 to y1, radius r.
// A capsule is convex, so the ray meets it in one interval: entry = the
// earliest part entry, exit = the latest part exit (cylinder wall inside
// the y-band, plus the two end spheres). A ray that starts inside returns
// the exit — the point-blank rule.
export function rayCapsule(ox, oy, oz, dx, dy, dz, cx, y0, y1, cz, r) {
  let enter = Infinity, exit = -Infinity;
  const ex = ox - cx, ez = oz - cz;
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {
    const b = 2 * (ex * dx + ez * dz);
    const c = ex * ex + ez * ez - r * r;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc), den = 2 * a;
      const tA = (-b - sq) / den, tB = (-b + sq) / den;
      const yA = oy + tA * dy, yB = oy + tB * dy;
      if (yA >= y0 && yA <= y1) { if (tA < enter) enter = tA; if (tA > exit) exit = tA; }
      if (yB >= y0 && yB <= y1) { if (tB < enter) enter = tB; if (tB > exit) exit = tB; }
    }
  }
  // End spheres (the caps): interval [tca-thc, tca+thc] each.
  const lx = cx - ox, lz = cz - oz;
  const tcaX = lx * dx + lz * dz;
  for (let k = 0; k < 2; k++) {
    const cy = k === 0 ? y0 : y1;
    const ly = cy - oy;
    const tca = tcaX + ly * dy;
    if (tca < 0) continue;
    const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
    if (d2 > r * r) continue;
    const thc = Math.sqrt(r * r - d2);
    const e0 = tca - thc, x0 = tca + thc;
    if (e0 < enter) enter = e0;
    if (x0 > exit) exit = x0;
  }
  if (enter === Infinity) return -1;
  return enter >= 0 ? enter : exit;
}
