// economy.js — Lane E (armor + loss-streak economy), Hunt 12 threejs-fps-02 v2
// Satu tugas: semua uang masuk/keluar dompet petarung, dan apa yang dilakukan
// armor terhadap damage yang masuk.
//
// Masalah v1: tim yang kalah 3 ronde beruntun bangkrut tiap ronde sesudahnya,
// match jadi snowball. Perbaikannya dua lapis:
//   * Rompi Kevlar ($650, 100 poin) menyerap separuh tiap hit sampai habis —
//     ronde yang kalah tidak terlalu sakit kalau sempat beli pelindung.
//   * Bonus loss-streak yang membesar tiap kekalahan beruntun, supaya tim
//     yang kalah beruntun selalu bisa beli lagi: $1.900 dasar, +$500 tiap
//     kekalahan beruntun tambahan, cap $3.400.
//
// Kontrak interface (mengikat, dipertahankan dari draft builder):
//   * applyArmor(wallet, damage) -> {hpDamage, armorDamage} (dipakai main.js:270
//     dan self-test main.js:662-667 — JANGAN ubah bentuk return ini).
//   * buyArmor / buyWeapon / buyGrenade -> {ok, reason} (bukan boolean lagi —
//     lihat GLUE EDITS di bawah: main.js:304-306 dan bots.js:82-86 HARUS
//     diubah koordinator, karena {ok:false} itu truthy di JS).
//   * settleRound(fighters, winnerTeam, roundId?) — fighters = array objek
//     {team: 'senja'|'bayang', wallet}; roundId opsional, mengaktifkan
//     idempotensi (settle ronde yang sama 2x = bonus 1x).
//   * getShopItems() -> [{id, key, label, note, price}] — katalog toko.
//   * Harga senjata TIDAK ditulis di sini: dibaca dari WEAPONS / GRENADE
//     (weapons.js) supaya katalog tidak pernah beda dari senjata aslinya.
import { WEAPONS, GRENADE } from './weapons.js';

// ---- Konstanta (MENGIKAT — jangan ubah) ----
export const ARMOR_PRICE = 650;
export const ARMOR_POINTS = 100;
export const ARMOR_ABSORB = 0.5; // separuh tiap hit masuk ke rompi
export const START_MONEY = 800;
export const WIN_BONUS = 3250;
export const LOSS_BASE = 1900;
export const LOSS_STREAK_STEP = 500;
export const LOSS_MAX = 3400;
export const KILL_BONUS = 300;
export const PLANT_BONUS = 300;
export const DEFUSE_BONUS = 300;

// ---- Dompet ----
// Field draft dipertahankan persis: money, lossStreak, armor, kills.
// Tambahan: weapon (senjata yang "dimiliki" dompet ini — dipakai buyWeapon
// untuk menolak beli dobel dalam satu ronde) dan _lastSettledRound
// (penjaga idempotensi settleRound). TIDAK ada field grenades di dompet:
// jumlah granat yang sebenarnya dipegang ada di fighter.grenades (main.js /
// bots.js yang pegang, direset tiap ronde) — menduplikasi di sini rawan
// desync saat granat dilempar (KeyG).
export function makeWallet() {
  return {
    money: START_MONEY,
    lossStreak: 0,   // kekalahan beruntun (0 = tidak kalah beruntun)
    armor: 0,        // poin rompi saat ini (0..ARMOR_POINTS)
    kills: 0,
    weapon: 'pistol', // senjata awal, gratis — sama seperti resetPlayer
    _lastSettledRound: -1,
  };
}

