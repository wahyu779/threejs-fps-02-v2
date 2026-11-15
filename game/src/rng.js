// rng.js — deterministic seeded random.
// One tiny job: a mulberry32 stream plus small helpers. The simulation seeds
// one stream per match so bot behaviour is reproducible in sim mode.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function range(rng, lo, hi) { return lo + rng() * (hi - lo); }
export function pick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
