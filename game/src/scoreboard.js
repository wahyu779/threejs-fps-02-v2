// scoreboard.js — scoreboard, roster, history, map callouts.
// Live fighter/match state into scoreboard data and HTML; callout names from map.js (21 zones).
import { CALLOUTS, calloutAt as mapCalloutAt } from './map.js';
export { CALLOUTS };
export function calloutAt(x, z) {
  const near = mapCalloutAt(x, z);
  if (near) return near;
  let best = CALLOUTS[0], bestD = Infinity;
  for (const c of CALLOUTS) { const d = (c[1] - x) ** 2 + (c[2] - z) ** 2; if (d < bestD) { bestD = d; best = c; } }
  return best[0];
}

// One row per fighter, Senja first, kills descending per team.
// dmg is f.dmg (tracked by the damage hook in main.js; without it every
// row reports 0 and the table shows '–', never a fake number).
export function buildScoreRows(fighters) {
  const rows = (fighters || []).map((f) => ({
    name: f.name || '?', team: f.team,
    kills: f.kills || 0, deaths: f.deaths || 0, dmg: f.dmg || 0,
    money: f.wallet ? (f.wallet.money || 0) : 0,
    alive: !!f.alive, isPlayer: !!f.isPlayer,
    gun: f.gun ? (f.gun.weaponId || '') : '',
  }));
  const rank = (r) => (r.team === 'senja' ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b) || b.kills - a.kills
    || b.dmg - a.dmg || a.deaths - b.deaths);
  return rows;
}

// MVP: most kills, then most damage, then fewest deaths. Null while
// nobody has a kill.
export function matchMvp(rows) {
  let best = null;
  for (const r of rows || []) {
    if (!best || r.kills > best.kills
      || (r.kills === best.kills && r.dmg > best.dmg)
      || (r.kills === best.kills && r.dmg === best.dmg && r.deaths < best.deaths)) best = r;
  }
  return best && best.kills > 0 ? best : null;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function teamTable(rows, team, mvp, attackers) {
  const list = rows.filter((r) => r.team === team);
  const title = (team === 'senja' ? 'SENJA' : 'BAYANG') + ' — ' + (team === attackers ? 'ATTACK' : 'DEFEND');
  let h = '<div class="sb-team">' + title + '</div><table><tr><th>Player</th>'
    + '<th>K</th><th>D</th><th>DMG</th><th>$</th><th></th></tr>';
  for (const r of list) {
    const star = mvp === r ? ' ★ MVP' : '';
    const alive = r.alive ? '●' : '○';
    h += '<tr class="' + (r.isPlayer ? 'sb-you' : '') + '"><td>' + alive + ' '
      + esc(r.name) + '</td><td>' + r.kills + '</td><td>' + r.deaths + '</td><td>'
      + (r.dmg > 0 ? r.dmg : '–') + '</td><td>$' + r.money + '</td><td class="sb-mvp">'
      + star + '</td></tr>';
  }
  return h + '</table>';
}

// Scoreboard HTML: header, both team tables, round history (match.
// roundLog from rounds.js — real results only). The star is the live
// match MVP; per-round MVPs are appended by rounds.js endRound.
export function scoreboardHtml(fighters, match) {
  const rows = buildScoreRows(fighters);
  const mvp = matchMvp(rows);
  const m = match || {};
  const atk = m.attackers || 'senja';
  let h = '<div class="sb-title">SCOREBOARD — PELABUHAN SENJA</div>'
    + '<div class="sb-score">SENJA ' + (m.scoreSenja || 0) + ' : '
    + (m.scoreBayang || 0) + ' BAYANG &nbsp;·&nbsp; ROUND ' + (m.round || 1)
    + ' / 12 &nbsp;·&nbsp; FIRST TO 7</div>'
    + teamTable(rows, 'senja', mvp, atk) + teamTable(rows, 'bayang', mvp, atk);
  const log = (m.roundLog || []).slice(0, 6);
  h += '<div class="sb-hist">ROUND HISTORY</div>';
  h += log.length ? log.map((l) => '<div>' + esc(l) + '</div>').join('')
    : '<div>No rounds finished.</div>';
  return h;
}

// Write into el, skipping when unchanged (called every 0.25 s).
export function renderScoreboard(el, fighters, match) {
  if (!el) return false;
  const html = scoreboardHtml(fighters, match);
  if (el._sbHtml === html) return false;
  el._sbHtml = html;
  el.innerHTML = html;
  return true;
}
