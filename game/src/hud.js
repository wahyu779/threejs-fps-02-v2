// hud.js — HUD: bars, timer, score, buy menu, and the minimap.
// The minimap is a live 168x168 top-down view that is honest by rule:
// drawMinimap() reads ONLY state.minimap, never the fighter list. The
// snapshot (built by main.js via buildMinimapSnapshot) holds ONLY enemies
// actually spotted — seen by the player or a teammate, or heard shooting
// in the last 2 s — so an unspotted enemy cannot appear. Entries older
// than 2 s are dropped again inside drawMinimap (defence in depth).
// Buy menu: buildBuyList() reads economy.getShopItems() — menu prices are
// catalogue prices, never hardcoded; existing buttons update in place.
import { WALLS, SITE_A, SITE_B, SITE_C, HALF } from './map.js';
import { WEAPONS } from './weapons.js';
import { renderScoreboard, buildScoreRows, calloutAt } from './scoreboard.js';

let els = null;
let mm = null; // minimap canvas context
let lastHpFlash = 0;
// Last hero pose, radio memory, ?hud= demo flags.
let lastHero = null;
let prevRadio = null;
let demoDmgDone = false;
let demoFlags = '';
let dmgTimer = 0;

// --- minimap geometry ---
// World x,z in [-40, +40] m; canvas size x size px, margin 3 px.
const MM_MARGIN = 3;
const MM_SIZE = 168;
const SPOT_TTL = 2; // seconds: a spotted enemy fades off the map after this

export function toMap(x, z, size) {
  const s = (size - 2 * MM_MARGIN) / (HALF * 2);
  return [(x + HALF) * s + MM_MARGIN, (z + HALF) * s + MM_MARGIN];
}

// Build the minimap snapshot main.js passes to updateHud() every tick.
// {hero, fighters, spotted, bomb, now}: only spotted enemies leak out
// (seen by player/teammate, or heard shooting in the last 2 s).
export function buildMinimapSnapshot({ hero, fighters, spotted, bomb, now }) {
  const player = {
    x: hero.body.pos.x,
    z: hero.body.pos.z,
    angle: hero.body.yaw,
  };
  const allies = [];
  const enemies = [];
  for (const f of fighters || []) {
    if (!f.alive || f.isPlayer) continue;
    if (f.team === 'senja') {
      allies.push({ x: f.body.pos.x, z: f.body.pos.z });
    } else if (spotted && spotted.has(f)) {
      // Last-seen stamp for the staleness drop.
      let t = now;
      if (typeof f.lastFiredAt === 'number' && now - f.lastFiredAt < 2) t = f.lastFiredAt;
      enemies.push({ x: f.body.pos.x, z: f.body.pos.z, t });
    }
  }
  return {
    player,
    allies,
    enemies,
    bomb: bomb && (bomb.state === 'planted' || bomb.state === 'dropped')
      ? { x: bomb.x, z: bomb.z, planted: bomb.state === 'planted' }
      : null,
    sites: [
      { x: SITE_A.x, z: SITE_A.z, label: 'A' },
      { x: SITE_B.x, z: SITE_B.z, label: 'B' },
      { x: SITE_C.x, z: SITE_C.z, label: 'C' },
    ],
    callout: calloutAt(hero.body.pos.x, hero.body.pos.z),
  };
}

