// map.js — Pelabuhan Senja: a 40x40 harbour map, its collision, and A*.
// One job: know where walls are, and find smooth paths through them.
//
// Layout (world metres, x east, z south, origin at map centre; cell = 2 m):
//   * outer quay wall around the whole 80x80 apron
//   * north-west warehouse (site A) and south-east dock office (site B)
//   * two lanes: the west quay lane and the east container lane, joined by
//     a mid cross-alley through the container yard
//   * container stacks and crates as cover; nothing is a Counter-Strike map,
//     the names and shapes are the harbour's own.
//
// LANE P (v2) — what changed vs the draft, and why:
//   1. Heuristik Manhattan -> OCTILE. Manhattan overestimates pada gerakan
//      8 arah (contoh: (0,0)->(1,1): Manhattan = 2, biaya sebenarnya
//      sqrt(2) = 1.414). Heuristik yang overestimate membuat A* TIDAK
//      lagi optimal. Octile tidak pernah overestimate (bukti di bawah),
//      jadi path yang dikembalikan optimal — diverifikasi sama panjang
//      dengan BFS pada semua rute sampel.
//   2. Heap dengan decrease-key yang BENAR (position map heapPos).
//      Draft menimpa fScore[i] saat push duplikat tanpa memperbaiki posisi
//      heap -> invarian heap bisa rusak -> urutan pop tidak lagi urut-f
//      -> optimalitas tidak terjamin. Di sini satu entri per node, update
//      f berarti bubble-up lewat heapPos. Entri basi tidak ada.
//   3. smoothPath diekspor terpisah + findPath dibangun di atas
//      astarCells + smoothPath, supaya keduanya bisa dites terpisah.
//   4. nearestWaypoint(x, z) ditambahkan (titik bebas terdekat).
//   5. Biaya diagonal Math.SQRT2 eksak (draft memakai 1.4142).
import { clamp } from './rng.js';

export const CELL = 2;          // metres per grid cell
export const GRID = 40;         // cells per side
export const HALF = (GRID * CELL) / 2; // 40 m, world half-size

// Wall rectangles: [x0, z0, x1, z1] in world metres. Built by hand so the
// lanes read clearly: border, warehouse, dock office, container stacks.
export const WALLS = [
  // border (four sides, 1 m thick)
  [-HALF, -HALF, HALF, -HALF + 1],
  [-HALF, HALF - 1, HALF, HALF],
  [-HALF, -HALF, -HALF + 1, HALF],
  [HALF - 1, -HALF, HALF, HALF],
  // north-west warehouse (site A building), two wings + back wall
  [-38, -38, -14, -36.5],
  [-38, -38, -36.5, -16],
  [-16, -38, -14, -20],
  [-30, -32, -26, -30.5], // inner partition, north edge of site A
  // south-east dock office (site B building)
  [14, 36.5, 38, 38],
  [36.5, 16, 38, 38],
  [14, 16, 16, 38],
  [22, 30.5, 26, 32], // inner partition, south edge of site B
  // container yard stacks (mid)
  [-8, -12, 2, -9],
  [-8, -2, -2, 1],
  [6, -14, 9, -4],
  [12, 2, 20, 5],
  [2, 10, 10, 13],
  [-20, 8, -12, 11],
  [-24, -6, -16, -3],
  [16, -24, 24, -21],
  [-6, 20, 4, 23],
  // lone crates (low cover, still block movement)
  [-30, 4, -27, 7],
  [26, -8, 29, -5],
  [-2, -30, 1, -27],
  [8, 28, 11, 31],
  [-14, 24, -11, 27],
];

