// weapons.js — gunplay: hitscan, recoil, spread.
// One job: what happens when the trigger is pulled. Bots and the player
// call the same fireHitscan(), so a bot kill is a ray that really crossed
// a body, never a dice roll. Hit model: three vertical capsules per
// fighter — head (r 0.22, 1.40–1.64 m), torso (r 0.42, 0.70–1.40 m), legs
// (r 0.40, 0.05–0.75 m). One shot is one ray; the nearest capsule before
// the nearest wall wins. Head = damage x2 (marksman x4). Recoil is real
// for bots (kick N affects shot N+1; the human is exempt, the camera
// already carries recoil). Spread punishes firing on the move and grows
// with spray heat (bloom). Falloff: full to half range, linear to 60%.
import { rayCapsule } from './collide.js';
import { rayWalls } from './map.js';
import { clamp } from './rng.js';

export const WEAPONS = {
  pistol: {
    name: 'Harbour Pistol', price: 0, damage: 34, headMult: 2,
    rpm: 350, mag: 12, reserve: 48, auto: false, pellets: 1,
    spreadBase: 0.011, spreadMove: 0.020, spreadAir: 0.045, spreadCrouch: 0.006,
    bloom: 0.020, recover: 0.10,
    recoil: [[0.016, 0.000], [0.016, 0.001], [0.015, -0.001]],
    range: 60, tracer: 0xffe08a, zoom: 1, scope: false, viewKick: 0.03,
  },
  rifle: {
    name: 'Senja Rifle', price: 2700, damage: 36, headMult: 2,
    rpm: 600, mag: 30, reserve: 90, auto: true, pellets: 1,
    spreadBase: 0.008, spreadMove: 0.026, spreadAir: 0.055, spreadCrouch: 0.004,
    bloom: 0.012, recover: 0.085,
    recoil: [[0.011, 0.000], [0.013, 0.002], [0.014, 0.003], [0.015, -0.002],
             [0.014, -0.004], [0.013, -0.002], [0.012, 0.003], [0.012, 0.004],
             [0.011, 0.001], [0.011, 0.000], [0.011, 0.001], [0.011, 0.000]],
    range: 90, tracer: 0xffe08a, zoom: 1.35, scope: false, viewKick: 0.05,
  },
  marksman: {
    name: 'Longshot Marksman', price: 3500, damage: 88, headMult: 4,
    rpm: 48, mag: 5, reserve: 20, auto: false, pellets: 1,
    spreadBase: 0.002, spreadMove: 0.040, spreadAir: 0.070, spreadCrouch: 0.001,
    bloom: 0.020, recover: 0.05,
    recoil: [[0.055, 0.000]],
    range: 120, tracer: 0xffc46a, zoom: 3, scope: true, viewKick: 0.12,
  },
  shotgun: {
    name: 'Dockside Scattergun', price: 1800, damage: 12, headMult: 2,
    rpm: 70, mag: 6, reserve: 24, auto: false, pellets: 8,
    spreadBase: 0.030, spreadMove: 0.045, spreadAir: 0.070, spreadCrouch: 0.020,
    bloom: 0.012, recover: 0.07,
    recoil: [[0.045, 0.000]],
    range: 28, tracer: 0xffd27a, zoom: 1.15, scope: false, viewKick: 0.10,
  },
};

// Aim-down-sights: zoom narrows the FOV (75 / factor), steadies the spread
// and slows the walk. Marksman is scoped (3x); rifle gets 1.35x.
export function zoomFor(weaponId) {
  const w = WEAPONS[weaponId];
  return {
    factor: w.zoom, scope: w.scope,
    spreadMult: w.zoom > 1.5 ? 0.45 : w.zoom > 1 ? 0.7 : 1,
    speedMult: w.zoom > 1.5 ? 0.45 : w.zoom > 1 ? 0.6 : 1,
  };
}

export const GRENADE = { name: 'Frag Grenade', price: 300, damage: 95, radius: 6 };

const RECOIL_SLOW_K = 1.2;    // /s, exp decay during a burst (idle < 0.3 s)
const RECOIL_FAST_LINEAR = 0.6; // rad/s, linear decay after the pause
const RECOIL_FAST_AFTER = 0.3;  // s idle before fast decay
const RECOIL_RESET_AFTER = 0.35; // s idle before the burst resets
const BLOOM_CAP = 0.05;