export function initHud() {
  els = {
    hp: document.getElementById('hp-fill'),
    hpText: document.getElementById('hp-text'),
    armor: document.getElementById('armor-fill'),
    armorText: document.getElementById('armor-text'),
    ammo: document.getElementById('ammo'),
    money: document.getElementById('money'),
    timer: document.getElementById('timer'),
    score: document.getElementById('score'),
    round: document.getElementById('round-label'),
    cross: document.getElementById('crosshair'),
    hit: document.getElementById('hitmarker'),
    banner: document.getElementById('banner'),
    bannerSub: document.getElementById('banner-sub'),
    buy: document.getElementById('buy-menu'),
    buyMoney: document.getElementById('buy-money'),
    feed: document.getElementById('feed'),
    end: document.getElementById('end-screen'),
    endTitle: document.getElementById('end-title'),
    endScore: document.getElementById('end-score'),
    debug: document.getElementById('debug'),
    selftest: document.getElementById('selftest'),
  };
  const c = document.getElementById('minimap');
  if (c) mm = c.getContext('2d');
  const css = document.createElement('style');
  css.textContent = '#scoreboard{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:520px;max-width:92vw;background:rgba(8,12,20,.94);border:1px solid #8a7a5a;padding:16px 20px;z-index:25;display:none;pointer-events:none;font-size:14px}'
    + '#scoreboard table{width:100%;border-collapse:collapse}#scoreboard th,#scoreboard td{padding:2px 6px;text-align:left}#scoreboard th:nth-child(n+2),#scoreboard td:nth-child(n+2){text-align:right}'
    + '.sb-title{font-size:18px;font-weight:900;letter-spacing:2px;text-align:center}.sb-score{text-align:center;color:#ffd54f;font-weight:700;margin:6px 0 10px}.sb-team{font-weight:700;letter-spacing:1px;margin-top:8px;border-bottom:1px solid rgba(255,255,255,.25)}.sb-you td{color:#ffd54f}.sb-mvp{color:#ffd54f;font-weight:700}.sb-hist{margin-top:10px;font-weight:700;letter-spacing:1px;font-size:12px;color:#a5d6a7}'
    + '#roster{position:fixed;top:190px;right:14px;width:168px;z-index:5;font-size:11px;line-height:1.5;text-shadow:0 1px 4px #000;pointer-events:none;white-space:pre-line}'
    + '#radio{position:fixed;left:14px;top:230px;z-index:5;font-size:12px;line-height:1.6;text-shadow:0 1px 4px #000;pointer-events:none;max-width:340px;color:#b3e5fc}'
    + '#dmgdir{position:fixed;left:50%;top:50%;width:150px;height:150px;margin:-75px 0 0 -75px;z-index:6;pointer-events:none;opacity:0;transition:opacity .2s}'
    + '#dmgdir .dmg-arrow{position:absolute;left:50%;top:-6px;transform:translateX(-50%);color:#ff5252;font-size:24px;text-shadow:0 0 6px #000}'
    + '.hs-badge{background:#ffd54f;color:#000;font-size:10px;padding:0 3px;border-radius:2px;margin-left:4px}.wpn-tag{color:#a5d6a7;font-size:11px;margin-left:4px}'
    + '.buy-cat{font-size:11px;letter-spacing:2px;color:#a5d6a7;margin:10px 0 2px;font-weight:700}'
    + '#crosshair.scoped{width:110px;height:110px;border:2px solid rgba(255,255,255,.85);border-radius:50%}#crosshair.scoped::before,#crosshair.scoped::after{display:none}';
  document.head.appendChild(css);
  const mk = (id) => {
    let e = document.getElementById(id);
    if (!e) { e = document.createElement('div'); e.id = id; document.body.appendChild(e); }
    return e;
  };
  els.scoreboard = mk('scoreboard');
  els.roster = mk('roster');
  els.radio = mk('radio');
  els.dmgdir = mk('dmgdir');
  els.dmgdir.innerHTML = '<div class="dmg-arrow">▲</div>';
  demoFlags = new URLSearchParams(location.search).get('hud') || '';
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'Tab') { ev.preventDefault(); showScoreboard(true); }
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code === 'Tab' && !els.scoreboard.dataset.pinned) showScoreboard(false);
  });
  if (demoFlags.includes('scoreboard')) {
    els.scoreboard.dataset.pinned = '1';
    showScoreboard(true);
  }
  window.__hud = { showDamageDir, showScoreboard, radioSay, feedLine, calloutAt, buildScoreRows };
  return els;
}

export function showScoreboard(v) {
  if (!els || !els.scoreboard) return;
  els.scoreboard.style.display = v ? 'block' : 'none';
}