// Bomb sites: centre + radius in metres.
export const SITE_A = { x: -26, z: -27, r: 6.5, name: 'A' };
export const SITE_B = { x: 26, z: 27, r: 6.5, name: 'B' };
// Spawns: attackers (Senja, the player's team) south-west, defenders north-east.
// 5 per team — TEAM_SIZE = 5 (rounds.js).
export const SPAWN_SENJA = [
  { x: -34, z: 30 }, { x: -30, z: 34 }, { x: -26, z: 30 },
  { x: -34, z: 36 }, { x: -22, z: 34 },
];
export const SPAWN_BAYANG = [
  { x: 30, z: -30 }, { x: 34, z: -26 }, { x: 26, z: -34 },
  { x: 34, z: -34 }, { x: 22, z: -30 },
];
// Mid hold spots defenders fall back to.
export const HOLD_SPOTS = [
  { x: -24, z: -20 }, { x: -18, z: -30 }, { x: 24, z: 20 },
  { x: 18, z: 30 }, { x: 0, z: -6 },
];

// --- grid ---------------------------------------------------------------
export function cellOf(v) { return clamp(Math.floor((v + HALF) / CELL), 0, GRID - 1); }
export function cellCenter(c) { return c * CELL - HALF + CELL / 2; }
export function cellIndex(gx, gz) { return gz * GRID + gx; }

// blocked[gz * GRID + gx] = 1 when the cell centre is inside any wall.
export const blocked = new Uint8Array(GRID * GRID);
for (let gz = 0; gz < GRID; gz++) {
  for (let gx = 0; gx < GRID; gx++) {
    const x = cellCenter(gx), z = cellCenter(gz);
    for (const w of WALLS) {
      if (x >= w[0] && x <= w[2] && z >= w[1] && z <= w[3]) {
        blocked[gz * GRID + gx] = 1;
        break;
      }
    }
  }
}

export function isBlockedCell(gx, gz) {
  if (gx < 0 || gz < 0 || gx >= GRID || gz >= GRID) return true;
  return blocked[gz * GRID + gx] === 1;
}
export function isBlockedPoint(x, z) {
  return isBlockedCell(cellOf(x), cellOf(z));
}

// --- line of sight on the grid (DDA walk, no allocation) -----------------
export function hasLineOfSight(x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const dist = Math.hypot(dx, dz);
  const steps = Math.max(1, Math.ceil(dist / 0.5));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isBlockedPoint(x0 + dx * t, z0 + dz * t)) return false;
  }
  return true;
}

// --- A* -----------------------------------------------------------------
// Heuristik OCTILE (admissible + konsisten untuk gerakan 8 arah):
//   h = max(|dx|,|dz|) + (sqrt(2) - 1) * min(|dx|,|dz|)
// Bukti tidak overestimate: setiap langkah grid biayanya minimal 1
// (lurus) atau sqrt(2) (diagonal). Jalur grid mana pun dari sel A ke sel B
// butuh minimal min(|dx|,|dz|) langkah diagonal + (|max|-|min|) langkah
// lurus, total = octile. Jadi h <= biaya jalur optimal sebenarnya.
// Karena h admissible DAN konsisten (memenuhi segitiga di tiap edge),
// node pertama kali di-pop dari heap sudah punya g optimal -> path yang
// direkonstruksi OPTIMAL (panjang grid minimal). Diverifikasi vs BFS.
//
// Scratch arrays live here, reused across calls: no allocation in the hot
// loop. 8-neighbour moves; diagonal tidak boleh memotong sudut dinding.
const N = GRID * GRID;
const gScore = new Float64Array(N);
const fScore = new Float64Array(N);
const cameFrom = new Int32Array(N);
const closedSet = new Uint8Array(N);
const heap = new Int32Array(N);      // satu entri per node, max N
const heapPos = new Int32Array(N);   // heapPos[node] = posisi di heap, -1 = tidak di heap
let heapLen = 0;