// Shot state per fighter: one object, reused, never reallocated.
export function makeGunState(weaponId) {
  return {
    weaponId, ammo: WEAPONS[weaponId].mag,
    reserve: WEAPONS[weaponId].reserve,
    cooldown: 0, bloom: 0, recoilHeat: 0, burst: 0,
    pitchKick: 0, yawKick: 0, // accumulated recoil the aim must absorb
    idleT: 0, // s since the last shot (two-phase recovery clock)
  };
}

// Current spread cone (radians): still < moving < airborne, crouch
// shrinks it, spray heat (bloom) grows it. Called every frame.
export function currentSpread(gun, moving, airborne, crouched, zoomF) {
  const w = WEAPONS[gun.weaponId];
  let s = w.spreadBase + gun.bloom;
  if (airborne) s += w.spreadAir;
  else if (moving) s += w.spreadMove;
  if (crouched) s -= w.spreadCrouch;
  if (zoomF > 1) s *= zoomF > 1.5 ? 0.45 : 0.7;
  return Math.max(0.0015, s);
}

// Hit capsules for one fighter: [cx, y0, y1, cz, r] per zone (head,
// torso, legs) — up with body.y, shrinking while crouched.
function targetCapsules(f, out) {
  const p = f.body.pos, y = f.body.y || 0, c = f.body.crouchAmt || 0;
  out[0] = p.x; out[1] = y + 1.40 - 0.45 * c; out[2] = y + 1.64 - 0.49 * c; out[3] = p.z; out[4] = 0.22;
  out[5] = p.x; out[6] = y + 0.70 - 0.25 * c; out[7] = y + 1.40 - 0.45 * c; out[8] = p.z; out[9] = 0.42;
  out[10] = p.x; out[11] = y + 0.05; out[12] = y + 0.75 - 0.25 * c; out[13] = p.z; out[14] = 0.40;
  return out;
}
const _cap = new Float32Array(15);

// Fire ONE hitscan pellet. Returns {hit, head, damage, dist, target,
// dx, dy, dz} — or {hit:false, dist}. dx/dy/dz is the pellet's TRUE
// direction: point = origin + dir * dist, for tracers that end exactly at
// the hit point. The shooter is excluded; the nearest wall (rayWalls 2D)
// cuts the ray before any target. Hit zone from the ray entry height
// (head above 1.40 m). LIMIT: wall rays are still 2D — a shot from a ledge
// is blocked by low cover. Damage here is RAW (before armour). Falloff:
// full to half range, linear to 60% at max.
export function firePellet(origin, dir, weaponId, shooter, targets) {
  const w = WEAPONS[weaponId];
  const wallDist = rayWalls(origin.x, origin.z, dir.x, dir.z, w.range);
  let bestT = Math.min(wallDist, w.range);
  let bestTarget = null, bestHeadY0 = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t === shooter || !t.alive) continue;
    targetCapsules(t, _cap);
    for (let s = 0; s < 3; s++) {
      const tt = rayCapsule(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
        _cap[s * 5], _cap[s * 5 + 1], _cap[s * 5 + 2], _cap[s * 5 + 3], _cap[s * 5 + 4]);
      if (tt >= 0 && tt < bestT) {
        bestT = tt; bestTarget = t; bestHeadY0 = _cap[1];
      }
    }
  }
  if (!bestTarget) return { hit: false, dist: bestT, dx: dir.x, dy: dir.y, dz: dir.z };
  const bestHead = (origin.y + dir.y * bestT) >= bestHeadY0;
  const fall = 1 - 0.4 * clamp((bestT - w.range * 0.5) / (w.range * 0.5), 0, 1);
  const damage = Math.round(w.damage * (bestHead ? w.headMult : 1) * fall);
  return { hit: true, head: bestHead, damage, dist: bestT, target: bestTarget,
           dx: dir.x, dy: dir.y, dz: dir.z };
}

