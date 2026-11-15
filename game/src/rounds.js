// rounds.js — the round clock of Pelabuhan Senja v2.
// One job: the phase machine — buy, live, over — plus the score and the
// match end. First team to 5 round wins takes the match (max 9 rounds).
// LANE P (v2): TEAM_SIZE = 5 (5v5 — main.js spawn 5 Senja + 5 Bayang);
// endRound dijaga supaya pemenang yang tidak dikenal ('senja'/'bayang'
// saja yang sah) tidak salah memberi skor + settle ke tim yang salah.
import { settleRound } from './economy.js';

export const BUY_SECONDS = 12;
export const ROUND_SECONDS = 100;
export const END_SECONDS = 5;
export const WIN_ROUNDS = 5;
export const MAX_ROUNDS = 9;
export const TEAM_SIZE = 5; // fighters per team: 5 Senja vs 5 Bayang = 10 fighter

export function makeMatch() {
  return {
    phase: 'buy',       // buy | live | over
    phaseT: BUY_SECONDS,
    round: 1,
    scoreSenja: 0, scoreBayang: 0,
    winner: null,       // 'senja' | 'bayang' once the round is decided
    winReason: '',      // elimination | explosion | defuse | time
    matchWinner: null,  // set when a team reaches WIN_ROUNDS or round 9 ends
    roundLog: [],       // short strings for the HUD killfeed/history
  };
}

export function startRound(m) {
  m.phase = 'buy';
  m.phaseT = BUY_SECONDS;
  m.winner = null;
  m.winReason = '';
}

// Advance the clock. Returns 'roundEnd' when a phase flips to over, or
// null. The caller decides the round winner (elimination / bomb / time)
// and calls endRound(); this only counts the clock down.
export function tickMatch(m, dt) {
  m.phaseT -= dt;
  if (m.phase === 'buy' && m.phaseT <= 0) {
    m.phase = 'live';
    m.phaseT = ROUND_SECONDS;
    return 'live';
  }
  if (m.phase === 'live' && m.phaseT <= 0) return 'time';
  if (m.phase === 'over' && m.phaseT <= 0) return 'next';
  return null;
}

export function endRound(m, winnerTeam, reason, fighters) {
  if (m.phase === 'over') return;
  m.phase = 'over';
  m.phaseT = END_SECONDS;
  m.winner = winnerTeam;
  m.winReason = reason;
  // Hanya 'senja' / 'bayang' yang sah. Pemenang tak dikenal (mis. 'draw'
  // atau string salah ketik) tidak boleh menambah skor atau men-settle
  // wallet — dulu cabang else-nya diam-diam memberi skor ke Bayang.
  if (winnerTeam === 'senja') m.scoreSenja++;
  else if (winnerTeam === 'bayang') m.scoreBayang++;
  else return; // ronde tanpa pemenang: fase tetap 'over', tanpa settle
  settleRound(fighters, winnerTeam, m.round); // roundId activates idempotency
  m.roundLog.unshift(`Ronde ${m.round}: ${winnerTeam === 'senja' ? 'Senja' : 'Bayang'} menang (${reason})`);
  if (m.roundLog.length > 6) m.roundLog.pop();
  if (m.scoreSenja >= WIN_ROUNDS || m.scoreBayang >= WIN_ROUNDS || m.round >= MAX_ROUNDS) {
    m.matchWinner = m.scoreSenja > m.scoreBayang ? 'senja'
      : m.scoreBayang > m.scoreSenja ? 'bayang' : 'draw';
  }
}

export function nextRound(m) {
  m.round++;
  startRound(m);
}
