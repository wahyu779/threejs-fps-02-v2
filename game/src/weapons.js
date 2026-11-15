// weapons.js — Pelabuhan Senja v2 gunplay: hitscan asli, recoil, spread.
// Satu tugas: menentukan apa yang terjadi saat pelatuk ditarik. Bot maupun
// pemain memanggil fireHitscan() yang sama, jadi kill bot adalah ray yang
// benar-benar mengenai badan, bukan lemparan dadu.
//
// Model kena: tiap petarung tiga bola — kepala (r 0.22 di 1.52 m), torso
// (r 0.42 di 1.05 m), kaki (r 0.40 di 0.45 m). Satu tembakan adalah satu ray;
// bola terdekat sebelum dinding terdekat yang menang. Kepala = damage x2.
//
// LANE H (v2) — yang diperdalam di sini, dan kenapa:
//  1. RECOIL BOT YANG SEBELUMNYA NOL. Draft hanya menumpuk pitchKick/
//     yawKick di gun state; pemain merasakannya lewat kamera (player.js
//     mengintegrasikan pitchKick ke pitch), tapi bot menghitung ulang bidikan
//     tiap frame (bots.js aimAt) dan tidak pernah membaca pitchKick —
//     spray bot tidak pernah naik. Di sini fireHitscan MEMUTAR arah peluru
//     bot sebesar recoil yang terakumulasi SEBELUM tembakan ini (kick
//     tembakan N baru memengaruhi tembakan N+1, seperti aslinya), jadi
//     burst 3-5 bot naik mengikuti pola, lalu pulih saat jeda. Pemain
//     manusia TIDAK kena putaran ini (kameranya sudah membawa recoil —
//     dikenali dari shooter.pitch yang hanya dimiliki hero); kalau diputar
//     juga, recoil pemain jadi ganda.
//  2. POLA RECOIL DETERMINISTIK DAN BISA DIPELAJARI. Tiap senjata punya
//     tabel kick [pitch, yaw] per tembakan beruntun (burst). Kick yang
//     sama pada urutan tembakan yang sama SELALU menghasilkan offset yang
//     sama — tidak ada acak di pola, acak hanya di kerucut spread. Pola
//     diulang (modulo panjang tabel) selama burst; burst direset hanya
//     kalau bidikan sudah benar-benar pulih (lihat tickGun).
//  3. RECOVERY DUA FASE (dulu: pitchKick luruh 0.055 rad/dtk — bidikan
//     tetap naik ~4 detik setelah berhenti menembak, SEMENTARA burst sudah
//     direset saat bloom==0 (~0.6 dtk), jadi pola "mulai dari 0" itu bohong).
//     Sekarang: selama burst (idle < 0.3 dtk) kick meluruh pelan (exp,
//     1.2/dtk) supaya pola sempat menumpuk dan terasa; setelah 0.3 dtk
//     tidak menembak, kick meluruh cepat (linear 0.6 rad/dtk) dan burst
//     direset begitu kick nol — bidikan pulih total ~0.5-0.6 dtk setelah
//     tembakan terakhir, seperti CS.
//  4. SPREAD YANG MENGHUKUM TEMBAK SAMBIL BERGERAK (rumus draft
//     dipertahankan — sudah benar: diam < bergerak < airborne, crouch
//     mengecilkan; bloom = panas spray menambah spread tiap tembakan).
//  5. FALLOFF JARAK RINGAN (draft): damage penuh sampai setengah range,
//     luruh linear ke 60% di ujung range.
//  6. firePellet kini juga mengembalikan dx/dy/dz (arah SEBENARNYA tiap
//     peluru, aditif — pemanggil lama tidak terganggu). main.js/bots.js
//     selama ini menggambar tracer dari arah bidik nominal x jarak; dengan
//     dx/dy/dz tracer bisa digambar tepat di titik kena. Lihat laporan Lane H.
import { rayWalls } from './map.js';
import { clamp } from './rng.js';

