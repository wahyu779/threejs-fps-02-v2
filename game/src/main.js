// main.js — Pelabuhan Senja: boot, fixed-step loop, scene.
// One job: own the match. Everything else is a module with one job. The
// simulation steps at a fixed 120 Hz, apart from rendering; no new objects
// in the hot loop: tracers, grenades and the pellet buffer are pooled.
//
// Where things live, for a reader:
//   index.html        page shell, HUD DOM, buy menu, import map
//   src/main.js       boot, match wiring, harbour scene, staging
//   src/palette.js    dusk-harbour look: colours, fog, lights
//   src/rng.js        seeded random: makeRng, range, pick, clamp
//   src/map.js        40x40 map, walls, A*, LOS, sites, spawns
//   src/weapons.js    guns, recoil, spread/bloom, hitscan head/torso/legs
//   src/economy.js    wallets, armour, buying, loss bonus, shop
//   src/bots.js       nine AI fighters: roles, routes, strafe, hearing, buying
//   src/mover.js      thin shell over collide.js
//   src/collide.js    3D AABB collision: step-up, gravity, crouch
//   src/player.js     human fighter: input, movement, aim, shooting
//   src/bomb.js       plant/defuse state machine, fuse timer
//   src/rounds.js     phases (buy/live/over), score, match end, round log
//   src/input.js      keyboard + mouse (pointer lock)
//   src/audio.js      synthesised WebAudio sounds
//   src/hud.js        HUD: bars, timer, score, buy menu, minimap, killfeed
//   src/textures.js   canvas floor/wall/crate textures, site decals
//   src/tactics.js    3 rotating sites, hearing bus, smoke, sniper, grenades
//   src/scoreboard.js scoreboard (K/D/damage/MVP/funds), round history, rosters
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { makeRng, pick } from './rng.js';
import {
  WALLS, SITE_A, SITE_B, SITE_C, SPAWN_SENJA, SPAWN_BAYANG, HALF, HOLD_SPOTS,
  findPath, hasLineOfSight, wallHeight,
} from './map.js';
import { makeFloorTexture, wallMaterial, buildSiteDecals, buildCalloutDecals, configureRenderer, configureSun } from './textures.js';
import {
  activeSiteForRound, siteById, calloutAt, hearCheck,
  SMOKE_GRENADE, addSmoke, tickSmoke, smokeClouds, clearSmokes, isSmoked, segmentSmoked,
  stepGrenade,
} from './tactics.js';
import {
  WEAPONS, GRENADE, makeGunState, currentSpread,
  fireHitscan, firePellet,
} from './weapons.js';
import {
  makeWallet, applyArmor, buyArmor, buyHelmet, buyWeapon, buyGrenade, buySmoke,
  lossBonusFor, getShopItems, headDamageFactor, killRewardFor,
  PLANT_BONUS, DEFUSE_BONUS,
} from './economy.js';
import { makeBot, resetBot, botBuy, stepBot, hearShot, hearFootstep, hearReload, canSee, BOT_NAMES_SENJA, BOT_NAMES_BAYANG } from './bots.js';
import { makePlayer, resetPlayer, stepPlayer } from './player.js';
import { STEP_OBSTACLES } from './collide.js';
import { WALK_SPEED } from './mover.js'; // viewmodel bob scale (render)
import { makeBomb, resetBomb, dropBomb, tryPickup, siteAt, tickBomb, PLANT_TIME, FUSE_TIME, DEFUSE_TIME } from './bomb.js';
import { makeMatch, startRound, tickMatch, endRound, nextRound, TEAM_SIZE, WIN_ROUNDS, MAX_ROUNDS, HALF_ROUND } from './rounds.js';
import { makeInput } from './input.js';
import { initAudio, sfx } from './audio.js';
import { initHud, updateHud, showHitmarker, showDamageDir, showBanner, feedLine, setBuyVisible, setEndScreen, setDebug, buildMinimapSnapshot, buyFlash, buildBuyList } from './hud.js';

const params = new URLSearchParams(location.search);
const SIM = params.get('sim') === '1';
const IDLEPLAYER = params.get('idleplayer') === '1'; // hero stands still (A/B fairness: like an idle human)
const FAST = params.get('fast') === '1'; // headless sim: many steps per frame, no render
const DEBUG = SIM || params.get('debug') === '1';
const POSE = params.get('pose') || '';
const SELFTEST = params.get('selftest') === '1';
const SEED = parseInt(params.get('seed') || '20261115', 10);
const rng = makeRng(SEED);

// --- state, all in one place ---
const match = makeMatch();
const bomb = makeBomb();
const player = makePlayer(SPAWN_SENJA[0]);
player.wallet = makeWallet();
player.name = 'You';
const bots = [];
for (let i = 0; i < TEAM_SIZE - 1; i++) bots.push(makeBot('senja', BOT_NAMES_SENJA[i], SPAWN_SENJA[i + 1], makeRng(SEED + 11 + i), i));
for (let i = 0; i < TEAM_SIZE; i++) bots.push(makeBot('bayang', BOT_NAMES_BAYANG[i], SPAWN_BAYANG[i], makeRng(SEED + 31 + i), i));
const fighters = [player, ...bots];
const simPlayerBot = SIM ? makeBot('senja', 'You', SPAWN_SENJA[0], makeRng(SEED + 77), 0) : null;
if (SIM) {
  // In sim mode the "player" slot is AI-driven; the camera still follows slot 0.
  fighters[0] = simPlayerBot;
  simPlayerBot.isPlayer = true;
}
for (const b of bots) b.onRadio = (text) => feedLine('📻 ' + text);
if (SIM) simPlayerBot.onRadio = (text) => feedLine('📻 ' + text);
const hero = fighters[0]; // slot 0: human, or the sim bot
const simStats = { rounds: 0, senja: 0, bayang: 0, shots: 0, hits: 0, strafes: 0, plants: 0, defuses: 0, explosions: 0, smokes: 0, liveSeconds: 0 };
let now = 0;
const spotted = new Set(); // enemies spotted by any Senja fighter (minimap)
const _pelletOut = [];
const _botEvents = { fired: false, hit: false };
const _pEvents = { fired: false, reloaded: false, moved: false, speed: 0 };

