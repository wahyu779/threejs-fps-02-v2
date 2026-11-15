// rounds.js — the round clock.
// One job: the phase machine — buy, live, over — plus the score and the
// match end. First team to 7 round wins takes the match (max 12 rounds).
// Sides swap at the half: after round 6 the team that attacked defends
// and vice versa (match.attackers flips when round 7 starts). TEAM_SIZE
// is 5; endRound guards unknown winners so they score/settle nothing.
import { settleRound } from './economy.js';

export const BUY_SECONDS = 12;
export const ROUND_SECONDS = 100;
export const END_SECONDS = 5;
export const WIN_ROUNDS = 7;
export const MAX_ROUNDS = 12;
export const HALF_ROUND = 7; // first round of the second half: sides swap
export const TEAM_SIZE = 5; // fighters per team: 5 Senja vs 5 Bayang = 10 fighters

export function makeMatch() {
  return {
    phase: 'buy',       // buy | live | over
    phaseT: BUY_SECONDS,
    round: 1,
    scoreSenja: 0, scoreBayang: 0,
    winner: null,       // 'senja' | 'bayang' once the round is decided
    winReason: '',      // elimination | explosion | defuse | time
    matchWinner: null,  // set when a team reaches WIN_ROUNDS or round 12 ends
    roundLog: [],       // short strings for the HUD killfeed/history
    attackers: 'senja', // team planting the bomb this half; flips at HALF_ROUND
    half: false,        // true once the second half has started
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
// Only 'senja' / 'bayang' are valid. An unknown winner (e.g. 'draw' or
// a mistyped string) must not add score or settle any wallet — an old
// else-branch used to silently score Bayang.
  if (winnerTeam === 'senja') m.scoreSenja++;
  else if (winnerTeam === 'bayang') m.scoreBayang++;
  else return; // round with no winner: phase stays 'over', no settle
  settleRound(fighters, winnerTeam, m.round); // roundId activates idempotency
  m.roundLog.unshift(`Round ${m.round}: ${winnerTeam === 'senja' ? 'Senja' : 'Bayang'} wins (${reason})`);
  // Per-round MVP: most kills, then most damage, on the winning team.
  const mvp = (fighters || []).filter((f) => f.team === winnerTeam)
    .sort((a, b) => (b.kills - a.kills) || (b.dmg || 0) - (a.dmg || 0))[0];
  if (mvp && mvp.kills > 0) m.roundLog[0] += ` — MVP ${mvp.name}`;
  if (m.roundLog.length > 6) m.roundLog.pop();
  if (m.scoreSenja >= WIN_ROUNDS || m.scoreBayang >= WIN_ROUNDS || m.round >= MAX_ROUNDS) {
    m.matchWinner = m.scoreSenja > m.scoreBayang ? 'senja'
      : m.scoreBayang > m.scoreSenja ? 'bayang' : 'draw';
  }
}

export function nextRound(m) {
  m.round++;
  // Half-time: sides swap. The team that attacked rounds 1-6 now defends.
  if (m.round === HALF_ROUND) {
    m.attackers = m.attackers === 'senja' ? 'bayang' : 'senja';
    m.half = true;
  }
  startRound(m);
}