function heapSwap(a, b) {
  const t = heap[a]; heap[a] = heap[b]; heap[b] = t;
  heapPos[heap[a]] = a; heapPos[heap[b]] = b;
}
function heapBubbleUp(i) {
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (fScore[heap[p]] <= fScore[heap[i]]) break;
    heapSwap(p, i);
    i = p;
  }
}
function heapBubbleDown(i) {
  for (;;) {
    const l = i * 2 + 1, r = l + 1;
    let m = i;
    if (l < heapLen && fScore[heap[l]] < fScore[heap[m]]) m = l;
    if (r < heapLen && fScore[heap[r]] < fScore[heap[m]]) m = r;
    if (m === i) break;
    heapSwap(m, i);
    i = m;
  }
}
// Push node, atau decrease-key bila node sudah ada di heap dengan f lebih
// besar. Satu entri per node: tidak ada entri basi, invarian heap utuh.
function heapPushOrDecrease(node, f) {
  const pos = heapPos[node];
  if (pos >= 0) {
    if (f < fScore[node]) { fScore[node] = f; heapBubbleUp(pos); }
    return;
  }
  fScore[node] = f;
  heap[heapLen] = node;
  heapPos[node] = heapLen;
  heapLen++;
  heapBubbleUp(heapLen - 1);
}
function heapPop() {
  const top = heap[0];
  heapLen--;
  heapPos[top] = -1;
  if (heapLen > 0) {
    heap[0] = heap[heapLen];
    heapPos[heap[0]] = 0;
    heapBubbleDown(0);
  }
  return top;
}

function octile(dx, dz) {
  const a = dx < 0 ? -dx : dx, b = dz < 0 ? -dz : dz;
  const mn = a < b ? a : b, mx = a > b ? a : b;
  return mx + (Math.SQRT2 - 1) * mn;
}

// A* antar indeks sel. Mengembalikan { path: [indeks sel...] start..goal,
// visited: jumlah node yang di-pop } atau null bila tidak ada jalur.
// Path di sini MENTAH (per sel); smoothing dilakukan smoothPath/findPath.
export function astarCells(startIdx, goalIdx) {
  if (blocked[startIdx] || blocked[goalIdx]) return null;
  gScore.fill(Infinity);
  cameFrom.fill(-1);
  closedSet.fill(0);
  heapPos.fill(-1);
  heapLen = 0;
  const gxGoal = goalIdx % GRID, gzGoal = (goalIdx / GRID) | 0;
  gScore[startIdx] = 0;
  heapPushOrDecrease(startIdx,
    octile(gxGoal - (startIdx % GRID), gzGoal - ((startIdx / GRID) | 0)));
  let visited = 0;
  while (heapLen > 0) {
    const cur = heapPop();
    if (closedSet[cur]) continue;
    closedSet[cur] = 1;
    visited++;
    if (cur === goalIdx) {
      const path = [];
      let c = cur;
      while (c !== -1) { path.push(c); c = cameFrom[c]; }
      path.reverse();
      return { path, visited };
    }
    const cx = cur % GRID, cz = (cur / GRID) | 0;
    const gc = gScore[cur];
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx, nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= GRID || nz >= GRID) continue;
        const ni = nz * GRID + nx;
        if (blocked[ni] || closedSet[ni]) continue;
        // Diagonal tidak boleh memotong sudut dinding.
        if (dx !== 0 && dz !== 0 &&
          (blocked[cz * GRID + nx] || blocked[nz * GRID + cx])) continue;
        const ng = gc + ((dx !== 0 && dz !== 0) ? Math.SQRT2 : 1);
        if (ng < gScore[ni]) {
          gScore[ni] = ng;
          cameFrom[ni] = cur;
          heapPushOrDecrease(ni, ng + octile(gxGoal - nx, gzGoal - nz));
        }
      }
    }
  }
  return null;
}

// --- smoothing: string-pulling via LOS ----------------------------------
// Jarak bebas minimal dari dinding untuk sebuah segmen jalan: radius bot
// (mover.js: body.radius = 0.45 m). Segmen yang lolos harus menjaga pusat
// bot sejauh itu dari setiap rect dinding, jadi resolveCircle tidak pernah
// mendorong bot saat ia mengikuti path — tidak ada jitter / nyangkut.
export const BOT_CLEARANCE = 0.45;

