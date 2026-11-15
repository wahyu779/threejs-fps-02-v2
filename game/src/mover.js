// mover.js — shared movement physics for Pelabuhan Senja v2.
// One job: move a circle-bodied fighter with acceleration, friction and
// wall sliding. Player and bots both step through here, so movement feels
// the same on both sides of a duel.
import { resolveCircle } from './map.js';
import { clamp } from './rng.js';

export const WALK_SPEED = 5.2;   // m/s
export const CROUCH_SPEED = 2.6;
export const AIR_CONTROL = 0.25;
export const ACCEL = 42;         // m/s^2
export const FRICTION = 10;      // 1/s ground damping

export function makeBody(x, z) {
  return {
    pos: { x, z }, vel: { x: 0, z: 0 },
    yaw: 0, radius: 0.45,
    crouched: false, airborne: false, y: 0, vy: 0,
  };
}

// wishX/wishZ: desired move direction in world space (unit or zero).
// speed: target speed. dt: fixed step.
export function stepMove(body, wishX, wishZ, speed, dt) {
  const onGround = !body.airborne;
  const accel = onGround ? ACCEL : ACCEL * AIR_CONTROL;
  const wl = Math.hypot(wishX, wishZ);
  if (wl > 0.01) {
    body.vel.x += (wishX / wl) * accel * dt;
    body.vel.z += (wishZ / wl) * accel * dt;
  }
  // Friction pulls velocity toward the wish speed, never past it.
  const sp = Math.hypot(body.vel.x, body.vel.z);
  if (sp > 0.001) {
    const target = wl > 0.01 ? speed : 0;
    const drop = onGround ? FRICTION * dt : 0.4 * dt;
    const ns = Math.max(target, sp - sp * drop);
    // Cap at wish speed when accelerating from rest is not the case:
    // never let friction speed the body up, only slow it.
    const capped = Math.min(sp, Math.max(ns, target === 0 ? 0 : sp));
    body.vel.x *= capped / sp;
    body.vel.z *= capped / sp;
  }
  // Hard cap so diagonal + accel never exceeds the target speed by much.
  const sp2 = Math.hypot(body.vel.x, body.vel.z);
  const maxSp = speed * 1.15;
  if (sp2 > maxSp) { body.vel.x *= maxSp / sp2; body.vel.z *= maxSp / sp2; }
  body.pos.x += body.vel.x * dt;
  body.pos.z += body.vel.z * dt;
  resolveCircle(body.pos, body.radius);
  body.pos.x = clamp(body.pos.x, -39, 39);
  body.pos.z = clamp(body.pos.z, -39, 39);
}

// Simple vertical hop. Ground is y=0 everywhere (flat quay).
export function stepJump(body, wantJump, dt) {
  if (wantJump && !body.airborne) { body.vy = 5.4; body.airborne = true; }
  if (body.airborne) {
    body.vy -= 14 * dt;
    body.y += body.vy * dt;
    if (body.y <= 0) { body.y = 0; body.vy = 0; body.airborne = false; }
  }
}
