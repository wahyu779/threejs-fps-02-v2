// palette.js — the dusk-harbour look of Pelabuhan Senja.
// One job: every colour / material constant the scene uses, in one place,
// so the map reads as one place at one hour: low sun, wet concrete, rust.
export const PALETTE = {
  skyTop: 0x2b3a6e,      // deep dusk blue overhead
  skyHorizon: 0xff9a52,  // orange band where the sun went down
  fog: 0x3a3348,         // haze over the water
  ground: 0x4a4640,      // wet concrete apron
  groundDark: 0x35322e,
  water: 0x1d2f45,       // harbour water, dark and reflective-looking
  containerRust: 0xa34d28,
  containerTeal: 0x2e6b6b,
  containerOchre: 0xb98a2f,
  warehouse: 0x6b5a44,   // corrugated warehouse walls
  warehouseRoof: 0x4c4438,
  crate: 0x8a6b3d,
  crateDark: 0x6b4f2a,
  lampGlow: 0xffc06a,    // sodium lamps
  siteA: 0x3fae5a,       // site markers, green chalk
  siteB: 0x3f8ae0,
  teamSenja: 0x4fc3f7,   // player team (blue)
  teamBayang: 0xff7043,  // enemy team (orange)
  tracer: 0xffe08a,
  muzzle: 0xffd27a,
};