// Damage direction: red arrow around the crosshair pointing at the
// shooter. main.js damageFighter calls this with the attacker's position;
// bearing is vs the hero's last pose. ?hud=dmg demos it in staging.
export function showDamageDir(fromX, fromZ) {
  if (!els || !els.dmgdir || !lastHero) return;
  const dx = fromX - lastHero.x, dz = fromZ - lastHero.z;
  if (Math.hypot(dx, dz) < 0.5) return;
  const yaw = lastHero.yaw;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const deg = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz) * 180 / Math.PI;
  els.dmgdir.style.transform = 'rotate(' + deg.toFixed(0) + 'deg)';
  els.dmgdir.style.opacity = '1';
  clearTimeout(dmgTimer);
  dmgTimer = setTimeout(() => { els.dmgdir.style.opacity = '0'; }, 900);
}

export function radioSay(text) {
  if (!els || !els.radio) return;
  const d = document.createElement('div');
  d.textContent = text;
  els.radio.prepend(d);
  while (els.radio.children.length > 3) els.radio.removeChild(els.radio.lastChild);
}

function updateRoster(fighters) {
  if (!els || !els.roster) return;
  const rows = buildScoreRows(fighters || []);
  let t = '';
  for (const team of ['senja', 'bayang']) {
    t += (team === 'senja' ? 'SENJA\n' : 'BAYANG\n');
    for (const r of rows.filter((x) => x.team === team)) {
      t += (r.alive ? '● ' : '○ ') + r.name + '  ' + r.kills + '/' + r.deaths + '\n';
    }
  }
  if (els.roster._t !== t) { els.roster._t = t; els.roster.textContent = t; }
}

// Radio lines from REAL state transitions only (round start, bomb
// planted/defused, round result, bot contact). Nothing invented.
function radioDetect(state) {
  const m = state.match;
  if (!m) return;
  const p = prevRadio;
  const bomb = state.bomb || {};
  if (!p) {
    prevRadio = { round: m.round, bomb: bomb.state || '', winner: m.winner };
    if (m.round === 1) radioSay('Rani: Round 1 — Senja attacks. Take A, B or C Dock.');
    return;
  }
  if (m.round !== p.round) {
    radioSay('Rani: Round ' + m.round + ' — score ' + m.scoreSenja + ':' + m.scoreBayang + '. Go again.');
    p.round = m.round;
  }
  if (bomb.state === 'planted' && p.bomb !== 'planted') {
    radioSay('Charge planted — Site ' + bomb.site + ' (' + calloutAt(bomb.x, bomb.z) + '). Hold it.');
  } else if (bomb.state === 'defused' && p.bomb === 'planted') {
    radioSay('Charge defused — site clear. Reset.');
  }
  p.bomb = bomb.state || '';
  if (m.phase === 'over' && m.winner && m.winner !== p.winner) {
    const why = m.winReason === 'explosion' ? 'bomb detonated' : m.winReason === 'defuse' ? 'bomb defused'
      : m.winReason === 'time' ? 'time expired' : 'enemy team eliminated';
    radioSay('Round to ' + (m.winner === 'senja' ? 'Senja' : 'Bayang') + ' — ' + why + '.');
  }
  p.winner = m.winner;
}

export function showHitmarker(head, kill) {
  if (!els) return;
  els.hit.style.opacity = '1';
  els.hit.style.color = kill ? '#ff5252' : head ? '#ffd54f' : '#ffffff';
  els.hit.style.transform = 'translate(-50%,-50%) scale(1.25)';
  setTimeout(() => {
    els.hit.style.opacity = '0';
    els.hit.style.transform = 'translate(-50%,-50%) scale(1)';
  }, 130);
}

export function showBanner(text, sub) {
  if (!els) return;
  els.banner.textContent = text;
  els.bannerSub.textContent = sub || '';
  els.banner.parentElement.style.opacity = '1';
  setTimeout(() => { els.banner.parentElement.style.opacity = '0'; }, 2600);
}