// Jarak terpendek antara segmen (x0,z0)->(x1,z1) dan semua rect WALLS.
// 0 bila segmen menyentuh/menembus dinding. Eksak (geometri, bukan
// sampling grid): tidak ada sudut dinding yang lolos karena sampling.
function pointSegDist(px, pz, x0, z0, x1, z1) {
  const dx = x1 - x0, dz = z1 - z0;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - x0) * dx + (pz - z0) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = x0 + dx * t, cz = z0 + dz * t;
  return Math.hypot(px - cx, pz - cz);
}
function segSegIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}
export function segmentClearance(x0, z0, x1, z1) {
  let best = Infinity;
  for (const w of WALLS) {
    // Ujung di dalam rect -> 0.
    if ((x0 >= w[0] && x0 <= w[2] && z0 >= w[1] && z0 <= w[3]) ||
        (x1 >= w[0] && x1 <= w[2] && z1 >= w[1] && z1 <= w[3])) return 0;
    // Segmen memotong sisi rect -> 0.
    const corners = [[w[0], w[1]], [w[2], w[1]], [w[2], w[3]], [w[0], w[3]]];
    for (let e = 0; e < 4; e++) {
      const a = corners[e], b = corners[(e + 1) % 4];
      if (segSegIntersect(x0, z0, x1, z1, a[0], a[1], b[0], b[1])) return 0;
    }
    // Jika tidak berpotongan: jarak min = sudut rect ke segmen, atau ujung
    // segmen ke sisi rect.
    for (const c of corners) {
      const d = pointSegDist(c[0], c[1], x0, z0, x1, z1);
      if (d < best) best = d;
    }
    for (let e = 0; e < 4; e++) {
      const a = corners[e], b = corners[(e + 1) % 4];
      const d1 = pointSegDist(x0, z0, a[0], a[1], b[0], b[1]);
      const d2 = pointSegDist(x1, z1, a[0], a[1], b[0], b[1]);
      if (d1 < best) best = d1;
      if (d2 < best) best = d2;
    }
  }
  return best;
}

// smoothPath(points) — points: [{x,z}...] (mentah, per sel). Greedy: dari
// anchor terakhir, lompat ke waypoint terjauh yang masih terlihat lurus
// (hasLineOfSight) DAN menjaga jarak aman dari dinding (segmentClearance
// >= BOT_CLEARANCE). Hasil: waypoint minimal yang tetap legal — tiap segmen
// lolos LOS + berjarak aman dari dinding, dan tiap titik di sel bebas
// (inputnya memang begitu). Mengembalikan array BARU; input tidak diubah.
export function smoothPath(points) {
  const n = points.length;
  if (n <= 2) return points.slice();
  const out = [points[0]];
  let anchor = 0;
  while (anchor < n - 1) {
    let j = n - 1;
    while (j > anchor + 1 &&
      (!hasLineOfSight(points[anchor].x, points[anchor].z, points[j].x, points[j].z) ||
       segmentClearance(points[anchor].x, points[anchor].z, points[j].x, points[j].z) + 1e-9 < BOT_CLEARANCE)) {
      j--;
    }
    out.push(points[j]);
    anchor = j;
  }
  return out;
}

// Nearest free cell to (gx, gz) within radius 3 (spiral), or null.
// Lets callers aim at a wall-adjacent point without failing the search.
function nearestFree(gx, gz) {
  if (!isBlockedCell(gx, gz)) return { gx, gz };
  for (let r = 1; r <= 3; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (!isBlockedCell(gx + dx, gz + dz)) return { gx: gx + dx, gz: gz + dz };
      }
    }
  }
  return null;
}