// --- three.js scene ---
const container = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
configureRenderer(THREE, renderer);
renderer.domElement.className = 'webgl';
container.appendChild(renderer.domElement);
const scene = new THREE.Scene();
{
  const skyGeo = new THREE.SphereGeometry(220, 16, 12);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(PALETTE.skyTop) },
      mid: { value: new THREE.Color(PALETTE.skyHorizon) },
      bot: { value: new THREE.Color(0x1a1420) },
    },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 bot;' +
      'void main(){ float h = normalize(vP).y; vec3 c = h > 0.12 ? mix(mid, top, smoothstep(0.12, 0.65, h)) : mix(mid, bot, smoothstep(0.12, -0.25, h)); gl_FragColor = vec4(c, 1.0); }',
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));
}
scene.fog = new THREE.Fog(PALETTE.fog, 55, 130);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 300);

const hemi = new THREE.HemisphereLight(0x8a7ab8, 0x2a2118, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xff9a52, 1.6);
sun.position.set(-30, 28, -40);
scene.add(sun);
configureSun(THREE, sun, hemi);
for (const [lx, lz] of [[-20, 0], [0, -20], [20, 20], [0, 20]]) {
  const lamp = new THREE.PointLight(PALETTE.lampGlow, 18, 26, 1.8);
  lamp.position.set(lx, 6, lz);
  scene.add(lamp);
}

function box(x0, z0, x1, z1, h, mat) {
  const m = mat && mat.isMaterial ? mat
    : new THREE.MeshStandardMaterial({ color: mat, roughness: 0.9, metalness: 0.05 });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, h, z1 - z0), m);
  mesh.position.set((x0 + x1) / 2, h / 2, (z0 + z1) / 2);
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(HALF * 2, HALF * 2),
  new THREE.MeshStandardMaterial({ map: makeFloorTexture(THREE), roughness: 0.8, metalness: 0.1 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(34, 34),
  new THREE.MeshStandardMaterial({ color: PALETTE.water, roughness: 0.15, metalness: 0.6 }));
water.rotation.x = -Math.PI / 2;
water.position.set(30, 0.02, 30);
scene.add(water);
for (let i = 0; i < WALLS.length; i++) {
  const w = WALLS[i];
  box(w[0], w[1], w[2], w[3], wallHeight(i), wallMaterial(THREE, i, w[2] - w[0], wallHeight(i)));
}
// Step ledges: the low pallets + two-step platform collide.js collides against.
for (const s of STEP_OBSTACLES) box(s.x0, s.z0, s.x1, s.z1, s.h, PALETTE.crate);
box(-38, -38, -14, -16, 0.4, wallMaterial(THREE, 4, 24, 5)).position.y = 5.2;
box(14, 16, 38, 38, 0.4, wallMaterial(THREE, 8, 24, 5)).position.y = 5.2;
function siteRing(site, color) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(site.r - 0.5, site.r, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(site.x, 0.06, site.z);
  scene.add(ring);
  const label = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25 }));
  label.rotation.x = -Math.PI / 2;
  label.position.set(site.x, 0.05, site.z);
  scene.add(label);
}
siteRing(SITE_A, PALETTE.siteA);
siteRing(SITE_B, PALETTE.siteB);
siteRing(SITE_C, 0xffd54f); // site C: east dock ("C Dock") — amber chalk
scene.add(buildSiteDecals(THREE)); scene.add(buildCalloutDecals(THREE));
for (const [lx, lz] of [[-20, 0], [0, -20], [20, 20], [0, 20]]) {
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 6, 8),
    new THREE.MeshStandardMaterial({ color: 0x222222 }));
  pole.position.set(lx, 3, lz);
  scene.add(pole);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 10, 8),
    new THREE.MeshBasicMaterial({ color: PALETTE.lampGlow }));
  bulb.position.set(lx, 6.1, lz);
  scene.add(bulb);
}

// Fighter meshes (pooled): body capsule + head, team-tinted.
const bodyGeo = new THREE.CapsuleGeometry(0.42, 0.75, 4, 10);
const headGeo = new THREE.SphereGeometry(0.24, 12, 10);
const fighterMeshes = new Map();
for (const f of fighters) {
  if (f.isPlayer && !SIM) continue; // first person: no own body mesh
  const mat = new THREE.MeshStandardMaterial({
    color: f.team === 'senja' ? PALETTE.teamSenja : PALETTE.teamBayang, roughness: 0.8 });
  const group = new THREE.Group();
  const bodyMesh = new THREE.Mesh(bodyGeo, mat);
  bodyMesh.position.y = 1.0;
  const headMesh = new THREE.Mesh(headGeo, new THREE.MeshStandardMaterial({ color: 0xd8c39a, roughness: 0.9 }));
  headMesh.position.y = 1.62;
  group.add(bodyMesh); group.add(headMesh);
  scene.add(group);
  fighterMeshes.set(f, group);
}
// Viewmodel gun: a dark rifle shape, bottom-right. It bobs with the stride,
// kicks per weapon, and carries the muzzle flash — a light at the barrel tip
// that fires exactly when fireHitscan runs, so flash and tracer agree.
const gunGroup = new THREE.Group();
let gunKick = 0; // 1 on a shot, decays in step(); scales with viewKick
let muzzleT = 0; // seconds of muzzle flash left
{
  const gm = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.45, metalness: 0.6 });
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.5), gm);
  barrel.position.set(0, 0, -0.26);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.13, 0.3), gm);
  stock.position.set(0, -0.02, 0.12);
  gunGroup.add(barrel); gunGroup.add(stock);
  gunGroup.position.set(0.28, -0.24, -0.5);
  camera.add(gunGroup);
  scene.add(camera);
}
const muzzleLight = new THREE.PointLight(0xffc46a, 0, 9, 2);
muzzleLight.position.set(0.28, -0.15, -1.0);
camera.add(muzzleLight);
const bombMesh = new THREE.Mesh(
  new THREE.BoxGeometry(0.5, 0.3, 0.35),
  new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xff2222, emissiveIntensity: 0.6 }));