export function feedLine(text) {
  if (!els) return;
  const d = document.createElement('div');
  // Headshot marker: main.js marks headshot kills with ' (kepala)';
  // render it as an HS badge and drop the marker text.
  const hs = text.includes('(kepala)');
  let main = hs ? text.replace(' (kepala)', '') : text;
  // Weapon tag: the damage hook appends ' · <Weapon>' to the kill line.
  const wi = main.lastIndexOf(' · ');
  let wpn = null;
  if (wi > 0) { wpn = main.slice(wi + 3); main = main.slice(0, wi); }
  d.textContent = main;
  if (hs) {
    const b = document.createElement('b');
    b.className = 'hs-badge'; b.textContent = 'HS';
    d.appendChild(b);
  }
  if (wpn) {
    const w = document.createElement('span');
    w.className = 'wpn-tag'; w.textContent = wpn;
    d.appendChild(w);
  }
  els.feed.prepend(d);
  while (els.feed.children.length > 5) els.feed.removeChild(els.feed.lastChild);
}

export function setBuyVisible(v) {
  if (els) els.buy.style.display = v ? 'block' : 'none';
}

export function buyFlash(ok) {
  if (!els || !els.buyMoney) return;
  els.buyMoney.style.color = ok ? '#69f0ae' : '#ff5252';
  setTimeout(() => { els.buyMoney.style.color = ''; }, 350);
}

// --- buy menu from the economy catalogue ---
// buildBuyList(getShopItems, money?): each item {id, label, note, price} —
// price from the catalogue, never hardcoded here. money greys out what the
// player cannot afford. Existing #buy-menu buttons update IN PLACE (their
// data-buy, and main.js's click handler, keep working); a catalogue item
// with no button gets one appended (main.js binds by event delegation, so
// the starting pistol renders OWNED, never as a misleading "$0" button.
export function buildBuyList(getShopItems, money) {
  const items = typeof getShopItems === 'function' ? getShopItems() : getShopItems;
  if (!items || !Array.isArray(items)) return 0;
  const menu = (els && els.buy) || (typeof document !== 'undefined' ? document.getElementById('buy-menu') : null);
  if (!menu) return 0;
  const byId = new Map(items.map((it) => [it.id, it]));
  menu.querySelectorAll('.buy-cat').forEach((h) => h.remove());
  const CAT = { rifle: 'PRIMARY WEAPONS', marksman: 'PRIMARY WEAPONS', shotgun: 'PRIMARY WEAPONS', armor: 'GEAR', grenade: 'GRENADES', pistol: 'SIDEARM — OWNED' };
  const seenCat = new Set();
  const headerFor = (id, before) => {
    const c = CAT[id];
    if (!c || seenCat.has(c)) return;
    seenCat.add(c);
    const h = document.createElement('div');
    h.className = 'buy-cat'; h.textContent = c;
    menu.insertBefore(h, before);
  };
  const fill = (btn, it) => {
    btn.innerHTML = '';
    btn.appendChild(document.createTextNode((it.label || it.name) + ' — ' + (it.note || it.desc || '')));
    const tag = document.createElement('b');
    if (it.id === 'pistol') {
      tag.textContent = 'Owned';
      btn.disabled = true;
      btn.style.opacity = '0.55';
    } else {
      tag.textContent = '$' + it.price;
      if (typeof money === 'number') {
        btn.disabled = money < it.price;
        btn.style.opacity = money < it.price ? '0.45' : '';
      }
    }
    btn.appendChild(tag);
  };
  let shown = 0;
  menu.querySelectorAll('button[data-buy]').forEach((btn) => {
    const it = byId.get(btn.dataset.buy);
    if (!it) return; // catalogue no longer sells this: leave the button alone
    headerFor(it.id, btn);
    fill(btn, it);
    shown++;
  });
  for (const it of items) {
    if (menu.querySelector('button[data-buy="' + it.id + '"]')) continue;
    const btn = document.createElement('button');
    btn.dataset.buy = it.id;
    btn.dataset.hudDynamic = '1';
    headerFor(it.id, null);
    fill(btn, it);
    menu.appendChild(btn);
    shown++;
  }
  return shown;
}

export function setEndScreen(title, score) {
  if (!els) return;
  els.endTitle.textContent = title;
  els.endScore.textContent = score;
  els.end.style.display = 'flex';
}

export function setDebug(text) {
  if (els && els.debug) els.debug.textContent = text;
}

