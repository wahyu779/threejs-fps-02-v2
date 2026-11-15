// player.js — the human fighter in Pelabuhan Senja v2.
// One job: turn input state into movement, aim and trigger pulls for the
// one human on the Senja team. Bots never touch this file; they drive
// their own bodies through mover.js + bots.js.
import { makeBody, stepMove, stepJump, WALK_SPEED, CROUCH_SPEED } from './mover.js';
import { makeGunState, tickGun, currentSpread, reloadGun } from './weapons.js';
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
  };
}

export function resetPlayer(p, spawn) {
  p.body.pos.x = spawn.x; p.body.pos.z = spawn.z;
  p.body.vel.x = 0; p.body.vel.z = 0;
  p.body.yaw = Math.atan2(spawn.x, spawn.z); // face the map centre
  p.body.y = 0; p.body.vy = 0; p.body.airborne = false;
  p.hp = 100; p.alive = true; p.pitch = 0;
  p.planting = 0; p.defusing = 0;
  p.gun = makeGunState('pistol');
  p.grenades = 0; p.hasBomb = false;
}

// One fixed step. Returns an event bag the main loop turns into sound /
// tracers / HUD: {fired, reloaded, jumped, moved, speed}.
export function stepPlayer(p, input, dt, events) {
  events.fired = false; events.reloaded = false; events.moved = false;
  if (!p.alive) return;
  const b = p.body;
  // Mouse look: yaw from horizontal mouse, pitch from vertical, clamped.
  b.yaw -= input.mouseDX * 0.0022;
  p.pitch = clamp(p.pitch - input.mouseDY * 0.0022, -1.45, 1.45);
  // Recoil settles the aim upward: pitchKick lifts the view, yawKick turns it.
  p.pitch = clamp(p.pitch + p.gun.pitchKick * dt * 0.9, -1.45, 1.45);
  b.yaw += p.gun.yawKick * dt * 0.9;
  // Wish direction from WASD, rotated by yaw.
  let fx = 0, fz = 0;
  if (input.down('KeyW')) fz -= 1;
  if (input.down('KeyS')) fz += 1;
  if (input.down('KeyA')) fx -= 1;
  if (input.down('KeyD')) fx += 1;
  const sin = Math.sin(b.yaw), cos = Math.cos(b.yaw);
  // R_y(yaw) applied to local (fx, fz): W(0,-1) -> forward (-sin, -cos).
  const wx = fx * cos + fz * sin;
  const wz = -fx * sin + fz * cos;
  b.crouched = input.down('ControlLeft') || input.down('KeyC');
  const speed = b.crouched ? CROUCH_SPEED : WALK_SPEED;
  stepMove(b, wx, wz, speed, dt);
  stepJump(b, input.down('Space'), dt);
  const moving = Math.hypot(b.vel.x, b.vel.z) > 0.6;
  events.moved = moving;
  events.speed = Math.hypot(b.vel.x, b.vel.z);
  // Spread for this frame, from the movement state.
  p.gun._spread = currentSpread(p.gun, moving, b.airborne, b.crouched);
  tickGun(p.gun, dt);
  // Trigger: hold for autos, click for semi-autos.
  const w = p.gun.weaponId;
  const auto = w === 'rifle';
  const wantFire = auto ? input.mouseDown : input.mouseDownEdge;
  if (wantFire && p.gun.ammo > 0 && p.gun.cooldown <= 0) events.fired = true;
  if (input.hit('KeyR') && reloadGun(p.gun)) events.reloaded = true;
}
