// economy.js — money, armour, and the loss-streak bonus.
// One job: every dollar in and out of a wallet, and what armour does to
// incoming damage. A losing team must never go broke: a Kevlar vest ($650)
// absorbs half of every hit, and the loss bonus grows $1,900 + $500 per
// extra consecutive loss (cap $3,400). Buys return {ok, reason}, never a
// boolean (an object is always truthy — callers must check .ok). Weapon
// prices are read from weapons.js, so the catalogue cannot disagree.
import { WEAPONS, GRENADE } from './weapons.js';
import { SMOKE_GRENADE } from './tactics.js'; // smoke price lives in tactics.js

// ---- Constants (binding) ----
export const ARMOR_PRICE = 650;
export const ARMOR_POINTS = 100;
export const ARMOR_ABSORB = 0.5; // half of every hit goes to the vest
export const START_MONEY = 800;
export const WIN_BONUS = 3250;
export const LOSS_BASE = 1900;
export const LOSS_STREAK_STEP = 500;
export const LOSS_MAX = 3400;
export const KILL_BONUS = 300;
export const PLANT_BONUS = 300;
export const DEFUSE_BONUS = 300;
// Helmet $400: halves headshot damage for the round (reset in setupRound).
export const HELMET_PRICE = 400;
export const HELMET_HEAD_FACTOR = 0.5;
// Kill reward per weapon: sniper $100 (for picks, not farming), marksman $150, rest $300.
export const KILL_REWARD = { sniper: 100, marksman: 150, rifle: 300, shotgun: 300, pistol: 300 };
export function killRewardFor(weaponId) {
  return KILL_REWARD[weaponId] || KILL_BONUS;
}
export function headDamageFactor(wallet, head) {
  return head && wallet && wallet.helmet ? HELMET_HEAD_FACTOR : 1;
}

// Wallet: money, lossStreak, armor, kills, weapon (owned gun — buyWeapon
// refuses a double buy), _lastSettledRound (settle idempotency).
export function makeWallet() {
  return {
    money: START_MONEY,
    lossStreak: 0,   // consecutive losses (0 = none)
    armor: 0,        // vest points now (0..ARMOR_POINTS)
    helmet: false,   // helm: separuh damage kepala (v4 tactics lane)
    kills: 0,
    weapon: 'pistol', // starting gun, free — mirrors resetPlayer
    _lastSettledRound: -1,
  };
}

// ---- Armour: incoming damage -> vest / HP split ----
// Mutates wallet.armor, returns {hpDamage, armorDamage}. The vest absorbs
// ARMOR_ABSORB (50%); if it holds less, it empties and the rest falls to
// HP. No vest: full damage to HP. Headshots arrive already multiplied,
// so this sees FINAL damage. Rounding: Math.round (self-test: 40 -> 20/20).
export function applyArmor(wallet, damage) {
  damage = Math.max(0, Math.floor(damage));
  if (damage <= 0) return { hpDamage: 0, armorDamage: 0 };
  if (!wallet || wallet.armor <= 0) return { hpDamage: damage, armorDamage: 0 };
  const wanted = Math.round(damage * ARMOR_ABSORB); // what the vest should absorb
  const absorbed = Math.min(wallet.armor, wanted);
  wallet.armor -= absorbed;
  return { hpDamage: damage - absorbed, armorDamage: absorbed };
}

