// main.js — Pelabuhan Senja v2: wiring, scene, fixed-step loop.
// One job: own the match. Everything else is a module with one job:
// map.js knows walls, weapons.js knows shots, bots.js knows AI,
// economy.js knows money, hud.js knows the screen, rounds.js the clock.
// This file builds the three.js harbour, steps the simulation at a fixed
// 60 Hz apart from rendering, and turns sim events into meshes, tracers
// and sound. No new objects in the hot loop: tracers, grenades and the
// pellet buffer are all pooled and reused.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { makeRng, pick } from './rng.js';
import {
  WALLS, SITE_A, SITE_B, SPAWN_SENJA, SPAWN_BAYANG, HALF,
  findPath, hasLineOfSight,
} from './map.js';
import {
  WEAPONS, GRENADE, makeGunState, currentSpread,
  fireHitscan, firePellet,
} from './weapons.js';
import {
  makeWallet, applyArmor, buyArmor, buyWeapon, buyGrenade, lossBonusFor, getShopItems,
  KILL_BONUS, PLANT_BONUS, DEFUSE_BONUS,
} from './economy.js';
import { makeBot, resetBot, botBuy, stepBot, hearShot, canSee, BOT_NAMES_SENJA, BOT_NAMES_BAYANG } from './bots.js';
import { makePlayer, resetPlayer, stepPlayer } from './player.js';
import { makeBomb, resetBomb, siteAt, tickBomb, PLANT_TIME, FUSE_TIME, DEFUSE_TIME } from './bomb.js';
import { makeMatch, startRound, tickMatch, endRound, nextRound, TEAM_SIZE } from './rounds.js';
import { makeInput } from './input.js';
import { initAudio, sfx } from './audio.js';
import { initHud, updateHud, showHitmarker, showBanner, feedLine, setBuyVisible, setEndScreen, setDebug, buildMinimapSnapshot, buyFlash, buildBuyList } from './hud.js';

const params = new URLSearchParams(location.search);
const SIM = params.get('sim') === '1';
const IDLEPLAYER = params.get('idleplayer') === '1'; // hero stands still (A/B fairness: like an idle human)
const FAST = params.get('fast') === '1'; // headless sim: many steps per frame, no render
const DEBUG = SIM || params.get('debug') === '1';
const POSE = params.get('pose') || '';
const SELFTEST = params.get('selftest') === '1';
const SEED = parseInt(params.get('seed') || '20261115', 10);
const rng = makeRng(SEED);

// --- state, all in one place ---------------------------------------------
const match = makeMatch();
const bomb = makeBomb();
const player = makePlayer(SPAWN_SENJA[0]);
player.wallet = makeWallet();
player.name = 'Kamu';
const bots = [];
for (let i = 0; i < TEAM_SIZE - 1; i++) bots.push(makeBot('senja', BOT_NAMES_SENJA[i], SPAWN_SENJA[i + 1], makeRng(SEED + 11 + i), i));
for (let i = 0; i < TEAM_SIZE; i++) bots.push(makeBot('bayang', BOT_NAMES_BAYANG[i], SPAWN_BAYANG[i], makeRng(SEED + 31 + i), i));
const fighters = [player, ...bots];
const simPlayerBot = SIM ? makeBot('senja', 'Kamu', SPAWN_SENJA[0], makeRng(SEED + 77), 0) : null;
if (SIM) {
  // In sim mode the "player" slot is AI-driven, so bot-vs-bot rounds run
  // with nobody touching a mouse. The camera still follows slot 0.
  fighters[0] = simPlayerBot;
  simPlayerBot.isPlayer = true;
}
const hero = fighters[0]; // slot 0: human, or the sim bot
const simStats = { rounds: 0, senja: 0, bayang: 0, shots: 0, hits: 0, strafes: 0, plants: 0, defuses: 0, explosions: 0, liveSeconds: 0 };
let now = 0;
const spotted = new Set(); // enemies spotted by any Senja fighter (minimap)
const _pelletOut = [];
const _botEvents = { fired: false, hit: false };
const _pEvents = { fired: false, reloaded: false, moved: false, speed: 0 };