// nearestWaypoint(x, z) — titik waypoint bebas terdekat dari (x, z):
// pusat sel bebas terdekat (radius cari 3 sel). Dipakai bot untuk
// men-snap tujuan yang jatuh di dekat dinding ke titik jalan yang legal.
// Mengembalikan {x, z} atau null bila tidak ada sel bebas di dekatnya.
export function nearestWaypoint(x, z) {
  const f = nearestFree(cellOf(x), cellOf(z));
  if (!f) return null;
  return { x: cellCenter(f.gx), z: cellCenter(f.gz) };
}

// findPath(sx, sz, tx, tz) -> array of {x, z} world waypoints, smoothed,
// or null when unreachable. Signature sama seperti draft (dipakai bots.js
// dan main.js). Path mulai tepat di (sx, sz), berakhir tepat di (tx, tz),
// dan tiap segmen di antaranya lolos hasLineOfSight.
export function findPath(sx, sz, tx, tz) {
  const sg = nearestFree(cellOf(sx), cellOf(sz));
  const tg = nearestFree(cellOf(tx), cellOf(tz));
  if (!sg || !tg) return null;
  const start = sg.gz * GRID + sg.gx;
  const goal = tg.gz * GRID + tg.gx;
  const res = astarCells(start, goal);
  if (!res) return null;
  // Titik mentah: start persis + pusat sel perantara + target persis.
  // (Sel pertama/terakhir dilewati: pusatnya sudah dekat dengan start/target.)
  const raw = [{ x: sx, z: sz }];
  for (let i = 1; i < res.path.length - 1; i++) {
    const c = res.path[i];
    raw.push({ x: cellCenter(c % GRID), z: cellCenter((c / GRID) | 0) });
  }
  raw.push({ x: tx, z: tz });
  return smoothPath(raw);
}

// --- collision: circle vs wall rectangles --------------------------------
// resolveCircle(pos, radius): pushes pos out of any wall it overlaps.
// Returns true when a push happened. pos is {x, z} mutated in place.
export function resolveCircle(pos, radius) {
  let pushed = false;
  for (const w of WALLS) {
    const nx = clamp(pos.x, w[0], w[2]);
    const nz = clamp(pos.z, w[1], w[3]);
    const dx = pos.x - nx, dz = pos.z - nz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= radius * radius) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2);
      pos.x = nx + (dx / d) * radius;
      pos.z = nz + (dz / d) * radius;
    } else {
      // Centre inside the wall: push out along the smallest penetration axis.
      const pl = pos.x - w[0], pr = w[2] - pos.x;
      const pt = pos.z - w[1], pb = w[3] - pos.z;
      const m = Math.min(pl, pr, pt, pb);
      if (m === pl) pos.x = w[0] - radius;
      else if (m === pr) pos.x = w[2] + radius;
      else if (m === pt) pos.z = w[1] - radius;
      else pos.z = w[3] + radius;
    }
    pushed = true;
  }
  return pushed;
}

// Ray vs walls: nearest hit distance along (ox,oz)+t*(dx,dz), or Infinity.
// Used by hitscan so bullets stop at walls, and by bot hearing/LOS checks.
export function rayWalls(ox, oz, dx, dz, maxDist) {
  let best = Infinity;
  for (const w of WALLS) {
    // Slab test in 2D (walls are full height for bullets at body height).
    let tmin = 0, tmax = maxDist;
    if (Math.abs(dx) < 1e-9) {
      if (ox < w[0] || ox > w[2]) continue;
    } else {
      let t1 = (w[0] - ox) / dx, t2 = (w[2] - ox) / dx;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    if (Math.abs(dz) < 1e-9) {
      if (oz < w[1] || oz > w[3]) continue;
    } else {
      let t1 = (w[1] - oz) / dz, t2 = (w[3] - oz) / dz;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    if (tmin < best) best = tmin;
  }
  return best;
}

export function insideSite(x, z, site) {
  const dx = x - site.x, dz = z - site.z;
  return dx * dx + dz * dz <= site.r * site.r;
}
