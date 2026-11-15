// audio.js — sound, synthesised, no audio files.
// One job: every sound the game makes, built from WebAudio oscillators
// and filtered noise. All harbour-original: no sampled sounds, no rips.
let ctx = null;
let master = null;

export function initAudio() {
  if (ctx) return;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  } catch (e) { ctx = null; }
}

function noiseBuffer(dur) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  return buf;
}

function burst(freq, dur, type, vol, slideTo) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + dur);
}

function noise(dur, filterFreq, vol) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(dur);
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = filterFreq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(f); f.connect(g); g.connect(master);
  src.start(t);
}

export const sfx = {
  shot(weaponId) {
    if (!ctx) return;
    if (weaponId === 'marksman') { noise(0.28, 900, 0.9); burst(160, 0.18, 'square', 0.25, 60); }
    else if (weaponId === 'shotgun') { noise(0.22, 700, 0.9); burst(120, 0.15, 'square', 0.3, 50); }
    else if (weaponId === 'rifle') { noise(0.12, 1400, 0.7); burst(220, 0.08, 'square', 0.2, 90); }
    else { noise(0.09, 1800, 0.5); burst(320, 0.06, 'square', 0.15, 120); }
  },
  distantShot() { if (ctx) noise(0.15, 500, 0.18); },
  hit() { burst(1400, 0.05, 'sine', 0.25); },
  headshot() { burst(1800, 0.07, 'sine', 0.3); burst(900, 0.09, 'sine', 0.2); },
  kill() { burst(660, 0.08, 'sine', 0.25); burst(990, 0.12, 'sine', 0.25); },
  reload() { burst(500, 0.05, 'square', 0.12); setTimeout(() => burst(700, 0.05, 'square', 0.12), 180); },
  dryFire() { burst(900, 0.03, 'square', 0.1); },
  plantBeep() { burst(1100, 0.06, 'sine', 0.25); },
  bombBeep() { burst(950, 0.1, 'sine', 0.3); },
  explosion() { noise(1.1, 300, 1.0); burst(70, 0.9, 'sine', 0.5, 30); },
  roundWin() { [523, 659, 784].forEach((f, i) => setTimeout(() => burst(f, 0.18, 'sine', 0.25), i * 140)); },
  roundLose() { [392, 330, 262].forEach((f, i) => setTimeout(() => burst(f, 0.2, 'sine', 0.22), i * 150)); },
  buy() { burst(880, 0.06, 'sine', 0.2); burst(1320, 0.08, 'sine', 0.18); },
  hurt() { burst(140, 0.12, 'sawtooth', 0.2, 70); },
};
