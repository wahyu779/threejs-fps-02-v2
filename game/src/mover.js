// mover.js — thin shell over collide.js.
// One job: keep the movement API (makeBody/stepMove/stepJump, speed
// constants) so player.js and bots.js call it unchanged; physics lives in collide.js.
import { moveBody, jumpBody, WALK_SPEED, CROUCH_SPEED, AIR_CONTROL, ACCEL, FRICTION, STAND_HEIGHT, STAND_EYE } from './collide.js';

export { WALK_SPEED, CROUCH_SPEED, AIR_CONTROL, ACCEL, FRICTION };

export function makeBody(x, z) {
  return {
    pos: { x, z }, vel: { x: 0, z: 0 },
    yaw: 0, radius: 0.45,
    crouched: false, airborne: false, y: 0, vy: 0,
    height: STAND_HEIGHT, eyeHeight: STAND_EYE, crouchAmt: 0,
    quietWalk: false, // Shift walk: soft steps (hearing bus reads this)
  };
}

// wishX/wishZ: desired move direction (unit or zero). speed: target speed.
export function stepMove(body, wishX, wishZ, speed, dt) {
  moveBody(body, wishX, wishZ, speed, dt);
}

// Simple vertical hop; gravity and landing live inside moveBody.
export function stepJump(body, wantJump, dt) {
  if (wantJump) jumpBody(body);
}