// One trigger pull: rotate the direction with recoil, spread it, fire
// the pellets, advance recoil + bloom.
// vector); rng adds spread jitter. Results land in out, a reused buffer.
const _results = [];
export function fireHitscan(origin, dirIn, gun, rng, shooter, targets, out) {
  const w = WEAPONS[gun.weaponId];
  out.length = 0;
  _results.length = 0; // pellet buffer, reused: clear it first
  if (gun.ammo <= 0 || gun.cooldown > 0) return out;
  gun.ammo--;
  gun.cooldown = 60 / w.rpm;
  gun.idleT = 0;
// Recoil: the next kick in the pattern. The offset rotated into the bullet
// is the recoil BEFORE this kick — shot N's kick affects shot N+1 only.
  const prevPitch = gun.pitchKick, prevYaw = gun.yawKick;
  const kick = w.recoil[gun.burst % w.recoil.length];
  gun.burst++;
  gun.pitchKick += kick[0];
  gun.yawKick += kick[1];
  gun.bloom = Math.min(BLOOM_CAP, gun.bloom + w.bloom);
  gun.recoilHeat = gun.bloom;
// Base direction of this shot. Bots recompute their aim every frame, so
// recoil MUST rotate here or bot spray never climbs. The player is exempt:
// the camera already carries recoil — rotating here too would double it.
  let ox = dirIn.x, oy = dirIn.y, oz = dirIn.z;
  const cameraAim = shooter && typeof shooter.pitch === 'number';
  if (!cameraAim && (prevPitch !== 0 || prevYaw !== 0)) {
// Orthonormal basis around dirIn. The yaw sign is flipped: a positive
// yawKick rotates the aim toward -right, so the offset uses -yaw.
    let rx = -dirIn.z, ry = 0, rz = dirIn.x;
    const rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-6) { rx = 1; ry = 0; rz = 0; } // aim straight up/down
    else { rx /= rl; ry /= rl; rz /= rl; }
    const ux = ry * dirIn.z - rz * dirIn.y;
    const uy = rz * dirIn.x - rx * dirIn.z;
    const uz = rx * dirIn.y - ry * dirIn.x;
    ox = dirIn.x + rx * (-prevYaw) + ux * prevPitch;
    oy = dirIn.y + ry * (-prevYaw) + uy * prevPitch;
    oz = dirIn.z + rz * (-prevYaw) + uz * prevPitch;
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol; oy /= ol; oz /= ol;
  }
  for (let p = 0; p < w.pellets; p++) {
    const sp = gun._spread || w.spreadBase;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * sp;
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(oy) > 0.9) { ux = 1; uy = 0; uz = 0; }
    let bx = oy * uz - oz * uy;
    let by = oz * ux - ox * uz;
    let bz = ox * uy - oy * ux;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    let cx = oy * bz - oz * by;
    let cy = oz * bx - ox * bz;
    let cz = ox * by - oy * bx;
    const dx = ox + (bx * Math.cos(a) + cx * Math.sin(a)) * r;
    const dy = oy + (by * Math.cos(a) + cy * Math.sin(a)) * r;
    const dz = oz + (bz * Math.cos(a) + cz * Math.sin(a)) * r;
    const dl = Math.hypot(dx, dy, dz) || 1;
    _results.push(firePellet(
      origin, { x: dx / dl, y: dy / dl, z: dz / dl },
      gun.weaponId, shooter, targets));
  }
  for (const r of _results) out.push(r);
  return out;
}

// Per-frame gun upkeep: tick cooldown, recover bloom and recoil (two
// phases — see header), reset the burst once the aim recovers.
export function tickGun(gun, dt) {
  const w = WEAPONS[gun.weaponId];
  if (gun.cooldown > 0) gun.cooldown -= dt;
  gun.idleT += dt;
  gun.bloom = Math.max(0, gun.bloom - w.recover * dt);
  gun.recoilHeat = gun.bloom;
  if (gun.idleT < RECOIL_FAST_AFTER) {
    const f = Math.exp(-RECOIL_SLOW_K * dt);
    gun.pitchKick *= f;
    gun.yawKick *= f;
  } else {
    gun.pitchKick = Math.max(0, gun.pitchKick - RECOIL_FAST_LINEAR * dt);
    if (gun.yawKick > 0) gun.yawKick = Math.max(0, gun.yawKick - RECOIL_FAST_LINEAR * dt);
    else gun.yawKick = Math.min(0, gun.yawKick + RECOIL_FAST_LINEAR * dt);
  }
  if (Math.abs(gun.pitchKick) < 1e-4) gun.pitchKick = 0;
  if (Math.abs(gun.yawKick) < 1e-4) gun.yawKick = 0;
// A burst restarts at 0 only once the aim has fully recovered — not when
// bloom merely happens to be 0 while kick is still large.
  if (gun.idleT > RECOIL_RESET_AFTER && gun.pitchKick === 0 && gun.yawKick === 0) {
    gun.burst = 0;
  }
}

export function reloadGun(gun) {
  const w = WEAPONS[gun.weaponId];
  if (gun.ammo >= w.mag || gun.reserve <= 0) return false;
  const need = w.mag - gun.ammo;
  const take = Math.min(need, gun.reserve);
  gun.ammo += take;
  gun.reserve -= take;
  return true;
}
