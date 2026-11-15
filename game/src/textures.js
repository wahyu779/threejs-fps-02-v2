// textures.js — canvas textures, decals, sun + ACES.
import { SITES, CALLOUTS, WALL_KINDS } from './map.js';
function tex(THREE, size, draw, rx = 1, ry = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = size; draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export function makeFloorTexture(THREE) {
  return tex(THREE, 512, (g, s) => {
    g.fillStyle = '#6a6156'; g.fillRect(0, 0, s, s);
    g.fillStyle = 'rgba(30,26,22,0.55)';
    for (let k = 1; k < 4; k++) { g.fillRect(k * 128 - 1, 0, 3, s); g.fillRect(0, k * 128 - 1, s, 3); }
  }, 10, 10);
}
function corr(g, s, base) {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  g.fillStyle = 'rgba(0,0,0,0.28)';
  for (let x = 0; x < s; x += 16) g.fillRect(x, 0, 3, s);
}
function crate(g, s) {
  g.fillStyle = '#8a6b3d'; g.fillRect(0, 0, s, s);
  for (let y = 0; y < s; y += 43) {
    g.fillRect(0, y, s, 43);
    g.fillStyle = 'rgba(30,20,10,0.6)'; g.fillRect(0, y, s, 3);
  }
}
const wallCache = new Map();
const WALL_BASE = { W: '#7a6748', R: '#a34d28', T: '#2e6b6b', O: '#b98a2f', B: '#3a3632', C: '#8a6b3d' };
// Clone: repeat ~every 4 m, image shared.
export function wallMaterial(THREE, i, w, h) {
  const kind = WALL_KINDS[i] || 'C';
  if (!wallCache.has(kind)) wallCache.set(kind, kind === 'C' ? tex(THREE, 256, crate) : tex(THREE, 256, (g, s) => corr(g, s, WALL_BASE[kind])));
  const t = wallCache.get(kind).clone();
  t.repeat.set(Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4)));
  t.needsUpdate = true;
  return new THREE.MeshStandardMaterial({ map: t, roughness: 0.85, metalness: 0.08, emissive: new THREE.Color(WALL_BASE[kind]), emissiveIntensity: 0.22 });
}
function hazardRing(THREE) {
  return tex(THREE, 256, (g, s) => {
    g.fillStyle = '#f7b500'; g.fillRect(0, 0, s, s);
    g.fillStyle = '#151310'; g.save(); g.translate(s / 2, s / 2); g.rotate(Math.PI / 4);
    for (let x = -s; x < s; x += 32) g.fillRect(x, -s, 16, s * 2);
    g.restore();
    // Thin striped border only: cut the middle out and the corners off.
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.arc(128, 128, 116, 0, 7); g.fill();
    g.beginPath(); g.rect(0, 0, s, s); g.arc(128, 128, 128, 0, 7, true); g.fill('evenodd');
  });
}
function textDecal(THREE, w, h, font, text, color, ring) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = color; g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (ring) {
    g.strokeStyle = color; g.lineWidth = 10;
    g.beginPath(); g.arc(w / 2, h / 2, w / 2 - 18, 0, 7); g.stroke();
  }
  g.fillText(text, w / 2, h / 2 + (ring ? 8 : 0));
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function flat(THREE, t, w, h, x, z, y) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: 0.9, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.set(x, y, z);
  return m;
}
export function buildSiteDecals(THREE) {
  const group = new THREE.Group(), ring = hazardRing(THREE);
  const cols = ['#3fae5a', '#3f8ae0', '#e8a33d'];
  for (let k = 0; k < 3; k++) {
    const site = SITES[k];
    group.add(flat(THREE, textDecal(THREE, 256, 256, 'bold 150px sans-serif', site.name, cols[k], true), 7, 7, site.x, site.z, 0.07));
    group.add(flat(THREE, ring, site.r * 2 + 2, site.r * 2 + 2, site.x, site.z, 0.06));
    const lamp = new THREE.PointLight(0xffc06a, 40, 26, 1.8);
    lamp.position.set(site.x, 5, site.z); group.add(lamp);
  }
  return group;
}
export function buildCalloutDecals(THREE) {
  const group = new THREE.Group();
  for (const [name, x, z] of CALLOUTS) {
    if (name.endsWith('Site') || name === 'C Dock') continue;
    group.add(flat(THREE, textDecal(THREE, 256, 64, 'bold 32px sans-serif', name.toUpperCase(), 'rgba(255,214,140,0.92)'), 4.5, 1.1, x, z, 0.08));
  }
  return group;
}
// ACES lifts the dark slabs into a warm, legible dusk instead of black.
export function configureRenderer(THREE, renderer) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
export function configureSun(THREE, sun, hemi) {
  sun.intensity = 1.8;
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -48, right: 48, top: 48, bottom: -48, near: 5, far: 120 });
  sun.shadow.bias = -0.0005;
  hemi.intensity = 1.5;
  hemi.groundColor.set(0x4a3a28);
}
