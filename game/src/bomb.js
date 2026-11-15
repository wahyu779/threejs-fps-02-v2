// bomb.js — the objective.
// One job: the bomb's whole life — carried, dropped, planted, ticking,
// defused, exploded. Plant takes 3 s holding E inside the live site,
// fuse 40 s, defuse 5 s. The carrier no longer auto-transfers the bomb
// on death — it DROPS where he dies; any living fighter can pick it up.
// Three sites rotate, one live per round.
import { siteAt as tacticsSiteAt } from './tactics.js';

export const PLANT_TIME = 3;
export const FUSE_TIME = 40;
export const DEFUSE_TIME = 5;
export const PICKUP_RADIUS = 1.3;

export function makeBomb() {
  return {
    state: 'carried', // carried | dropped | planted | exploded | defused
    site: null,       // 'A' | 'B' | 'C' once planted
    activeSite: 'A',  // the live site this round (rotates A -> B -> C)
    x: 0, z: 0,       // plant / drop position
    fuse: 0,          // seconds left on the fuse
    carrier: null,    // fighter carrying it
  };
}

export function resetBomb(bomb, carrier, activeSite) {
  bomb.state = 'carried';
  bomb.site = null;
  bomb.activeSite = activeSite || 'A';
  bomb.fuse = 0;
  bomb.carrier = carrier;
  bomb.x = 0; bomb.z = 0;
}

// Carrier died: the bomb falls where he stood. No auto-transfer.
export function dropBomb(bomb, x, z) {
  if (bomb.state !== 'carried') return false;
  bomb.state = 'dropped';
  bomb.carrier = null;
  bomb.x = x; bomb.z = z;
  return true;
}

// Any living fighter within pickup radius takes the bomb.
export function tryPickup(bomb, fighter) {
  if (bomb.state !== 'dropped' || !fighter || !fighter.alive) return false;
  const dx = fighter.body.pos.x - bomb.x, dz = fighter.body.pos.z - bomb.z;
  if (dx * dx + dz * dz > PICKUP_RADIUS * PICKUP_RADIUS) return false;
  bomb.state = 'carried';
  bomb.carrier = fighter;
  fighter.hasBomb = true;
  return true;
}

// Which site (if any) is this fighter standing in? All three sites.
export function siteAt(x, z) {
  return tacticsSiteAt(x, z);
}

// Tick the fuse. Returns 'exploded' once, else null.
export function tickBomb(bomb, dt) {
  if (bomb.state !== 'planted') return null;
  bomb.fuse -= dt;
  if (bomb.fuse <= 0) {
    bomb.state = 'exploded';
    return 'exploded';
  }
  return null;
}