// ---- Armor: damage masuk -> split rompi / HP ----
// Mutasi wallet.armor. Return {hpDamage, armorDamage} — pemanggil
// mengurangi hpDamage dari HP (main.js:270: target.hp -= split.hpDamage).
// Aturan: rompi menyerap ARMOR_ABSORB (50%) dari damage, sisanya ke HP.
// Pembulatan Math.round (sama seperti draft — self-test main.js:662
// mengunci 40 -> 20/20):
//   * damage 1  -> serap 1 (round(0.5)=1), HP 0  — chip 1 damage habis di rompi
//   * damage 3  -> serap 2, HP 1
//   * damage 5  -> serap 3 (round(2.5)=3), HP 2
//   * damage 95 (granat) -> serap 48, HP 47
//   * headshot rifle 36x2=72 -> serap 36, HP 36
//   * headshot marksman 88x2=176 -> serap 88, HP 88, rompi sisa 12
// Kalau rompi kurang dari serapan yang diminta, rompi habis (0) dan sisa
// serapan yang tidak tertutup jatuh ke HP. Tanpa rompi: damage penuh ke HP.
// Headshot SUDAH dikali x2 di weapons.js sebelum masuk ke sini, jadi
// applyArmor menerima damage FINAL.
export function applyArmor(wallet, damage) {
  damage = Math.max(0, Math.floor(damage));
  if (damage <= 0) return { hpDamage: 0, armorDamage: 0 };
  if (!wallet || wallet.armor <= 0) return { hpDamage: damage, armorDamage: 0 };
  const wanted = Math.round(damage * ARMOR_ABSORB); // yang ingin diserap rompi
  const absorbed = Math.min(wallet.armor, wanted);
  wallet.armor -= absorbed;
  return { hpDamage: damage - absorbed, armorDamage: absorbed };
}

// ---- Pembelian ----
// Semua buy mengembalikan {ok, reason}. Uang TIDAK berubah kalau gagal.
// reason: 'ok' | 'not-enough-money' | 'already-full' | 'already-owned' |
//         'unknown-weapon' | 'no-wallet'.
export function buyArmor(wallet) {
  if (!wallet) return { ok: false, reason: 'no-wallet' };
  if (wallet.armor >= ARMOR_POINTS) {
    return { ok: false, reason: 'already-full' }; // rompi masih penuh
  }
  if (wallet.money < ARMOR_PRICE) {
    return { ok: false, reason: 'not-enough-money' };
  }
  wallet.money -= ARMOR_PRICE;
  wallet.armor = ARMOR_POINTS;
  return { ok: true, reason: 'ok' };
}

export function buyWeapon(wallet, weaponId) {
  if (!wallet) return { ok: false, reason: 'no-wallet' };
  const w = WEAPONS[weaponId];
  if (!w) return { ok: false, reason: 'unknown-weapon' };
  // Pistol harga 0 = senjata awal, sudah dimiliki — tidak bisa "dibeli".
  if (w.price <= 0 || wallet.weapon === weaponId) {
    return { ok: false, reason: 'already-owned' };
  }
  if (wallet.money < w.price) {
    return { ok: false, reason: 'not-enough-money' };
  }
  wallet.money -= w.price;
  wallet.weapon = weaponId;
  return { ok: true, reason: 'ok' };
}

export function buyGrenade(wallet) {
  if (!wallet) return { ok: false, reason: 'no-wallet' };
  if (wallet.money < GRENADE.price) {
    return { ok: false, reason: 'not-enough-money' };
  }
  wallet.money -= GRENADE.price;
  // Granat itu consumable: tiap beli = +1 granat, boleh menumpuk.
  // Jumlah yang dipegang dicatat pemanggil di fighter.grenades (main.js
  // menambah hero.grenades++, bots.js set bot.grenades = 1). Bot membatasi
  // diri ke 1 granat lewat cek bot.grenades === 0 di botBuy.
  return { ok: true, reason: 'ok' };
}

// ---- Bonus per ronde ----
export function lossBonusFor(streak) {
  // streak = jumlah kekalahan beruntun. 1 -> 1900, 2 -> 2400, 3 -> 2900,
  // 4+ -> 3400 (cap). streak 0 diperlakukan sebagai 1 (tidak pernah 1400).
  return Math.min(LOSS_BASE + Math.max(0, Math.floor(streak) - 1) * LOSS_STREAK_STEP, LOSS_MAX);
}