// --- three.js scene --------------------------------------------------------
const container = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.className = 'webgl';
container.appendChild(renderer.domElement);
const scene = new THREE.Scene();
// Dusk sky dome: deep blue overhead, orange band at the horizon, dark below.
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
for (const [lx, lz] of [[-20, 0], [0, -20], [20, 20], [0, 20]]) {
  const lamp = new THREE.PointLight(PALETTE.lampGlow, 18, 26, 1.8);
  lamp.position.set(lx, 6, lz);
  scene.add(lamp);
}

function box(x0, z0, x1, z1, h, color) {
  const g = new THREE.BoxGeometry(x1 - x0, h, z1 - z0);
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.05 });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set((x0 + x1) / 2, h / 2, (z0 + z1) / 2);
  scene.add(mesh);
  return mesh;
}
// Ground: wet concrete apron, plus a water plane at the south-east dock.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(HALF * 2, HALF * 2),
  new THREE.MeshStandardMaterial({ color: PALETTE.ground, roughness: 0.75, metalness: 0.15 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const water = new THREE.Mesh(
  new THREE.PlaneGeometry(34, 34),
  new THREE.MeshStandardMaterial({ color: PALETTE.water, roughness: 0.15, metalness: 0.6 }));
water.rotation.x = -Math.PI / 2;
water.position.set(30, 0.02, 30);
scene.add(water);
// Walls + warehouse roofs.
const wallColors = [PALETTE.warehouse, PALETTE.containerRust, PALETTE.containerTeal, PALETTE.containerOchre, PALETTE.crate];
for (let i = 0; i < WALLS.length; i++) {
  const w = WALLS[i];
  const isBorder = i < 4;
  const h = isBorder ? 3.2 : (i < 8 ? 5 : (i < 18 ? 2.6 : 1.4));
  box(w[0], w[1], w[2], w[3], h, wallColors[i % wallColors.length]);
}
// Warehouse roof slabs over the two site buildings.
box(-38, -38, -14, -16, 0.4, PALETTE.warehouseRoof).position.y = 5.2;
box(14, 16, 38, 38, 0.4, PALETTE.warehouseRoof).position.y = 5.2;
// Site markers: flat chalk rings on the ground.
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
// A few lamp posts (visual only).
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

// Fighter meshes: body capsule + head, team-tinted. Pooled, one per bot.
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
// Viewmodel gun: a simple dark rifle shape at the bottom-right of the view.
const gunGroup = new THREE.Group();
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
// Bomb mesh: small blinking box, hidden until planted.
const bombMesh = new THREE.Mesh(
  new THREE.BoxGeometry(0.5, 0.3, 0.35),
  new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xff2222, emissiveIntensity: 0.6 }));
bombMesh.visible = false;
scene.add(bombMesh);
// Tracer pool: 24 reusable lines, each fades out over 90 ms.
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
// Grenades: pooled ballistic points with a fuse.
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

// --- damage ---------------------------------------------------------------
function damageFighter(target, rawDmg, attacker, head, cause) {
  if (!target.alive) return;
  const split = applyArmor(target.wallet, rawDmg);
  target.hp -= split.hpDamage;
  if (target === hero) sfx.hurt();
  if (attacker === hero) showHitmarker(head, target.hp <= 0);
  if (target.hp <= 0) {
    target.hp = 0;
    target.alive = false;
    target.deaths++;
    if (attacker) {
      attacker.kills++;
      attacker.wallet.money += KILL_BONUS;
      if (attacker === hero) sfx.kill();
    }
    feedLine(`${attacker ? attacker.name : 'Dunia'} ⚔ ${target.name}${head ? ' (kepala)' : ''}${cause === 'granat' ? ' 💥' : ''}`);
    // Bomb carrier died: the bomb passes to a living Senja teammate.
    if (bomb.carrier === target && bomb.state === 'carried') {
      const next = fighters.find((f) => f.team === 'senja' && f.alive && f !== target);
      bomb.carrier = next || null;
      if (next) next.hasBomb = true;
      target.hasBomb = false;
    }
  }
}

// --- input / HUD ------------------------------------------------------------
const input = makeInput(renderer.domElement);
const hud = initHud();
initAudio();
document.addEventListener('pointerdown', initAudio, { once: true });