bombMesh.visible = false;
scene.add(bombMesh);
const tracers = [];
for (let i = 0; i < 24; i++) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const m = new THREE.LineBasicMaterial({ color: PALETTE.tracer, transparent: true, opacity: 0 });
  const line = new THREE.Line(g, m);
  line.frustumCulled = false;
  scene.add(line);
  tracers.push({ line, life: 0 });
}
let tracerI = 0;
function spawnTracer(from, to) {
  const t = tracers[tracerI++ % tracers.length];
  const pos = t.line.geometry.attributes.position.array;
  pos[0] = from.x; pos[1] = from.y; pos[2] = from.z;
  pos[3] = to.x; pos[4] = to.y; pos[5] = to.z;
  t.line.geometry.attributes.position.needsUpdate = true;
  t.line.material.opacity = 0.9;
  t.life = 0.09;
}
const grenades = [];
for (let i = 0; i < 6; i++) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0x2f6b2f }));
  mesh.visible = false;
  scene.add(mesh);
  grenades.push({ mesh, active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fuse: 0, owner: null });
}
function throwGrenade(owner, tx, tz) {
  for (const g of grenades) {
    if (g.active) continue;
    g.active = true;
    g.x = owner.body.pos.x; g.y = 1.5 + owner.body.y; g.z = owner.body.pos.z;
    const dx = tx - g.x, dz = tz - g.z;
    const d = Math.hypot(dx, dz) || 1;
    g.vx = (dx / d) * 12; g.vz = (dz / d) * 12; g.vy = 6;
    g.fuse = 1.4;
    g.owner = owner;
    g.mesh.visible = true;
    return true;
  }
  return false;
}
// Smoke clouds: 4 pooled translucent spheres, synced from tactics.js smoke state.
const smokeMeshes = [];
for (let i = 0; i < 4; i++) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SMOKE_GRENADE.radius, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xcfd8dc, transparent: true, opacity: 0.55, depthWrite: false }));
  mesh.visible = false;
  scene.add(mesh);
  smokeMeshes.push(mesh);
}
function throwSmoke(owner, tx, tz) {
  addSmoke(tx, tz, now);
  return true;
}
function syncSmokeMeshes() {
  tickSmoke(now);
  const live = smokeClouds();
  for (let i = 0; i < smokeMeshes.length; i++) {
    const c = live[i];
    smokeMeshes[i].visible = !!c;
    if (c) smokeMeshes[i].position.set(c.x, 1.5, c.z);
  }
}
function explodeGrenade(g) {
  g.active = false;
  g.mesh.visible = false;
  sfx.explosion();
  const flash = new THREE.PointLight(0xffaa33, 60, 18, 2);
  flash.position.set(g.x, 1, g.z);
  scene.add(flash);
  setTimeout(() => scene.remove(flash), 250);
  for (const f of fighters) {
    if (!f.alive || f === g.owner) continue;
    const d = Math.hypot(f.body.pos.x - g.x, f.body.pos.z - g.z);
    if (d < GRENADE.radius && hasLineOfSight(g.x, g.z, f.body.pos.x, f.body.pos.z)) {
      const dmg = Math.round(GRENADE.damage * (1 - d / (GRENADE.radius * 1.4)));
      damageFighter(f, dmg, g.owner, false, 'granat');
    }
  }
}

// --- damage ---
function damageFighter(target, rawDmg, attacker, head, cause) {
  if (!target.alive) return;
  rawDmg = Math.round(rawDmg * headDamageFactor(target.wallet, head));
  const split = applyArmor(target.wallet, rawDmg);
  target.hp -= split.hpDamage;
  if (attacker) attacker.dmg = (attacker.dmg || 0) + split.hpDamage + split.armorDamage;
  if (target === hero && attacker && attacker.body) showDamageDir(attacker.body.pos.x, attacker.body.pos.z);
  if (target === hero) sfx.hurt();
  if (attacker === hero) showHitmarker(head, target.hp <= 0);
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.deaths++;
    if (attacker) {
      attacker.kills++;
      attacker.wallet.money += killRewardFor(attacker.gun ? attacker.gun.weaponId : 'pistol');
      if (attacker === hero) sfx.kill();
    }
    feedLine(`${attacker ? attacker.name : 'Dunia'} ⚔ ${target.name}${head ? ' (kepala)' : ''}${cause === 'granat' ? ' 💥' : ''}${attacker && attacker.gun ? ' · ' + WEAPONS[attacker.gun.weaponId].name : ''}`);
    // Bomb carrier died: the bomb DROPS where he fell. No auto-transfer —
    // anyone living can walk over it and pick it up (bomb.js tryPickup).
    if (bomb.carrier === target && bomb.state === 'carried') {
      target.hasBomb = false;
      dropBomb(bomb, target.body.pos.x, target.body.pos.z);
      feedLine(`💣 Bomb dropped at ${calloutAt(bomb.x, bomb.z)}`);
    }
  }
}

// --- input / HUD ---
const input = makeInput(renderer.domElement);
const hud = initHud();
initAudio();
document.addEventListener('pointerdown', initAudio, { once: true });

// Buy-menu clicks use event delegation: buildBuyList() can add catalogue buttons
// later and they must work too. buy* return {ok, reason} (an object is always
// truthy), so check .ok — the old boolean check gave free weapons on failures.
document.getElementById('buy-menu').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-buy]');
  if (!btn) return;
  const kind = btn.dataset.buy;
  const w = hero.wallet;
  if (kind === 'armor') {
    const r = buyArmor(w);
    if (r.ok) { sfx.buy(); feedLine('You bought a Kevlar Vest'); }
    buyFlash(r.ok);
  } else if (kind === 'helmet') {
    const r = buyHelmet(w);
    if (r.ok) { sfx.buy(); feedLine('You bought a Combat Helmet'); }
    buyFlash(r.ok);
  } else if (kind === 'grenade') {
    const r = buyGrenade(w);
    if (r.ok) { hero.grenades++; sfx.buy(); }
    buyFlash(r.ok);
  } else if (kind === 'smoke') {
    const r = buySmoke(w);
    if (r.ok) { hero.smokes = (hero.smokes || 0) + 1; sfx.buy(); }
    buyFlash(r.ok);
  } else {
    const r = buyWeapon(w, kind);
    if (r.ok) {
      hero.gun = makeGunState(kind);
      sfx.buy();
      feedLine('You bought ' + WEAPONS[kind].name);
    }
    buyFlash(r.ok);
  }
  document.getElementById('buy-money').textContent = '$' + w.money;
  buildBuyList(getShopItems, w.money); // refresh disabled states + prices
});