// settleRound(fighters, winnerTeam, roundId?)
// fighters: array objek {team: 'senja'|'bayang', wallet} (bentuk yang
// dipakai rounds.js:63 — JANGAN ubah bentuk ini).
// winnerTeam: 'senja' | 'bayang'.
// roundId: nomor ronde (opsional, DISARANKAN — rounds.js sebaiknya kirim
// m.round; lihat GLUE EDITS). Kalau diisi, settle ronde yang sama 2x
// tidak memberi bonus 2x (idempotent, dijaga _lastSettledRound).
// Menang: +WIN_BONUS, lossStreak -> 0. Kalah: lossStreak + 1,
// +lossBonusFor(lossStreak baru).
// Efek samping yang disengaja: wallet.weapon direset ke 'pistol' tiap
// settle — cermin dari resetPlayer (player.js:28) yang mereset gun hero
// ke pistol tiap ronde. Tanpa reset ini, cek already-owned di buyWeapon
// akan menolak hero beli rifle lagi di ronde berikut (padahal gun-nya
// sudah direset ke pistol). Bot tidak terpengaruh: botBuy mengunci di
// bot.gun.weaponId, dan resetBot mempertahankan senjata bot antar ronde.
export function settleRound(fighters, winnerTeam, roundId) {
  if (!Array.isArray(fighters)) return { ok: false, reason: 'bad-fighters' };
  const useId = roundId !== undefined && roundId !== null;
  const out = { ok: true, winner: winnerTeam, bonuses: {} };
  for (const f of fighters) {
    if (!f || !f.wallet) continue;
    const w = f.wallet;
    if (useId && w._lastSettledRound === roundId) continue; // sudah di-settle
    if (useId) w._lastSettledRound = roundId;
    let bonus;
    if (f.team === winnerTeam) {
      bonus = WIN_BONUS;
      w.lossStreak = 0;
    } else {
      w.lossStreak = (w.lossStreak || 0) + 1;
      bonus = lossBonusFor(w.lossStreak);
    }
    w.money += bonus;
    w.weapon = 'pistol'; // gun direset tiap ronde (cermin resetPlayer)
    out.bonuses[f.team] = bonus;
  }
  return out;
}

// Bonus aksi dalam ronde (+300, tanpa batas). main.js saat ini meng-inline
// ini langsung (money += KILL_BONUS dst, main.js:280/404/429) — helper ini
// untuk pemakaian dari lane lain / test, perilakunya identik.
export function awardKill(wallet) {
  if (!wallet) return 0;
  wallet.money += KILL_BONUS;
  wallet.kills = (wallet.kills || 0) + 1;
  return KILL_BONUS;
}
export function awardPlant(wallet) {
  if (!wallet) return 0;
  wallet.money += PLANT_BONUS;
  return PLANT_BONUS;
}
export function awardDefuse(wallet) {
  if (!wallet) return 0;
  wallet.money += DEFUSE_BONUS;
  return DEFUSE_BONUS;
}

