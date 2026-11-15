// bomb.js — the objective of Pelabuhan Senja v2.
// One job: the bomb's whole life — carried, planted, ticking, defused,
// exploded. Plant takes 3 s holding E inside a site, fuse 40 s, defuse 5 s.
import { SITE_A, SITE_B, insideSite } from './map.js';

export const PLANT_TIME = 3;
export const FUSE_TIME = 40;
export const DEFUSE_TIME = 5;

export function makeBomb() {
  return {
    state: 'carried', // carried | planted | exploded | defused
    site: null,       // 'A' | 'B' once planted
    x: 0, z: 0,       // plant position
    fuse: 0,          // seconds left on the fuse
    carrier: null,    // fighter carrying it
  };
}

export function resetBomb(bomb, carrier) {
  bomb.state = 'carried';
  bomb.site = null;
  bomb.fuse = 0;
  bomb.carrier = carrier;
}

// Which site (if any) is this fighter standing in?
export function siteAt(x, z) {
  if (insideSite(x, z, SITE_A)) return 'A';
  if (insideSite(x, z, SITE_B)) return 'B';
  return null;
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