// Every buy returns {ok, reason} ('ok'|'not-enough-money'|'already-full'|
export function buyArmor(wallet) {
  if (!wallet) return { ok: false, reason: 'no-wallet' };
  if (wallet.armor >= ARMOR_POINTS) {
    return { ok: false, reason: 'already-full' }; // vest still full
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
  // A price-0 pistol is the starting gun, already owned — never buyable.
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
  // Grenades are consumable: each buy = +1 (stacking allowed); the count
  // lives on fighter.grenades, and bots cap themselves at 1 in botBuy.
  return { ok: true, reason: 'ok' };
}

export function buySmoke(wallet) {
  if (!wallet) return { ok: false, reason: 'no-wallet' };
  if (wallet.money < SMOKE_GRENADE.price) {
    return { ok: false, reason: 'not-enough-money' };
  }
  wallet.money -= SMOKE_GRENADE.price;
  return { ok: true, reason: 'ok' };
}

export function buyHelmet(wallet) {
  if (!wallet) return { ok: false, reason: 'no-wallet' };
  if (wallet.helmet) return { ok: false, reason: 'already-owned' };
  if (wallet.money < HELMET_PRICE) {
    return { ok: false, reason: 'not-enough-money' };
  }
  wallet.money -= HELMET_PRICE;
  wallet.helmet = true;
  return { ok: true, reason: 'ok' };
}

// ---- Per-round bonus ----
// streak = consecutive losses: 1 -> 1900, 2 -> 2400, 3 -> 2900, 4+ -> 3400 (cap).
export function lossBonusFor(streak) {
  return Math.min(LOSS_BASE + Math.max(0, Math.floor(streak) - 1) * LOSS_STREAK_STEP, LOSS_MAX);
}

// settleRound(fighters, winnerTeam, roundId?): fighters are {team, wallet}.
// Win: +WIN_BONUS, lossStreak -> 0. Loss: lossStreak + 1, +lossBonusFor.
// roundId makes settling idempotent (same round twice pays once). The
// wallet.weapon reset to 'pistol' mirrors resetPlayer — without it the
// already-owned check would refuse the hero a rifle next round.
export function settleRound(fighters, winnerTeam, roundId) {
  if (!Array.isArray(fighters)) return { ok: false, reason: 'bad-fighters' };
  const useId = roundId !== undefined && roundId !== null;
  const out = { ok: true, winner: winnerTeam, bonuses: {} };
  for (const f of fighters) {
    if (!f || !f.wallet) continue;
    const w = f.wallet;
    if (useId && w._lastSettledRound === roundId) continue; // already settled
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
    w.weapon = 'pistol'; // gun resets each round (mirrors resetPlayer)
    out.bonuses[f.team] = bonus;
  }
  return out;
}

// In-round action bonus (+300, uncapped). main.js inlines it; these helpers
// exist for tests and other callers, with identical behaviour.
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

// ---- Shop catalogue (read by hud.js for the buy menu) ----
// Item shape: {id, key, label, note, price} — do NOT change the shape.
// Weapon ids are EXACTLY the WEAPONS keys (weapons.js) and the data-buy
// values in the buy menu (game/index.html:91-95): rifle, marksman,
// shotgun, armor, grenade. Prices come from WEAPONS / GRENADE so the
// catalogue can never disagree with the guns themselves.
export function getShopItems() {
  return [
    { id: 'rifle', key: '1', label: 'Senja Rifle', note: 'Assault rifle — accurate, 600 rpm', price: WEAPONS.rifle.price },
    { id: 'marksman', key: '2', label: 'Longshot Marksman', note: 'Sharpshooter — 88 damage, 5 rounds', price: WEAPONS.marksman.price },
    { id: 'shotgun', key: '3', label: 'Dockside Scattergun', note: 'Shotgun — 8 pellets, close range', price: WEAPONS.shotgun.price },
    { id: 'sniper', key: '6', label: 'Harbour Sniper', note: 'Scoped — 110 dmg, headshot x4', price: WEAPONS.sniper.price },
    { id: 'armor', key: '4', label: 'Kevlar Vest', note: '100 vest points — absorbs 50% of every hit', price: ARMOR_PRICE },
    { id: 'helmet', key: '7', label: 'Combat Helmet', note: 'Halves head damage', price: HELMET_PRICE },
    { id: 'grenade', key: '5', label: 'Frag Grenade', note: '95 area damage, radius 6', price: GRENADE.price },
    { id: 'smoke', key: '8', label: 'Smoke Grenade', note: 'Smoke 14s — blocks sight', price: SMOKE_GRENADE.price },
    { id: 'pistol', key: '0', label: 'Harbour Pistol', note: 'Starting gun — already owned', price: WEAPONS.pistol.price },
  ];
}


// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