// ---- Katalog toko (dibaca hud.js untuk buy menu) ----
// Bentuk item: {id, key, label, note, price} — JANGAN ubah bentuk.
// ID senjata SAMA PERSIS dengan key WEAPONS (weapons.js) dan dengan
// data-buy di buy menu (game/index.html:91-95): rifle, marksman,
// shotgun, armor, grenade. Harga diambil dari WEAPONS / GRENADE supaya
// katalog tidak pernah beda dari senjata aslinya.
// CATATAN: hud.js BELUM membaca katalog ini — buy menu saat ini hardcoded
// di game/index.html:88-95 dan wiring klik di main.js:301-312. Katalog ini
// siap dipakai saat hud.js dirapikan (glue opsional, bukan blocker).
// key = tombol shortcut menu yang disarankan; '1' saat ini dipakai main.js
// untuk switch ke pistol (main.js:487) — kalau hud.js nanti mengikat key
// ini, Digit1 harus dipindah dulu.
export function getShopItems() {
  return [
    { id: 'rifle', key: '1', label: 'Senapan Senja', note: 'Senapan serbu — akurat, 600 rpm', price: WEAPONS.rifle.price },
    { id: 'marksman', key: '2', label: 'Penembak Jarak', note: 'Penembak jitu — damage 88, 5 peluru', price: WEAPONS.marksman.price },
    { id: 'shotgun', key: '3', label: 'Penyebar Dermaga', note: 'Shotgun — 8 pellet jarak dekat', price: WEAPONS.shotgun.price },
    { id: 'armor', key: '4', label: 'Rompi Kevlar', note: '100 poin rompi — serap 50% tiap hit', price: ARMOR_PRICE },
    { id: 'grenade', key: '5', label: 'Granat Frag', note: 'Damage area 95, radius 6', price: GRENADE.price },
    { id: 'pistol', key: '0', label: 'Pistol Pelabuhan', note: 'Senjata awal — sudah dimiliki', price: WEAPONS.pistol.price },
  ];
}

// Default export untuk pemakaian dinamis (main.js boleh import named saja).
export default {
  ARMOR_PRICE, ARMOR_POINTS, ARMOR_ABSORB,
  START_MONEY, WIN_BONUS, LOSS_BASE, LOSS_STREAK_STEP, LOSS_MAX,
  KILL_BONUS, PLANT_BONUS, DEFUSE_BONUS,
  makeWallet, applyArmor, buyArmor, buyWeapon, buyGrenade,
  lossBonusFor, settleRound, awardKill, awardPlant, awardDefuse,
  getShopItems,
};

// ---------------------------------------------------------------------------
// GLUE EDITS (koordinator yang buat — Lane E DILARANG edit file lain).
// WAJIB sebelum bundle, karena buy* sekarang mengembalikan {ok, reason}
// (objek selalu truthy — `if (buyArmor(w))` lama akan selalu lolos):
//
// 1) main.js:304-306 (buy menu) — ganti:
//      if (kind === 'armor') { if (buyArmor(w)) { sfx.buy(); feedLine('Kamu membeli Rompi Kevlar'); } }
//      else if (kind === 'grenade') { if (buyGrenade(w)) { hero.grenades++; sfx.buy(); } }
//      else if (buyWeapon(w, kind)) {
//    menjadi:
//      if (kind === 'armor') { const r = buyArmor(w); if (r.ok) { sfx.buy(); feedLine('Kamu membeli Rompi Kevlar'); } else feedLine('Gagal beli rompi: ' + r.reason); }
//      else if (kind === 'grenade') { const r = buyGrenade(w); if (r.ok) { hero.grenades++; sfx.buy(); } else feedLine('Gagal beli granat: ' + r.reason); }
//      else if (buyWeapon(w, kind).ok) {
//    (dan di dalam blok senjata, tambahkan else feedLine('Gagal beli senjata: ' + ...)
//     bila diinginkan — opsional.)
//
// 2) bots.js:82 dan :86 (botBuy) — ganti:
//      if (buyWeapon(w, 'rifle')) bot.gun = makeGunState('rifle');
//      if (buyGrenade(w)) bot.grenades = 1;
//    menjadi:
//      if (buyWeapon(w, 'rifle').ok) bot.gun = makeGunState('rifle');
//      if (buyGrenade(w).ok) bot.grenades = 1;
//    (bots.js:84 `if (w.money >= 650) buyArmor(w);` tidak dicek return-nya,
//     jadi aman tanpa ubahan — tapi .ok boleh ditambah untuk konsistensi.)
//
// 3) rounds.js:63 — ganti:
//      settleRound(fighters, winnerTeam);
//    menjadi:
//      settleRound(fighters, winnerTeam, m.round);
//    (mengaktifkan idempotensi per ronde; tanpa ini, proteksi ganda hanya
//     mengandalkan guard `if (m.phase === 'over') return;` di endRound.)
// ---------------------------------------------------------------------------