export function updateHud(state) {
  if (!els) return;
  const p = state.player;
  const w = state.wallet;
  els.hp.style.width = Math.max(0, Math.min(100, p.hp)) + '%';
  els.hpText.textContent = Math.max(0, Math.ceil(p.hp)) + ' HP';
  // Armor: bar width = armor/100; the number is ALWAYS shown (0 KV when
  // the vest is gone — the player must know they are unarmored).
  const armor = Math.max(0, Math.min(100, w.armor || 0));
  els.armor.style.width = armor + '%';
  els.armorText.textContent = Math.round(armor) + ' KV' + (w.helmet ? ' +HELM' : '');
  els.ammo.textContent = p.gun.ammo + ' / ' + p.gun.reserve;
  els.money.textContent = '$' + w.money;
  const t = Math.max(0, Math.ceil(state.match.phaseT));
  els.timer.textContent = Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  els.score.textContent = state.match.scoreSenja + ' : ' + state.match.scoreBayang;
  els.round.textContent = 'ROUND ' + state.match.round + ' / 12';
  // Crosshair grows with the live spread: stopping to aim visibly pays.
// ADS tightens it (gap / zoom); a scoped weapon draws the scope ring.
  const sp = p.gun._spread || 0.01;
  const zf = p.zoomF || 1;
  const gap = (6 + sp * 900) / zf;
  els.cross.style.setProperty('--gap', gap.toFixed(1) + 'px');
  const scoped = !!(p.gun && p.gun.weaponId && (WEAPONS[p.gun.weaponId] || {}).scoped);
  els.cross.classList.toggle('scoped', scoped && zf > 1.5);
  lastHero = { x: p.body.pos.x, z: p.body.pos.z, yaw: p.body.yaw };
  renderScoreboard(els.scoreboard, state.fighters, state.match);
  updateRoster(state.fighters);
  radioDetect(state);
  if (demoFlags.includes('dmg') && !demoDmgDone && lastHero) {
    demoDmgDone = true;
    const rx = Math.cos(lastHero.yaw), rz = -Math.sin(lastHero.yaw);
    showDamageDir(lastHero.x + rx * 10, lastHero.z + rz * 10);
  }
  drawMinimap(state);
}