export const WEAPONS = {
  pistol: {
    name: 'Pistol Pelabuhan', price: 0, damage: 34, headMult: 2,
    rpm: 350, mag: 12, reserve: 48, auto: false, pellets: 1,
    spreadBase: 0.011, spreadMove: 0.020, spreadAir: 0.045, spreadCrouch: 0.006,
    // Kalibrasi bloom (Lane H): bloom/tembakan HARUS melebihi
    // recover x waktu/tembakan, kalau tidak bloom tidak pernah menumpuk
    // (draft: inflow 0.023/dtk < recover 0.10/dtk — spray tidak pernah
    // melebar). Di sini inflow 0.117/dtk vs recover 0.10/dtk: 12 tembakan
    // menaikkan spread 0.011 -> ~0.046, pulih lagi dalam ~0.35 dtk.
    bloom: 0.020, recover: 0.10,
    // Tendangan tunggal yang tenang: naik sedikit, nyaris tanpa drift.
    // Pola 3 langkah lalu berulang — pistol memang untuk tap, bukan spray.
    recoil: [[0.016, 0.000], [0.016, 0.001], [0.015, -0.001]],
    range: 60, tracer: 0xffe08a,
  },
  rifle: {
    name: 'Senapan Senja', price: 2700, damage: 36, headMult: 2,
    rpm: 600, mag: 30, reserve: 90, auto: true, pellets: 1,
    spreadBase: 0.008, spreadMove: 0.026, spreadAir: 0.055, spreadCrouch: 0.004,
    // Kalibrasi bloom (Lane H): inflow 0.012 x 10 tembakan/dtk = 0.12/dtk
    // vs recover 0.085/dtk — spray 12 tembakan menaikkan spread diam
    // 0.008 -> ~0.05 (cap), pulih dalam ~0.5 dtk setelah berhenti.
    // Draft 0.0035 tidak pernah menumpuk (inflow 0.035 < recover 0.085).
    bloom: 0.012, recover: 0.085,
    // Pola klasik yang bisa dipelajari: naik lurus 3 tembakan pertama,
    // lalu goyangan kiri-kanan (drift + lalu -) dan mereda di akhir —
    // penembak yang menarik mouse ke bawah mengikuti pola ini tetap di
    // badan; yang menahan pelatuk, pelurunya naik ~8 derajat per mag.
    recoil: [[0.011, 0.000], [0.013, 0.002], [0.014, 0.003], [0.015, -0.002],
             [0.014, -0.004], [0.013, -0.002], [0.012, 0.003], [0.012, 0.004],
             [0.011, 0.001], [0.011, 0.000], [0.011, 0.001], [0.011, 0.000]],
    range: 90, tracer: 0xffe08a,
  },
  marksman: {
    name: 'Penembak Jarak', price: 3500, damage: 88, headMult: 2,
    rpm: 48, mag: 5, reserve: 20, auto: false, pellets: 1,
    spreadBase: 0.002, spreadMove: 0.040, spreadAir: 0.070, spreadCrouch: 0.001,
    bloom: 0.020, recover: 0.05,
    // Satu tendangan besar; rpm 48 (1.25 dtk/tembakan) berarti tiap
    // tembakan selalu pola langkah 0 — bidikan pulih penuh di antaranya.
    recoil: [[0.055, 0.000]],
    range: 120, tracer: 0xffc46a,
  },
  shotgun: {
    name: 'Penyebar Dermaga', price: 1800, damage: 12, headMult: 2,
    rpm: 70, mag: 6, reserve: 24, auto: false, pellets: 8,
    spreadBase: 0.030, spreadMove: 0.045, spreadAir: 0.070, spreadCrouch: 0.020,
    bloom: 0.012, recover: 0.07,
    // Tendangan besar sekali per pompa; 8 pelet menyebar dari satu arah.
    recoil: [[0.045, 0.000]],
    range: 28, tracer: 0xffd27a,
  },
};

export const GRENADE = { name: 'Granat Frag', price: 300, damage: 95, radius: 6 };