function heroAim(out) {
  const b = hero.body;
  const cp = Math.cos(hero.pitch), sp = Math.sin(hero.pitch);
  out.x = -Math.sin(b.yaw) * cp;
  out.y = sp;
  out.z = -Math.cos(b.yaw) * cp;
  return out;
}
const _aimDir = { x: 0, y: 0, z: 0 };
const _origin = { x: 0, y: 0, z: 0 };

// --- round flow ---
function setupRound() {
  // Reset positions, health, guns; the bomb goes to a random living attacker,
  // on the round's live site (rotates A -> B -> C).
  const spawnsS = [...SPAWN_SENJA], spawnsB = [...SPAWN_BAYANG];
  const attackers = match.attackers;
  const defenders = attackers === 'senja' ? 'bayang' : 'senja';
  const activeSite = activeSiteForRound(match.round);
  resetPlayer(player, spawnsS[0]);
  player.wallet.armor = 0;
  player.wallet.helmet = false;
  player.smokes = 0;
  // Defenders hold near the live site; HOLD_SPOTS sorted by distance, nearest first.
  const site = siteById(activeSite);
  const holds = HOLD_SPOTS.slice().sort((a, b) =>
    ((a.x - site.x) ** 2 + (a.z - site.z) ** 2) - ((b.x - site.x) ** 2 + (b.z - site.z) ** 2));
  let holdI = 0;
  bots.forEach((b, i) => {
    resetBot(b, b.team === 'senja' ? spawnsS[i % (TEAM_SIZE - 1) + 1] : spawnsB[i % TEAM_SIZE]);
    b.wallet.armor = 0;
    b.wallet.helmet = false;
    if (b.team === defenders) b.hold = holds[holdI++ % holds.length];
  });
  if (SIM) {
    resetBot(simPlayerBot, spawnsS[0]);
    simPlayerBot.isPlayer = true;
    if (simPlayerBot.team === defenders) simPlayerBot.hold = holds[holdI++ % holds.length];
  }
  for (const f of fighters) {
    f.hp = 100;
    f.body.crouchAmt = 0; // fresh stance each round (L-Move)
    const g = fighterMeshes.get(f);
    if (g) g.visible = true;
  }
  const carrier = pick(rng, fighters.filter((f) => f.team === attackers));
  resetBomb(bomb, carrier, activeSite);
  carrier.hasBomb = true;
  bombMesh.visible = false;
  startRound(match);
  setBuyVisible(true);
  buildBuyList(getShopItems, hero.wallet.money); // catalog prices + disabled states
  document.getElementById('buy-money').textContent = '$' + hero.wallet.money;
  for (const f of fighters) if (!f.isPlayer) botBuy(f);
  if (SIM) botBuy(simPlayerBot);
  showBanner('ROUND ' + match.round + ' — SITE ' + activeSite,
    (match.round === HALF_ROUND ? 'SECOND HALF — sides swap. ' : '') +
    (attackers === 'senja' ? 'Senja attacks' : 'Bayang attacks') +
    ' — plant the bomb at site ' + activeSite);
}

function finishRound(winner, reason) {
  if (match.phase === 'over') return;
  endRound(match, winner, reason, fighters);
  simStats.rounds++;
  if (winner === 'senja') simStats.senja++; else simStats.bayang++;
  setBuyVisible(false);
  const won = winner === 'senja';
  showBanner(won ? 'SENJA WINS' : 'BAYANG WINS',
    reason === 'explosion' ? 'Bomb detonated at the site' :
    reason === 'defuse' ? 'Bomb defused' :
    reason === 'time' ? 'Time up — defence holds' : 'Enemy team eliminated');
  if (won) sfx.roundWin(); else sfx.roundLose();
  if (match.matchWinner) {
    const mw = match.matchWinner;
    setEndScreen(
      mw === 'senja' ? 'SENJA WINS  ' + match.scoreSenja + '–' + match.scoreBayang :
      mw === 'bayang' ? 'BAYANG WINS  ' + match.scoreBayang + '–' + match.scoreSenja :
      'DRAW  ' + match.scoreSenja + '–' + match.scoreBayang,
      'Match over — Pelabuhan Senja');
  }
}

function aliveCount(team) {
  return fighters.filter((f) => f.team === team && f.alive).length;
}