export function drawMinimap(state) {
  if (!mm) return;
  const S = MM_SIZE;
  const c = mm.canvas;
  if (c.width !== S) { c.width = S; c.height = S; }
  const minimap = state.minimap || null;
  const now = typeof state.now === 'number' ? state.now : null;

  mm.fillStyle = 'rgba(12, 16, 26, 0.82)';
  mm.fillRect(0, 0, S, S);
  mm.fillStyle = 'rgba(29, 47, 69, 0.9)';
  mm.fillRect(S * 0.72, S * 0.72, S * 0.28, S * 0.28);
  mm.strokeStyle = 'rgba(255,255,255,0.05)';
  mm.lineWidth = 1;
  mm.beginPath();
  for (let g = -30; g <= 30; g += 10) {
    const [gx] = toMap(g, 0, S);
    mm.moveTo(gx, MM_MARGIN);
    mm.lineTo(gx, S - MM_MARGIN);
    const [, gy] = toMap(0, g, S);
    mm.moveTo(MM_MARGIN, gy);
    mm.lineTo(S - MM_MARGIN, gy);
  }
  mm.stroke();
  mm.fillStyle = '#8a7a5a';
  for (const w of WALLS) {
    const [x0, y0] = toMap(w[0], w[1], S);
    const [x1, y1] = toMap(w[2], w[3], S);
    mm.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  }
  const sites = (minimap && minimap.sites) || [
    { x: SITE_A.x, z: SITE_A.z, label: 'A' },
    { x: SITE_B.x, z: SITE_B.z, label: 'B' },
  ];
  const bombSite = minimap && minimap.bomb ? siteLabelNear(minimap.bomb, sites) : null;
  mm.font = 'bold 11px sans-serif';
  mm.textAlign = 'center';
  for (const site of sites) {
    const [x, y] = toMap(site.x, site.z, S);
    mm.fillStyle = bombSite === site.label ? '#ff9800' : 'rgba(63, 174, 90, 0.85)';
    mm.beginPath(); mm.arc(x, y, 7, 0, Math.PI * 2); mm.fill();
    mm.fillStyle = '#0c101a';
    mm.fillText(site.label, x, y + 4);
  }
  if (minimap && minimap.bomb) {
    const [x, y] = toMap(minimap.bomb.x, minimap.bomb.z, S);
    if (minimap.bomb.planted) {
      const blink = typeof performance !== 'undefined'
        ? 4 + Math.sin(performance.now() / 150) * 1.5 : 4;
      mm.fillStyle = '#ff1744';
      mm.beginPath(); mm.arc(x, y, blink, 0, Math.PI * 2); mm.fill();
      mm.strokeStyle = '#ff1744';
      mm.beginPath(); mm.arc(x, y, 9, 0, Math.PI * 2); mm.stroke();
    } else {
      mm.fillStyle = '#ffb300';
      mm.beginPath(); mm.arc(x, y, 4, 0, Math.PI * 2); mm.fill();
    }
  }
  if (!minimap) {
    finishMinimapFrame(S);
    return;
  }
  for (const a of minimap.allies || []) {
    const [x, y] = toMap(a.x, a.z, S);
    mm.fillStyle = '#4fc3f7';
    mm.beginPath(); mm.arc(x, y, 3.5, 0, Math.PI * 2); mm.fill();
  }
  // Stale entries (last seen/heard > 2 s ago) are dropped here as well.
  for (const e of minimap.enemies || []) {
    if (now !== null && typeof e.t === 'number' && now - e.t > SPOT_TTL) continue;
    const [x, y] = toMap(e.x, e.z, S);
    mm.fillStyle = '#ff5252';
    mm.beginPath(); mm.arc(x, y, 3.5, 0, Math.PI * 2); mm.fill();
  }
  const pl = minimap.player;
  if (pl) {
    const [x, y] = toMap(pl.x, pl.z, S);
    // Vision cone: thin wedge in the facing direction.
    const fx = -Math.sin(pl.angle), fz = -Math.cos(pl.angle);
    mm.fillStyle = 'rgba(255,255,255,0.07)';
    mm.beginPath();
    mm.moveTo(x, y);
    mm.arc(x, y, 26, Math.atan2(fz, fx) - 0.6, Math.atan2(fz, fx) + 0.6);
    mm.closePath(); mm.fill();
    mm.save();
    mm.translate(x, y);
    mm.rotate(-pl.angle);
    mm.fillStyle = '#ffffff';
    mm.beginPath(); mm.moveTo(0, -6); mm.lineTo(4, 5); mm.lineTo(-4, 5); mm.closePath(); mm.fill();
    mm.restore();
    // White ring so the player stays readable over walls.
    mm.strokeStyle = 'rgba(255,255,255,0.6)';
    mm.beginPath(); mm.arc(x, y, 6, 0, Math.PI * 2); mm.stroke();
  }
  finishMinimapFrame(S);
  if (minimap && minimap.callout) {
    mm.fillStyle = 'rgba(255,255,255,0.85)';
    mm.font = 'bold 10px sans-serif';
    mm.textAlign = 'left';
    mm.fillText(minimap.callout.toUpperCase(), 5, S - 6);
  }
}

function siteLabelNear(bomb, sites) {
  let best = null, bestD = Infinity;
  for (const s of sites) {
    const d = (s.x - bomb.x) * (s.x - bomb.x) + (s.z - bomb.z) * (s.z - bomb.z);
    if (d < bestD) { bestD = d; best = s.label; }
  }
  return best;
}

function finishMinimapFrame(S) {
  mm.strokeStyle = 'rgba(255,255,255,0.35)';
  mm.strokeRect(0.5, 0.5, S - 1, S - 1);
  mm.fillStyle = 'rgba(255,255,255,0.75)';
  mm.font = '10px sans-serif';
  mm.textAlign = 'left';
  mm.fillText('PELABUHAN SENJA', 5, 12);
  // North tick: up on the map is -z (north).
  mm.fillStyle = 'rgba(255,255,255,0.75)';
  mm.font = 'bold 10px sans-serif';
  mm.textAlign = 'right';
  mm.fillText('U', S - 5, 12);
}