// Konstanta recovery recoil (lihat header, poin 3).
const RECOIL_SLOW_K = 1.2;    // /dtk, peluruhan exp selama burst (idle < 0.3 dtk)
const RECOIL_FAST_LINEAR = 0.6; // rad/dtk, peluruhan linear setelah jeda
const RECOIL_FAST_AFTER = 0.3;  // dtk idle sebelum peluruhan cepat
const RECOIL_RESET_AFTER = 0.35; // dtk idle sebelum burst direset
const BLOOM_CAP = 0.05;

// Status tembak per petarung. Satu objek per petarung, dipakai ulang,
// tidak pernah dialokasi ulang di hot loop.
export function makeGunState(weaponId) {
  return {
    weaponId, ammo: WEAPONS[weaponId].mag,
    reserve: WEAPONS[weaponId].reserve,
    cooldown: 0, bloom: 0, recoilHeat: 0, burst: 0,
    pitchKick: 0, yawKick: 0, // recoil terakumulasi yang harus diserap bidikan
    idleT: 0, // detik sejak tembakan terakhir (pengatur recovery dua fase)
  };
}

// Kerucut spread saat ini (radian) untuk petarung dalam satu status gerak.
// Diam < bergerak < airborne; crouch mengecilkan; spray beruntun (bloom)
// membesarkan. Dipanggil tiap frame oleh player.js / bots.js dan hasilnya
// disimpan di gun._spread sebelum fireHitscan.
export function currentSpread(gun, moving, airborne, crouched) {
  const w = WEAPONS[gun.weaponId];
  let s = w.spreadBase + gun.bloom;
  if (airborne) s += w.spreadAir;
  else if (moving) s += w.spreadMove;
  if (crouched) s -= w.spreadCrouch;
  return Math.max(0.0015, s);
}

// Ray vs satu bola. Mengembalikan jarak t atau -1. Tanpa alokasi.
// Kalau origin sudah di dalam bola (jarak nol), kembalikan jarak keluar
// sisi jauh — tembakan point-blank tetap kena, bukan tembus.
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const tca = lx * dx + ly * dy + lz * dz;
  if (tca < 0) return -1;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca;
  const r2 = r * r;
  if (d2 > r2) return -1;
  const thc = Math.sqrt(r2 - d2);
  const t0 = tca - thc;
  return t0 >= 0 ? t0 : tca + thc;
}

// Bola kena satu petarung, dihitung dari posisi kakinya. Kepala di 1.52 m,
// torso 1.05 m, kaki 0.45 m. Hasil via array out (tanpa alokasi).
function targetSpheres(fighter, out) {
  const p = fighter.body.pos;
  out[0] = p.x; out[1] = 1.52; out[2] = p.z; out[3] = 0.22; // head
  out[4] = p.x; out[5] = 1.05; out[6] = p.z; out[7] = 0.42; // torso
  out[8] = p.x; out[9] = 0.45; out[10] = p.z; out[11] = 0.40; // legs
  return out;
}
const _sph = new Float32Array(12);

// Tembak SATU pelet hitscan. Mengembalikan
//   {hit, head, damage, dist, target, dx, dy, dz} — atau {hit:false, dist}
//   dx/dy/dz = arah SEBENARNYA pelet (ternormalisasi); pemanggil boleh
//   memakainya untuk tracer yang berakhir tepat di titik kena:
//   titik = origin + (dx, dy, dz) * dist.
// Penembak dikeluarkan dari target. Dinding terdekat (rayWalls 2D) memotong
// ray sebelum target. Damage di sini RAW (sebelum armor — armor diterapkan
// pemanggil via economy.applyArmor). Falloff: penuh sampai setengah range,
// luruh linear ke 60% di ujung range.
export function firePellet(origin, dir, weaponId, shooter, targets) {
  const w = WEAPONS[weaponId];
  const wallDist = rayWalls(origin.x, origin.z, dir.x, dir.z, w.range);
  let bestT = Math.min(wallDist, w.range);
  let bestTarget = null, bestHead = false;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t === shooter || !t.alive) continue;
    targetSpheres(t, _sph);
    for (let s = 0; s < 3; s++) {
      const tt = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
        _sph[s * 4], _sph[s * 4 + 1], _sph[s * 4 + 2], _sph[s * 4 + 3]);
      if (tt >= 0 && tt < bestT) {
        bestT = tt; bestTarget = t; bestHead = (s === 0);
      }
    }
  }
  if (!bestTarget) return { hit: false, dist: bestT, dx: dir.x, dy: dir.y, dz: dir.z };
  const fall = 1 - 0.4 * clamp((bestT - w.range * 0.5) / (w.range * 0.5), 0, 1);
  const damage = Math.round(w.damage * (bestHead ? w.headMult : 1) * fall);
  return { hit: true, head: bestHead, damage, dist: bestT, target: bestTarget,
           dx: dir.x, dy: dir.y, dz: dir.z };
}

