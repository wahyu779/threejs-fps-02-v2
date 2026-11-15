// player.js — the human fighter.
// One job: turn input state into movement, aim and trigger pulls for the
// one human on the Senja team. Bots never touch this file; they drive
// their own bodies through mover.js + bots.js.
import { makeBody, stepMove, stepJump, WALK_SPEED, CROUCH_SPEED } from './mover.js';
import { makeGunState, tickGun, currentSpread, reloadGun, zoomFor } from './weapons.js';
import { clamp } from './rng.js';

export function makePlayer(spawn) {
  return {
    team: 'senja', alive: true, isPlayer: true,
    body: makeBody(spawn.x, spawn.z),
    hp: 100, pitch: 0,
    gun: makeGunState('pistol'),
    grenades: 0, hasBomb: false,
    planting: 0, defusing: 0, // progress 0..1
    kills: 0, deaths: 0,
    zoomed: false, zoomF: 1, // ADS: zoomF eases toward the weapon zoom
  };
}

export function resetPlayer(p, spawn) {
  p.body.pos.x = spawn.x; p.body.pos.z = spawn.z;
  p.body.vel.x = 0; p.body.vel.z = 0;
  p.body.yaw = Math.atan2(spawn.x, spawn.z); // face the map centre
  p.body.y = 0; p.body.vy = 0; p.body.airborne = false;
  p.hp = 100; p.alive = true; p.pitch = 0;
  p.planting = 0; p.defusing = 0;
  p.zoomed = false; p.zoomF = 1;
  p.gun = makeGunState('pistol');
  p.grenades = 0; p.hasBomb = false;
}

// One fixed step. Returns an event bag for the main loop (sound /
// tracers / HUD): {fired, reloaded, jumped, moved, speed}.
export function stepPlayer(p, input, dt, events) {
  events.fired = false; events.reloaded = false; events.moved = false;
  if (!p.alive) return;
  const b = p.body;
  b.yaw -= input.mouseDX * 0.0022;
  p.pitch = clamp(p.pitch - input.mouseDY * 0.0022, -1.45, 1.45);
  // Recoil settles the aim upward: pitchKick lifts the view, yawKick turns it.
  p.pitch = clamp(p.pitch + p.gun.pitchKick * dt * 0.9, -1.45, 1.45);
  b.yaw += p.gun.yawKick * dt * 0.9;
  let fx = 0, fz = 0;
  if (input.down('KeyW')) fz -= 1;
  if (input.down('KeyS')) fz += 1;
  if (input.down('KeyA')) fx -= 1;
  if (input.down('KeyD')) fx += 1;
  const sin = Math.sin(b.yaw), cos = Math.cos(b.yaw);
  const wx = fx * cos + fz * sin;
  const wz = -fx * sin + fz * cos;
  b.crouched = input.down('ControlLeft') || input.down('KeyC');
  // Quiet walk (Shift): half speed, soft steps — the hearing bus reads
// body.quietWalk to muffle the footsteps. ADS slows too.
  const quiet = input.down('ShiftLeft') || input.down('ShiftRight');
  b.quietWalk = quiet;
  setZoom(p, !!input.mouseRightDown);
  const z = zoomFor(p.gun.weaponId);
  let speed = b.crouched ? CROUCH_SPEED : quiet ? WALK_SPEED * 0.5 : WALK_SPEED;
  if (p.zoomed) speed *= z.speedMult;
  stepMove(b, wx, wz, speed, dt);
  stepJump(b, input.down('Space'), dt);
  const moving = Math.hypot(b.vel.x, b.vel.z) > 0.6;
  events.moved = moving;
  events.speed = Math.hypot(b.vel.x, b.vel.z);
  p.gun._spread = currentSpread(p.gun, moving, b.airborne, b.crouched, p.zoomF);
  tickGun(p.gun, dt);
  const w = p.gun.weaponId;
  const auto = w === 'rifle';
  const wantFire = auto ? input.mouseDown : input.mouseDownEdge;
  if (wantFire && p.gun.ammo > 0 && p.gun.cooldown <= 0) events.fired = true;
  if (input.hit('KeyR') && reloadGun(p.gun)) events.reloaded = true;
}

// setZoom: aim-down-sights. Holding the right mouse button eases the zoom
// factor toward the weapon's zoom (weapons.js zoomFor) — the camera FOV
// narrows with it in main.js, the crosshair tightens, the walk slows.
export function setZoom(p, zoomed) {
  p.zoomed = zoomed;
  const target = zoomed ? zoomFor(p.gun.weaponId).factor : 1;
  p.zoomF += (target - p.zoomF) * 0.12; // eased per fixed step, not per frame
}