// --- plant / defuse channels ---
function tickObjective(dt) {
  const attackers = match.attackers;
  const defenders = attackers === 'senja' ? 'bayang' : 'senja';
  // Dropped bomb: any living fighter that walks over it picks it up.
  if (bomb.state === 'dropped') {
    for (const f of fighters) {
      if (tryPickup(bomb, f)) { feedLine(`${f.name} mengambil bom 💣`); break; }
    }
  }
  for (const f of fighters) {
    if (!f.alive || f.team !== attackers || !f.hasBomb || bomb.state !== 'carried') continue;
    const site = siteAt(f.body.pos.x, f.body.pos.z);
    if (!site || site !== bomb.activeSite) { f.planting = 0; continue; }
    const enemiesNear = fighters.some((e) => e.team === defenders && e.alive &&
      Math.hypot(e.body.pos.x - f.body.pos.x, e.body.pos.z - f.body.pos.z) < 14 &&
      hasLineOfSight(f.body.pos.x, f.body.pos.z, e.body.pos.x, e.body.pos.z));
    const wantsPlant = (f.isPlayer && !SIM) ? input.down('KeyE') : !enemiesNear;
    if (!wantsPlant) { f.planting = 0; continue; }
    f.planting += dt / PLANT_TIME;
    if (Math.random() < dt * 3) sfx.plantBeep();
    if (f.planting >= 1) {
      bomb.state = 'planted';
      bomb.site = site;
      bomb.x = f.body.pos.x; bomb.z = f.body.pos.z;
      bomb.fuse = FUSE_TIME;
      f.hasBomb = false;
      f.planting = 0;
      f.wallet.money += PLANT_BONUS;
      simStats.plants++;
      bombMesh.visible = true;
      bombMesh.position.set(bomb.x, 0.35, bomb.z);
      feedLine(`${f.name} planted the bomb at site ${site} 💣`);
      showBanner('BOMB PLANTED — SITE ' + site, defenders === 'bayang' ? 'Bayang must defuse within 40 seconds' : 'Senja must defuse within 40 seconds');
    }
  }
  // Defenders defuse: inside the planted site, no attacker visible, hold 5 s.
  if (bomb.state === 'planted') {
    for (const f of fighters) {
      if (!f.alive || f.team !== defenders) continue;
      const d = Math.hypot(f.body.pos.x - bomb.x, f.body.pos.z - bomb.z);
      if (d > 3) { f.defusing = 0; continue; }
      const threat = fighters.some((e) => e.team === attackers && e.alive &&
        Math.hypot(e.body.pos.x - f.body.pos.x, e.body.pos.z - f.body.pos.z) < 16 &&
        hasLineOfSight(f.body.pos.x, f.body.pos.z, e.body.pos.x, e.body.pos.z));
      const wantsDefuse = (f.isPlayer && !SIM) ? input.down('KeyE') : !threat;
      if (!wantsDefuse) { f.defusing = 0; continue; }
      f.defusing += dt / DEFUSE_TIME;
      if (Math.random() < dt * 3) sfx.plantBeep();
      if (f.defusing >= 1) {
        bomb.state = 'defused';
        simStats.defuses++;
        f.wallet.money += DEFUSE_BONUS;
        feedLine(`${f.name} menjinakkan bom ✓`);
        finishRound(defenders, 'defuse');
        return;
      }
    }
    const ev = tickBomb(bomb, dt);
    if (ev === 'exploded') {
      simStats.explosions++;
      sfx.explosion();
      bombMesh.visible = false;
      for (const f of fighters) {
        if (!f.alive) continue;
        const d = Math.hypot(f.body.pos.x - bomb.x, f.body.pos.z - bomb.z);
        if (d < 9) damageFighter(f, 200, null, false, 'ledakan');
      }
      finishRound('senja', 'explosion');
    }
  }
}

// --- one fixed step ---
function step(dt) {
  now += dt;
  // Debug-only A/B metric: live-phase seconds, so kills/min compare fairly.
  if (match.phase === 'live') simStats.liveSeconds += dt;
  const clockEv = tickMatch(match, dt);
  if (clockEv === 'live') {
    setBuyVisible(false);
    showBanner('ROUND START', 'Plant the bomb at the live site — or eliminate Bayang');
  } else if (clockEv === 'time') {
    if (bomb.state === 'planted') { /* fuse decides */ }
    else finishRound('bayang', 'time');
  } else if (clockEv === 'next') {
    if (match.matchWinner) return; // match over, freeze
    nextRound(match);
    setupRound();
  }
  if (match.phase === 'over') return;

  if (match.phase === 'live' || match.phase === 'buy') {
    if (SIM) {
      const foes = fighters.filter((f) => f.team === 'bayang');
      const wasStrafing = simPlayerBot.strafing;
      if (match.phase === 'live' && !IDLEPLAYER) {
        stepBot(simPlayerBot, foes, bomb, now, dt, _botEvents, simStats, match.attackers);
      } else { _botEvents.fired = false; }
      if (simPlayerBot.strafing && !wasStrafing) simStats.strafes++;
      if (_botEvents.fired) {
        heroShotEffects(_botEvents, simPlayerBot);
      }
      if (_botEvents.reloaded) {
        for (const o of fighters) if (o !== simPlayerBot && o.team !== simPlayerBot.team) hearReload(o, simPlayerBot.body.pos.x, simPlayerBot.body.pos.z, now);
      }
    } else {
      stepPlayer(hero, input, dt, _pEvents);
      if (input.hit('KeyB') && match.phase === 'buy') {
        const m = document.getElementById('buy-menu');
        setBuyVisible(m.style.display !== 'block');
      }
      if (input.hit('Digit1')) hero.gun = makeGunState('pistol');
      if (input.hit('KeyG') && hero.grenades > 0) {
        hero.grenades--;
        const dir = heroAim(_aimDir);
        throwGrenade(hero, hero.body.pos.x + dir.x * 14, hero.body.pos.z + dir.z * 14);
      }
      if (input.hit('KeyF') && (hero.smokes || 0) > 0) {
        hero.smokes--;
        const dir = heroAim(_aimDir);
        throwSmoke(hero, hero.body.pos.x + dir.x * 10, hero.body.pos.z + dir.z * 10);
        simStats.smokes++;
      }
      if (_pEvents.fired) {
        heroAim(_aimDir);
        _origin.x = hero.body.pos.x; _origin.y = 1.62 + hero.body.y; _origin.z = hero.body.pos.z;
        fireHitscan(_origin, _aimDir, hero.gun, rng, hero,
          fighters.filter((f) => f.team === 'bayang'), _pelletOut);
        heroShotEffects({ fired: true, from: _origin, to: null, hit: false }, hero, _pelletOut);
        simStats.shots += _pelletOut.length;
        sfx.shot(hero.gun.weaponId);
        for (const b of bots) hearShot(b, hero.body.pos.x, hero.body.pos.z, now);
      }
      if (_pEvents.reloaded) {
        sfx.reload();
        // Reloads carry: nearby enemies may hear them.
        for (const o of fighters) {
          if (o !== hero && o.team !== hero.team) hearReload(o, hero.body.pos.x, hero.body.pos.z, now);
        }
      }
    }
  }

  for (const b of bots) {
    if (!b.alive || match.phase !== 'live') continue;
    const foes = b.team === 'senja'
      ? fighters.filter((f) => f.team === 'bayang')
      : fighters.filter((f) => f.team === 'senja');
    const wasStrafing = b.strafing;
    stepBot(b, foes, bomb, now, dt, _botEvents, simStats, match.attackers);
    if (b.strafing && !wasStrafing) simStats.strafes++;
    if (_botEvents.fired) {
      b.lastFiredAt = now; // minimap "heard shooting" evidence (spotted set, see hud.js header)
      heroShotEffects(_botEvents, b);
      for (const o of fighters) if (o !== b) hearShot(o, b.body.pos.x, b.body.pos.z, now);
      if (Math.hypot(b.body.pos.x - hero.body.pos.x, b.body.pos.z - hero.body.pos.z) < 30) sfx.distantShot();
    }
    if (_botEvents.reloaded) {
      for (const o of fighters) if (o !== b && o.team !== b.team && !(o.isPlayer && !SIM)) hearReload(o, b.body.pos.x, b.body.pos.z, now);
    }
    if (b.grenades > 0 && b.target && rng() < dt * 0.15) {
      b.grenades--;
      throwGrenade(b, b.target.body.pos.x, b.target.body.pos.z);
    }
    if (b.smokes > 0 && b.team === match.attackers && bomb.state === 'carried') {
      const site = siteById(bomb.activeSite);
      const dSite = Math.hypot(b.body.pos.x - site.x, b.body.pos.z - site.z);
      if (dSite < 14 && rng() < dt * 0.12) {
        b.smokes--;
        throwSmoke(b, site.x, site.z);
        simStats.smokes++;
      }
    }
  }

  // Footsteps: every ~2.2 m walked, a fighter's steps reach ENEMY fighters
// through the hearing bus (walls muffle, crouching is quieter). Same-team
  if (match.phase === 'live') {
    for (const f of fighters) {
      if (!f.alive) continue;
      const sp = Math.hypot(f.body.vel.x, f.body.vel.z);
      if (sp < 0.6) continue;
      f.stepAcc = (f.stepAcc || 0) + sp * dt;
      if (f.stepAcc < 2.2) continue;
      f.stepAcc = 0;
      for (const o of fighters) {
        if (o === f || !o.alive || o.team === f.team || (o.isPlayer && !SIM)) continue;
        hearFootstep(o, f.body.pos.x, f.body.pos.z, now, f.body.crouched);
      }
    }
  }

  for (const g of grenades) {
    if (!g.active) continue;
    stepGrenade(g, dt);
    g.mesh.position.set(g.x, g.y, g.z);
    g.fuse -= dt;
    if (g.fuse <= 0) explodeGrenade(g);
  }
  syncSmokeMeshes();

  if (bomb.state === 'dropped') {
    bombMesh.visible = true;
    bombMesh.position.set(bomb.x, 0.15, bomb.z);
  }

  if (match.phase === 'live') tickObjective(dt);

  if (match.phase === 'live') {
    const sAlive = aliveCount('senja'), bAlive = aliveCount('bayang');
    if (sAlive === 0 && bomb.state !== 'planted') finishRound('bayang', 'elimination');
    else if (sAlive === 0 && bomb.state === 'planted') { /* defenders must defuse */ }
    else if (bAlive === 0 && bomb.state !== 'planted') finishRound('senja', 'elimination');
    else if (bAlive === 0 && bomb.state === 'planted') { /* wait for the fuse */ }
  }

  // Spotted set for the minimap: a Bayang counts as spotted when any Senja
// can actually see it (canSee: range + cone + LOS) or it fired in the
// last 2 s.
  spotted.clear();
  for (const s of fighters.filter((f) => f.team === 'senja' && f.alive)) {
    for (const e of fighters.filter((f) => f.team === 'bayang' && f.alive)) {
      if (canSee(s, e) || (e.lastFiredAt !== undefined && now - e.lastFiredAt < 2)) spotted.add(e);
    }
  }
  // Viewmodel kick + muzzle flash decay (fixed-step: flash lasts 45 ms).
  if (gunKick > 0) gunKick = Math.max(0, gunKick - dt * 5);
  if (muzzleT > 0) {
    muzzleT -= dt;
    if (muzzleT <= 0) muzzleLight.intensity = 0;
  }
  for (const t of tracers) {
    if (t.life > 0) {
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / 0.09) * 0.9;
    }
  }
  input.endFrame();
}