// Satu tarikan pelatuk: putar arah dengan recoil, sebar dengan spread,
// tembakkan pelet, majukan recoil + bloom. dirIn adalah bidikan penembak
// (vektor satuan); rng memberi jitter spread. Mengembalikan array hasil
// pelet (buffer yang dipakai ulang, dibersihkan dulu).
//   origin: {x,y,z}, dir: {x,y,z} ternormalisasi
//   shooter: petarung yang menembak (dikeluarkan dari targets)
//   targets: array petarung (hidup, tim lawan)
//   out: array hasil, tiap elemen bentuk firePellet (lihat atas)
const _results = [];
export function fireHitscan(origin, dirIn, gun, rng, shooter, targets, out) {
  const w = WEAPONS[gun.weaponId];
  out.length = 0;
  _results.length = 0; // buffer pelet dipakai ulang: bersihkan dulu
  if (gun.ammo <= 0 || gun.cooldown > 0) return out;
  gun.ammo--;
  gun.cooldown = 60 / w.rpm;
  gun.idleT = 0;
  // Recoil: kick berikutnya dalam pola senjata. Offset yang diputar ke
  // peluru adalah recoil SEBELUM kick ini (prevPitch/prevYaw) — kick
  // tembakan N baru memengaruhi tembakan N+1, jadi tembakan pertama tiap
  // burst selalu tepat ke mana bidikan mengarah. Pola deterministik:
  // urutan tembakan yang sama -> offset yang sama persis.
  const prevPitch = gun.pitchKick, prevYaw = gun.yawKick;
  const kick = w.recoil[gun.burst % w.recoil.length];
  gun.burst++;
  gun.pitchKick += kick[0];
  gun.yawKick += kick[1];
  gun.bloom = Math.min(BLOOM_CAP, gun.bloom + w.bloom);
  gun.recoilHeat = gun.bloom;
  // Arah dasar tembakan ini. Bot (termasuk simPlayerBot): bidikannya
  // dihitung ulang tiap frame, jadi recoil HARUS diputar di sini atau
  // spray bot tidak pernah naik. Manusia: kameranya sudah membawa recoil
  // (player.js mengintegrasikan pitchKick/yawKick ke pitch/yaw) — diputar
  // di sini juga berarti recoil ganda. Pembeda: hanya hero yang punya
  // .pitch (angka); bot tidak punya field itu.
  let ox = dirIn.x, oy = dirIn.y, oz = dirIn.z;
  const cameraAim = shooter && typeof shooter.pitch === 'number';
  if (!cameraAim && (prevPitch !== 0 || prevYaw !== 0)) {
    // Basis ortonormal di sekitar dirIn: right = dir x up, up2 = right x dir.
    // Tanda yaw dibalik: di player.js, yawKick positif memutar bidikan ke
    // arah -right (heroAim: x = -sin(yaw)), jadi offset peluru memakai
    // -yaw supaya drift-nya searah dengan yang dilihat pemain manusia.
    let rx = -dirIn.z, ry = 0, rz = dirIn.x;
    const rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-6) { rx = 1; ry = 0; rz = 0; } // bidikan lurus ke atas/bawah
    else { rx /= rl; ry /= rl; rz /= rl; }
    const ux = ry * dirIn.z - rz * dirIn.y;
    const uy = rz * dirIn.x - rx * dirIn.z;
    const uz = rx * dirIn.y - ry * dirIn.x;
    ox = dirIn.x + rx * (-prevYaw) + ux * prevPitch;
    oy = dirIn.y + ry * (-prevYaw) + uy * prevPitch;
    oz = dirIn.z + rz * (-prevYaw) + uz * prevPitch;
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol; oy /= ol; oz /= ol;
  }
  for (let p = 0; p < w.pellets; p++) {
    // Jitter spread: seragam di dalam kerucut spread saat ini. Pemanggil
    // mengisi gun._spread tiap frame via currentSpread(); kalau kosong,
    // pakai spreadBase senjata.
    const sp = gun._spread || w.spreadBase;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * sp;
    // Basis ortonormal di sekitar arah dasar (tanpa alokasi).
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(oy) > 0.9) { ux = 1; uy = 0; uz = 0; }
    let bx = oy * uz - oz * uy;
    let by = oz * ux - ox * uz;
    let bz = ox * uy - oy * ux;
    const bl = Math.hypot(bx, by, bz) || 1;
    bx /= bl; by /= bl; bz /= bl;
    let cx = oy * bz - oz * by;
    let cy = oz * bx - ox * bz;
    let cz = ox * by - oy * bx;
    const dx = ox + (bx * Math.cos(a) + cx * Math.sin(a)) * r;
    const dy = oy + (by * Math.cos(a) + cy * Math.sin(a)) * r;
    const dz = oz + (bz * Math.cos(a) + cz * Math.sin(a)) * r;
    const dl = Math.hypot(dx, dy, dz) || 1;
    _results.push(firePellet(
      origin, { x: dx / dl, y: dy / dl, z: dz / dl },
      gun.weaponId, shooter, targets));
  }
  for (const r of _results) out.push(r);
  return out;
}