// Delegated: buildBuyList() can add catalog buttons later (e.g. pistol) and
// they must work too — a one-time querySelectorAll binding would miss them.
// buy* return {ok, reason} (an object is always truthy), so check .ok —
// the old boolean check gave free weapons/grenades on failed purchases.
document.getElementById('buy-menu').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-buy]');
  if (!btn) return;
  const kind = btn.dataset.buy;
  const w = hero.wallet;
  if (kind === 'armor') {
    const r = buyArmor(w);
    if (r.ok) { sfx.buy(); feedLine('Kamu membeli Rompi Kevlar'); }
    buyFlash(r.ok);
  } else if (kind === 'grenade') {
    const r = buyGrenade(w);
    if (r.ok) { hero.grenades++; sfx.buy(); }
    buyFlash(r.ok);
  } else {
    const r = buyWeapon(w, kind);
    if (r.ok) {
      hero.gun = makeGunState(kind);
      sfx.buy();
      feedLine('Kamu membeli ' + WEAPONS[kind].name);
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

// --- round flow --------------------------------------------------------------
function setupRound() {
  // Reset positions, health, guns; bomb goes to a random living Senja.
  const spawnsS = [...SPAWN_SENJA], spawnsB = [...SPAWN_BAYANG];
  resetPlayer(player, spawnsS[0]);
  player.wallet.armor = 0;
  if (SIM) {
    resetBot(simPlayerBot, spawnsS[0]);
    simPlayerBot.isPlayer = true;
  }
  bots.forEach((b, i) => {
    resetBot(b, b.team === 'senja' ? spawnsS[i % (TEAM_SIZE - 1) + 1] : spawnsB[i % TEAM_SIZE]);
    b.wallet.armor = 0;
  });
  for (const f of fighters) {
    f.hp = 100;
    const g = fighterMeshes.get(f);
    if (g) g.visible = true;
  }
  const carrier = pick(rng, fighters.filter((f) => f.team === 'senja'));
  resetBomb(bomb, carrier);
  carrier.hasBomb = true;
  bombMesh.visible = false;
  startRound(match);
  setBuyVisible(true);
  buildBuyList(getShopItems, hero.wallet.money); // catalog prices + disabled states
  document.getElementById('buy-money').textContent = '$' + hero.wallet.money;
  for (const f of fighters) if (!f.isPlayer) botBuy(f);
  if (SIM) botBuy(simPlayerBot);
  showBanner('RONDE ' + match.round, match.round === 1 ? 'Senja menyerang — tanam bom di A atau B' : 'Fase persiapan — tekan B untuk beli');
}

function finishRound(winner, reason) {
  if (match.phase === 'over') return;
  endRound(match, winner, reason, fighters);
  simStats.rounds++;
  if (winner === 'senja') simStats.senja++; else simStats.bayang++;
  setBuyVisible(false);
  const won = winner === 'senja';
  showBanner(won ? 'SENJA MENANG' : 'BAYANG MENANG',
    reason === 'explosion' ? 'Bom meledak di situs' :
    reason === 'defuse' ? 'Bom dijinakkan' :
    reason === 'time' ? 'Waktu habis — pertahanan bertahan' : 'Tim musuh habis');
  if (won) sfx.roundWin(); else sfx.roundLose();
  if (match.matchWinner) {
    const mw = match.matchWinner;
    setEndScreen(
      mw === 'senja' ? 'SENJA MENANG  ' + match.scoreSenja + '–' + match.scoreBayang :
      mw === 'bayang' ? 'BAYANG MENANG  ' + match.scoreBayang + '–' + match.scoreSenja :
      'SERI  ' + match.scoreSenja + '–' + match.scoreBayang,
      'Pertandingan selesai — Pelabuhan Senja v2');
  }
}

function aliveCount(team) {
  return fighters.filter((f) => f.team === team && f.alive).length;
}

// --- plant / defuse channels --------------------------------------------------
function tickObjective(dt) {
  // Senja with the bomb, inside a site, holding E (or bot auto-plant).
  for (const f of fighters) {
    if (!f.alive || f.team !== 'senja' || !f.hasBomb || bomb.state !== 'carried') continue;
    const site = siteAt(f.body.pos.x, f.body.pos.z);
    if (!site) { f.planting = 0; continue; }
    const enemiesNear = fighters.some((e) => e.team === 'bayang' && e.alive &&
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
      feedLine(`${f.name} menanam bom di situs ${site} 💣`);
      showBanner('BOM DITANAM — SITUS ' + site, 'Bayang harus menjinakkan sebelum 40 detik');
    }
  }
  // Bayang defuse: inside the planted site, no Senja visible, hold 5 s.
  if (bomb.state === 'planted') {
    for (const f of fighters) {
      if (!f.alive || f.team !== 'bayang') continue;
      const site = bomb.site === 'A' ? SITE_A : SITE_B;
      const d = Math.hypot(f.body.pos.x - bomb.x, f.body.pos.z - bomb.z);
      if (d > 3) { f.defusing = 0; continue; }
      const threat = fighters.some((e) => e.team === 'senja' && e.alive &&
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
        finishRound('bayang', 'defuse');
        return;
      }
    }
    const ev = tickBomb(bomb, dt);
    if (ev === 'exploded') {
      simStats.explosions++;
      sfx.explosion();
      bombMesh.visible = false;
      // Blast kills everyone near the site, then the round ends.
      for (const f of fighters) {
        if (!f.alive) continue;
        const d = Math.hypot(f.body.pos.x - bomb.x, f.body.pos.z - bomb.z);
        if (d < 9) damageFighter(f, 200, null, false, 'ledakan');
      }
      finishRound('senja', 'explosion');
    }
  }
}

// --- one fixed step ------------------------------------------------------------
function step(dt) {
  now += dt;
  // Debug-only A/B metric: live-phase seconds (buy/over phases excluded),
  // so kills/min and shots/min compare fairly against v1's test window.
  if (match.phase === 'live') simStats.liveSeconds += dt;
  // Clock.
  const clockEv = tickMatch(match, dt);
  if (clockEv === 'live') {
    setBuyVisible(false);
    showBanner('RONDE DIMULAI', 'Tanam bom di A atau B — atau habisi Bayang');
  } else if (clockEv === 'time') {
    if (bomb.state === 'planted') { /* fuse decides */ }
    else finishRound('bayang', 'time');
  } else if (clockEv === 'next') {
    if (match.matchWinner) return; // match over, freeze
    nextRound(match);
    setupRound();
  }
  if (match.phase === 'over') return;

  // Hero step.
  if (match.phase === 'live' || match.phase === 'buy') {
    if (SIM) {
      const foes = fighters.filter((f) => f.team === 'bayang');
      const wasStrafing = simPlayerBot.strafing;
      if (match.phase === 'live' && !IDLEPLAYER) {
        stepBot(simPlayerBot, foes, bomb, now, dt, _botEvents, simStats);
      } else { _botEvents.fired = false; }
      if (simPlayerBot.strafing && !wasStrafing) simStats.strafes++;
      if (_botEvents.fired) {
        heroShotEffects(_botEvents, simPlayerBot);
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
      if (_pEvents.reloaded) sfx.reload();
    }
  }

  // Bots step.
  for (const b of bots) {
    if (!b.alive || match.phase !== 'live') continue;
    const foes = b.team === 'senja'
      ? fighters.filter((f) => f.team === 'bayang')
      : fighters.filter((f) => f.team === 'senja');
    const wasStrafing = b.strafing;
    stepBot(b, foes, bomb, now, dt, _botEvents, simStats);
    if (b.strafing && !wasStrafing) simStats.strafes++;
    if (_botEvents.fired) {
      b.lastFiredAt = now; // minimap "heard shooting" evidence (Lane M contract)
      heroShotEffects(_botEvents, b);
      for (const o of fighters) if (o !== b) hearShot(o, b.body.pos.x, b.body.pos.z, now);
      if (Math.hypot(b.body.pos.x - hero.body.pos.x, b.body.pos.z - hero.body.pos.z) < 30) sfx.distantShot();
    }
    // Bots toss a grenade at a visible foe now and then.
    if (b.grenades > 0 && b.target && rng() < dt * 0.15) {
      b.grenades--;
      throwGrenade(b, b.target.body.pos.x, b.target.body.pos.z);
    }
  }

  // Grenades fly.
  for (const g of grenades) {
    if (!g.active) continue;
    g.vy -= 12 * dt;
    g.x += g.vx * dt; g.y += g.vy * dt; g.z += g.vz * dt;
    if (g.y <= 0.12) { g.y = 0.12; g.vy = 0; g.vx *= 0.6; g.vz *= 0.6; }
    g.mesh.position.set(g.x, g.y, g.z);
    g.fuse -= dt;
    if (g.fuse <= 0) explodeGrenade(g);
  }

  // Objective channels + fuse.
  if (match.phase === 'live') tickObjective(dt);

  // Round end by elimination.
  if (match.phase === 'live') {
    const sAlive = aliveCount('senja'), bAlive = aliveCount('bayang');
    if (sAlive === 0 && bomb.state !== 'planted') finishRound('bayang', 'elimination');
    else if (sAlive === 0 && bomb.state === 'planted') { /* defenders must defuse */ }
    else if (bAlive === 0 && bomb.state !== 'planted') finishRound('senja', 'elimination');
    else if (bAlive === 0 && bomb.state === 'planted') { /* wait for the fuse */ }
  }

  // Spotted set for the minimap: a Bayang counts as spotted when any Senja
  // can actually see it (canSee: range + cone + LOS) or it fired in the
  // last 2 s. The old filter read the ENEMY's own lastSeen/heard (its
  // perception of us) — it missed visible foes facing away and leaked foes
  // nobody on Senja could see.
  spotted.clear();
  for (const s of fighters.filter((f) => f.team === 'senja' && f.alive)) {
    for (const e of fighters.filter((f) => f.team === 'bayang' && f.alive)) {
      if (canSee(s, e) || (e.lastFiredAt !== undefined && now - e.lastFiredAt < 2)) spotted.add(e);
    }
  }
  // Tracer fade.
  for (const t of tracers) {
    if (t.life > 0) {
      t.life -= dt;
      t.line.material.opacity = Math.max(0, t.life / 0.09) * 0.9;
    }
  }
  input.endFrame();
}

// Apply a shot's results: tracer, damage, sounds. ev carries from/to/hit;
// pellets (hero only) carry the per-pellet results.
function heroShotEffects(ev, shooter, pellets) {
  const from = ev.from || { x: shooter.body.pos.x, y: 1.45 + shooter.body.y, z: shooter.body.pos.z };
  if (pellets) {
    for (const r of pellets) {
      // The pellet's own dx/dy/dz is the true fired direction (aim + recoil
      // + spread); _aimDir is only the pre-recoil camera aim.
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
  // Bot shot: single reported pellet in ev.
  const to = ev.to || from;
  spawnTracer(from, to);
  if (ev.hit && ev.target) {
    damageFighter(ev.target, ev.dmg, shooter, ev.head, 'tembak');
    // Accuracy is counted once, in bots.js (stats.hits++ on the same hit).
  }
}

// --- render ---------------------------------------------------------------------
function render() {
  const b = hero.body;
  const eye = b.crouched ? 1.15 : 1.62;
  camera.position.set(b.pos.x, eye + b.y, b.pos.z);
  camera.rotation.order = 'YXZ';
  camera.rotation.y = b.yaw;
  camera.rotation.x = hero.pitch || 0;
  camera.rotation.z = 0;
  gunGroup.position.y = -0.24 + Math.sin(now * 1.4) * 0.004;
  for (const [f, g] of fighterMeshes) {
    if (!f.alive) { g.visible = false; continue; }
    g.visible = true;
    g.position.set(f.body.pos.x, f.body.y, f.body.pos.z);
    g.rotation.y = f.body.yaw;
  }
  if (bomb.state === 'planted') {
    bombMesh.material.emissiveIntensity = 0.4 + Math.abs(Math.sin(now * 6)) * 0.8;
  }
  renderer.render(scene, camera);
}

// --- HUD refresh + debug ----------------------------------------------------------
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
    bomb: bomb.state, bombSite: bomb.site,
    shots: simStats.shots, hits: simStats.hits, strafes: simStats.strafes,
    plants: simStats.plants, defuses: simStats.defuses,
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

// --- self-test (deterministic unit checks, ?selftest=1) ----------------------------
function runSelfTest() {
  const out = {};
  try {
    // (a) hitscan hits a still target, and a head aim scores a headshot.
    const shooter = { body: { pos: { x: 0, z: 10 } }, alive: true };
    const target = { body: { pos: { x: 0, z: 0 } }, alive: true };
    const r1 = firePellet({ x: 0, y: 1.05, z: 10 }, { x: 0, y: 0, z: -1 }, 'rifle', shooter, [target]);
    out.hitscanBody = r1.hit === true && r1.head === false && r1.damage === 36;
    const r2 = firePellet({ x: 0, y: 1.52, z: 10 }, { x: 0, y: 0, z: -1 }, 'rifle', shooter, [target]);
    out.hitscanHead = r2.hit === true && r2.head === true && r2.damage === 72;
    // (b) spread: moving > still, crouched < standing.
    const g = makeGunState('rifle');
    const sStill = currentSpread(g, false, false, false);
    const sMove = currentSpread(g, true, false, false);
    const sCrouch = currentSpread(g, false, false, true);
    out.spread = sMove > sStill && sCrouch < sStill;
    // (c) armor soaks half the damage.
    const w = makeWallet(); w.armor = 100;
    const split = applyArmor(w, 40);
    out.armor = split.hpDamage === 20 && split.armorDamage === 20 && w.armor === 80;
    // (d) loss-streak bonus grows and caps.
    out.lossStreak = lossBonusFor(1) === 1900 && lossBonusFor(2) === 2400 &&
      lossBonusFor(3) === 2900 && lossBonusFor(9) === 3400;
    // (e) A* path exists, ends on target, smoothed shorter than raw cells.
    const p = findPath(SPAWN_SENJA[0].x, SPAWN_SENJA[0].z, SITE_A.x, SITE_A.z);
    out.astar = !!p && p.length >= 2 && p.length < 30 &&
      Math.abs(p[p.length - 1].x - SITE_A.x) < 0.01 &&
      Math.abs(p[p.length - 1].z - SITE_A.z) < 0.01;
    const pB = findPath(SPAWN_SENJA[0].x, SPAWN_SENJA[0].z, SITE_B.x, SITE_B.z);
    out.astarB = !!pB && pB.length >= 2;
    // (f) recoil pattern: rifle climbs, 12 steps, first kick positive.
    out.recoil = WEAPONS.rifle.recoil.length === 12 && WEAPONS.rifle.recoil[0][0] > 0;
    // (g) LOS: spawn to mid is open, spawn into warehouse wall is not.
    out.los = hasLineOfSight(0, 0, 10, 0) === true && hasLineOfSight(-30, -30, -30, -37) === false;
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

// --- poses for honest screenshots ---------------------------------------------------
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
    // Stand east of site A, looking west across the ring at the bomb —
    // the partition wall stays out of the frame this way.
    hero.body.pos.x = SITE_A.x + 7; hero.body.pos.z = SITE_A.z;
    hero.body.yaw = Math.PI / 2;
    hero.hasBomb = false;
  } else if (POSE === 'end') {
    match.phase = 'over'; match.phaseT = 5;
    match.winner = 'senja'; match.winReason = 'elimination';
    match.scoreSenja = 3; match.scoreBayang = 1;
    setBuyVisible(false);
    // Persistent banner (no 2.6 s fade): the staged end shot must show it.
    // setupRound's own "RONDE 1" banner schedules a fade at 2.6 s, so
    // re-assert ours after it — the end pose is staging, not live play.
    const pinEndBanner = () => {
      document.getElementById('banner').textContent = 'SENJA MENANG';
      document.getElementById('banner-sub').textContent = 'Tim musuh habis';
      document.getElementById('banner-wrap').style.opacity = '1';
    };
    pinEndBanner();
    setTimeout(pinEndBanner, 3000);
  }
}

// --- boot ---------------------------------------------------------------------------
setupRound();
applyPose();
if (SELFTEST) runSelfTest();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const STEP = 1 / 60;
let last = performance.now();
let acc = 0;
function frame(t) {
  requestAnimationFrame(frame);
  if (FAST) {
    // Headless sim: 1 s of simulation per frame, no rendering at all.
    for (let i = 0; i < 60; i++) step(STEP);
    refreshHud(1);
    last = t;
    return;
  }
  let dt = (t - last) / 1000;
  last = t;
  if (dt > 0.25) dt = 0.25;
  acc += dt;
  let n = 0;
  while (acc >= STEP && n < 8) {
    step(STEP);
    acc -= STEP;
    n++;
  }
  render();
  refreshHud(dt);
}
requestAnimationFrame(frame);

// ?simrun=1: run the whole match synchronously (no rAF needed) so a
// headless shell can grade bot-vs-bot rounds in one dump: up to 9 rounds,
// ~63k fixed steps, then the result lands in #debug and the title.
// (Headless virtual time barely issues rAF frames, so the rAF loop alone
// cannot finish a match in a --dump-dom run.)
if (params.get('simrun') === '1') {
  let n = 0;
  while (!match.matchWinner && n < 120000) { step(STEP); n++; }
  refreshHud(1);
  document.title = 'SIMRUN ' + JSON.stringify(window.__game);
}