// Apply a shot's results: tracer, damage, sounds. ev carries from/to/hit;
function heroShotEffects(ev, shooter, pellets) {
  if (shooter === hero) { muzzleT = 0.045; muzzleLight.intensity = 20; gunKick = 1; }
  const from = ev.from || { x: shooter.body.pos.x, y: 1.45 + shooter.body.y, z: shooter.body.pos.z };
  if (pellets) {
    for (const r of pellets) {
      // The pellet's own dx/dy/dz is the true fired direction; _aimDir is only the pre-recoil aim.
      const d = (r.dx !== undefined) ? { x: r.dx, y: r.dy, z: r.dz } : _aimDir;
      const to = { x: from.x + d.x * r.dist, y: from.y + d.y * r.dist, z: from.z + d.z * r.dist };
      spawnTracer(from, to);
      if (r.hit) {
        damageFighter(r.target, r.damage, shooter, r.head, 'tembak');
        simStats.hits++;
        if (r.head) sfx.headshot(); else sfx.hit();
      }
    }
    return;
  }
  const to = ev.to || from;
  spawnTracer(from, to);
  if (ev.hit && ev.target) {
    damageFighter(ev.target, ev.dmg, shooter, ev.head, 'tembak');
  }
}

// --- render ---
function render() {
  const b = hero.body;
  // Smooth-crouch eye height; ADS narrows the FOV toward 75 / zoom.
  const eye = b.eyeHeight || (b.crouched ? 1.15 : 1.62);
  camera.position.set(b.pos.x, eye + b.y, b.pos.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = b.yaw;
  camera.rotation.x = hero.pitch || 0;
  camera.rotation.z = 0;
  const targetFov = 75 / (hero.zoomF || 1);
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }
  const spd = Math.hypot(b.vel.x, b.vel.z);
  const bobA = Math.min(1, spd / WALK_SPEED) * ((hero.zoomF || 1) > 1.2 ? 0.25 : 1);
  const adsK = 1 - 1 / (hero.zoomF || 1); // 0 hip-fire, 0.67 scoped
  const vk = WEAPONS[hero.gun.weaponId].viewKick;
  gunGroup.position.set(
    0.28 * (1 - adsK) + Math.sin(now * 9) * 0.012 * bobA,
    -0.24 + adsK * 0.05 + Math.abs(Math.cos(now * 9)) * 0.010 * bobA - gunKick * vk * 0.5,
    -0.5 + gunKick * vk);
  gunGroup.rotation.x = gunKick * vk * 1.5;
  for (const [f, g] of fighterMeshes) {
    if (!f.alive) { g.visible = false; continue; }
    g.visible = true;
    g.position.set(f.body.pos.x, f.body.y, f.body.pos.z);
    g.rotation.y = f.body.yaw;
  }
  if (bomb.state === 'planted') {
    bombMesh.material.emissiveIntensity = 0.4 + Math.abs(Math.sin(now * 6)) * 0.8;
  } else if (bomb.state === 'dropped') {
    bombMesh.material.emissiveIntensity = 0.4 + Math.abs(Math.sin(now * 2)) * 0.4;
  }
  renderer.render(scene, camera);
}