// Perawatan senjata per frame: tick cooldown, pulihkan bloom, pulihkan
// recoil (dua fase — lihat header), reset burst kalau bidikan sudah pulih.
export function tickGun(gun, dt) {
  const w = WEAPONS[gun.weaponId];
  if (gun.cooldown > 0) gun.cooldown -= dt;
  gun.idleT += dt;
  gun.bloom = Math.max(0, gun.bloom - w.recover * dt);
  gun.recoilHeat = gun.bloom;
  if (gun.idleT < RECOIL_FAST_AFTER) {
    // Selama burst: luruh pelan (exp) supaya pola sempat menumpuk.
    const f = Math.exp(-RECOIL_SLOW_K * dt);
    gun.pitchKick *= f;
    gun.yawKick *= f;
  } else {
    // Setelah jeda: luruh cepat (linear) sampai nol persis.
    gun.pitchKick = Math.max(0, gun.pitchKick - RECOIL_FAST_LINEAR * dt);
    // yawKick bisa negatif — luruh menuju nol dari kedua sisi.
    if (gun.yawKick > 0) gun.yawKick = Math.max(0, gun.yawKick - RECOIL_FAST_LINEAR * dt);
    else gun.yawKick = Math.min(0, gun.yawKick + RECOIL_FAST_LINEAR * dt);
  }
  if (Math.abs(gun.pitchKick) < 1e-4) gun.pitchKick = 0;
  if (Math.abs(gun.yawKick) < 1e-4) gun.yawKick = 0;
  // Pola mulai dari 0 hanya kalau bidikan sudah benar-benar pulih —
  // bukan saat bloom kebetulan nol sementara kick masih besar.
  if (gun.idleT > RECOIL_RESET_AFTER && gun.pitchKick === 0 && gun.yawKick === 0) {
    gun.burst = 0;
  }
}

export function reloadGun(gun) {
  const w = WEAPONS[gun.weaponId];
  if (gun.ammo >= w.mag || gun.reserve <= 0) return false;
  const need = w.mag - gun.ammo;
  const take = Math.min(need, gun.reserve);
  gun.ammo += take;
  gun.reserve -= take;
  return true;
}