// --- HUD refresh + debug ---
let hudT = 0;
function refreshHud(dt) {
  hudT += dt;
  if (hudT < 0.25) return;
  hudT = 0;
  updateHud({ player: hero, wallet: hero.wallet, match, bomb, fighters, now, spotted, minimap: buildMinimapSnapshot({ hero, fighters, spotted, bomb, now }) });
  window.__game = {
    round: match.round, phase: match.phase,
    scoreSenja: match.scoreSenja, scoreBayang: match.scoreBayang,
    aliveSenja: aliveCount('senja'), aliveBayang: aliveCount('bayang'),
    bomb: bomb.state, bombSite: bomb.site, activeSite: bomb.activeSite,
    attackers: match.attackers, half: match.half,
    shots: simStats.shots, hits: simStats.hits, strafes: simStats.strafes,
    plants: simStats.plants, defuses: simStats.defuses, smokes: simStats.smokes,
    kills: fighters.reduce((s, f) => s + (f.kills || 0), 0), liveSeconds: Math.round(simStats.liveSeconds),
    heroHp: Math.ceil(hero.hp), heroMoney: hero.wallet.money,
    matchWinner: match.matchWinner,
    simRounds: simStats.rounds, simSenja: simStats.senja, simBayang: simStats.bayang,
  };
  if (!DEBUG) return;
  const acc = simStats.shots ? (100 * simStats.hits / simStats.shots).toFixed(1) : '0';
  setDebug(
    `v2 sim=${SIM ? 1 : 0} round=${match.round} phase=${match.phase} score=${match.scoreSenja}:${match.scoreBayang}\n` +
    `alive senja=${aliveCount('senja')} bayang=${aliveCount('bayang')} bomb=${bomb.state} ${bomb.site || ''}\n` +
    `shots=${simStats.shots} hits=${simStats.hits} acc=${acc}% strafes=${simStats.strafes} plants=${simStats.plants}\n` +
    `hero hp=${Math.ceil(hero.hp)} money=$${hero.wallet.money} armor=${hero.wallet.armor} gun=${hero.gun.weaponId} ${hero.gun.ammo}/${hero.gun.reserve}`);
}

function runSelfTest() {
  const out = {};
  try {
    const shooter = { body: { pos: { x: 0, z: 10 } }, alive: true };
    const target = { body: { pos: { x: 0, z: 0 } }, alive: true };
    const r1 = firePellet({ x: 0, y: 1.05, z: 10 }, { x: 0, y: 0, z: -1 }, 'rifle', shooter, [target]);
    out.hitscanBody = r1.hit === true && r1.head === false && r1.damage === 36;
    const r2 = firePellet({ x: 0, y: 1.52, z: 10 }, { x: 0, y: 0, z: -1 }, 'rifle', shooter, [target]);
    out.hitscanHead = r2.hit === true && r2.head === true && r2.damage === 72;
    const g = makeGunState('rifle');
    const sStill = currentSpread(g, false, false, false);
    const sMove = currentSpread(g, true, false, false);
    const sCrouch = currentSpread(g, false, false, true);
    out.spread = sMove > sStill && sCrouch < sStill;
    const w = makeWallet(); w.armor = 100;
    const split = applyArmor(w, 40);
    out.armor = split.hpDamage === 20 && split.armorDamage === 20 && w.armor === 80;
    out.lossStreak = lossBonusFor(1) === 1900 && lossBonusFor(2) === 2400 &&
      lossBonusFor(3) === 2900 && lossBonusFor(9) === 3400;
    const p = findPath(SPAWN_SENJA[0].x, SPAWN_SENJA[0].z, SITE_A.x, SITE_A.z);
    out.astar = !!p && p.length >= 2 && p.length < 30 &&
      Math.abs(p[p.length - 1].x - SITE_A.x) < 0.01 &&
      Math.abs(p[p.length - 1].z - SITE_A.z) < 0.01;
    const pB = findPath(SPAWN_SENJA[0].x, SPAWN_SENJA[0].z, SITE_B.x, SITE_B.z);
    out.astarB = !!pB && pB.length >= 2;
    out.recoil = WEAPONS.rifle.recoil.length === 12 && WEAPONS.rifle.recoil[0][0] > 0;
    out.los = hasLineOfSight(0, 0, 10, 0) === true && hasLineOfSight(-30, -30, -30, -37) === false;
    // a fighter 10 m away cannot.
    const b0 = makeBomb();
    const carrier0 = { body: { pos: { x: 1, z: 2 } }, alive: true, hasBomb: true };
    resetBomb(b0, carrier0, 'B');
    out.bombDrop = dropBomb(b0, 1, 2) === true && b0.state === 'dropped' && b0.carrier === null;
    const mate = { body: { pos: { x: 1.5, z: 2 } }, alive: true, hasBomb: false };
    out.bombPickup = tryPickup(b0, mate) === true && b0.state === 'carried' && mate.hasBomb === true;
    const b1 = makeBomb();
    resetBomb(b1, carrier0, 'A'); dropBomb(b1, 0, 0);
    const far = { body: { pos: { x: 10, z: 10 } }, alive: true, hasBomb: false };
    out.bombPickupFar = tryPickup(b1, far) === false && b1.state === 'dropped';
    out.siteRotation = activeSiteForRound(1) === 'A' && activeSiteForRound(2) === 'B' && activeSiteForRound(3) === 'C' && activeSiteForRound(4) === 'A';
    out.siteAtC = siteAt(30, 8) === 'C' && siteAt(-26, -27) === 'A' && siteAt(26, 27) === 'B' && siteAt(0, 0) === null;
    const hearOpen = hearCheck(0, 0, 10, 0, 'footstep');
    out.hearing = !!hearOpen && !hearOpen.muffled && hearCheck(0, 0, 20, 0, 'footstep') === null &&
      hearCheck(-20, -27, -10, -27, 'footstep') === null && !!hearCheck(0, 0, 16, 0, 'reload');
    // into a wall reflects its horizontal velocity.
    const g0 = { x: 0, y: 0.2, z: 0, vx: 0, vy: -8, vz: 0 };
    stepGrenade(g0, 1 / 60);
    out.grenadeBounce = g0.y === 0.12 && g0.vy > 0;
    const g1 = { x: -15.5, y: 1, z: -27, vx: 5, vy: 0, vz: 0 };
    stepGrenade(g1, 1 / 60);
    out.grenadeWall = g1.vx < 0 && g1.x === -15.5;
    clearSmokes(); addSmoke(0, 0, 100);
    out.smoke = isSmoked(0, 0, 101) && !isSmoked(20, 20, 101) && segmentSmoked(-10, 0, 10, 0, 101) && !segmentSmoked(-10, 20, 10, 20, 101) && !isSmoked(0, 0, 115);
    clearSmokes();
    const wH = makeWallet(); wH.helmet = true;
    out.helmet = headDamageFactor(wH, true) === 0.5 && headDamageFactor(wH, false) === 1 && headDamageFactor(makeWallet(), true) === 1;
    out.killReward = killRewardFor('sniper') === 100 && killRewardFor('marksman') === 150 && killRewardFor('rifle') === 300 && killRewardFor('pistol') === 300;
    const m0 = makeMatch();
    for (let i = 0; i < 6; i++) nextRound(m0);
    out.sideSwap = m0.round === 7 && m0.attackers === 'bayang' && m0.half === true && WIN_ROUNDS === 7 && MAX_ROUNDS === 12;
    out.sniper = !!WEAPONS.sniper && WEAPONS.sniper.price === 4750 && WEAPONS.sniper.headMult === 4 && WEAPONS.sniper.scoped === true && WEAPONS.sniper.damage === 110;
    out.callouts = calloutAt(-26, -27) === 'A Site' && calloutAt(0, 0) === 'Mid' && calloutAt(30, 8) === 'C Dock' && calloutAt(-33, -12) === 'A Long' && calloutAt(26, 27) === 'B Site';
    out.pass = Object.values(out).every(Boolean);
  } catch (e) {
    out.error = String(e && e.message || e);
    out.pass = false;
  }
  const el = document.getElementById('selftest');
  if (el) el.textContent = JSON.stringify(out);
  window.__selftest = out;
  document.title = 'SELFTEST ' + (out.pass ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(out);
}

function applyPose() {
  if (POSE === 'combat') {
    match.phase = 'live'; match.phaseT = 80;
    setBuyVisible(false);
    document.getElementById('banner-wrap').style.opacity = '0';
    hero.body.pos.x = 0; hero.body.pos.z = 8;
    hero.body.yaw = 0; // face north (-z), toward the foe at mid
    const foe = bots.find((b) => b.team === 'bayang');
    foe.body.pos.x = 0; foe.body.pos.z = -6;
    foe.body.yaw = Math.PI; // face south, toward the hero
    foe.hold = { x: 0, z: -6 }; // hold this spot: a duel the camera can see
    foe.path = null;
    const mate = bots.find((b) => b.team === 'senja');
    mate.body.pos.x = -4; mate.body.pos.z = 6;
  } else if (POSE === 'plant') {
    match.phase = 'live'; match.phaseT = 60;
    setBuyVisible(false);
    document.getElementById('banner-wrap').style.opacity = '0';
    bomb.state = 'planted'; bomb.site = 'A';
    bomb.x = SITE_A.x; bomb.z = SITE_A.z; bomb.fuse = 32;
    bombMesh.visible = true;
    bombMesh.position.set(bomb.x, 0.35, bomb.z);
    addSmoke(SITE_A.x + 3, SITE_A.z, 0);
    const def = bots.find((b) => b.team === 'bayang');
    def.body.pos.x = SITE_A.x + 1; def.body.pos.z = SITE_A.z + 1; def.path = null;
    hero.body.pos.x = SITE_A.x + 10; hero.body.pos.z = SITE_A.z;
    hero.body.yaw = Math.PI / 2;
    hero.hasBomb = false;
  } else if (POSE === 'end') {
    match.phase = 'over'; match.phaseT = 5;
    match.winner = 'senja'; match.winReason = 'elimination';
    match.scoreSenja = 3; match.scoreBayang = 1;
    setBuyVisible(false);
    const pinEndBanner = () => {
      document.getElementById('banner').textContent = 'SENJA WINS';
      document.getElementById('banner-sub').textContent = 'Enemy team eliminated';
      document.getElementById('banner-wrap').style.opacity = '1';
    };
    pinEndBanner();
    setTimeout(pinEndBanner, 3000);
  }
}

setupRound();
applyPose();
if (SELFTEST) runSelfTest();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const STEP = 1 / 120; // fixed-step sim, 120 Hz (L-Move, was 60 Hz)
let last = performance.now();
let acc = 0;
function frame(t) {
  requestAnimationFrame(frame);
  if (FAST) {
    for (let i = 0; i < 120; i++) step(STEP);
    refreshHud(1);
    last = t;
    return;
  }
  let dt = (t - last) / 1000;
  last = t;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  let n = 0;
  while (acc >= STEP && n < 16) {
    step(STEP);
    acc -= STEP;
    n++;
  }
  render();
  refreshHud(dt);
}
requestAnimationFrame(frame);

// ?simrun=1: run the whole match synchronously (no rAF needed) so a
// headless shell can grade bot-vs-bot rounds in one dump: up to 12 rounds,
// ~126k fixed steps at 120 Hz; the result lands in #debug and the title.
if (params.get('simrun') === '1') {
  let n = 0;
  while (!match.matchWinner && n < 240000) { step(STEP); n++; }
  refreshHud(1);
  document.title = 'SIMRUN ' + JSON.stringify(window.__game);
}
