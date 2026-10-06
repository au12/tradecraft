// Sound effects, synthesised with Web Audio so there are no files to ship.

import { store } from './util.js';

let ctx = null;
let enabled = store.get('sound', 'on') === 'on';

export const soundOn = () => enabled;
export function setSound(on) {
  enabled = on;
  store.set('sound', on ? 'on' : 'off');
}

// Browsers only allow audio after a user gesture.
function context() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
window.addEventListener('pointerdown', () => enabled && context(), { once: true });

function tone(ac, { freq, to, start = 0, dur = 0.14, type = 'sine', gain = 0.12 }) {
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

const SOUNDS = {
  clue: (ac) => {
    tone(ac, { freq: 660, dur: 0.09, type: 'triangle' });
    tone(ac, { freq: 880, start: 0.09, dur: 0.16, type: 'triangle' });
  },
  good: (ac) => {
    tone(ac, { freq: 523, dur: 0.1, type: 'triangle' });
    tone(ac, { freq: 784, start: 0.08, dur: 0.2, type: 'triangle' });
  },
  miss: (ac) => tone(ac, { freq: 300, to: 220, dur: 0.22, type: 'sine', gain: 0.14 }),
  bad: (ac) => {
    tone(ac, { freq: 280, to: 180, dur: 0.18, type: 'sawtooth', gain: 0.07 });
    tone(ac, { freq: 210, to: 130, start: 0.14, dur: 0.26, type: 'sawtooth', gain: 0.07 });
  },
  assassin: (ac) => {
    tone(ac, { freq: 160, to: 40, dur: 0.7, type: 'sawtooth', gain: 0.12 });
    tone(ac, { freq: 90, to: 30, dur: 0.9, type: 'square', gain: 0.06 });
  },
  turn: (ac) => tone(ac, { freq: 587, dur: 0.18, type: 'sine', gain: 0.1 }),
  tick: (ac) => tone(ac, { freq: 1000, dur: 0.04, type: 'square', gain: 0.04 }),
  win: (ac) => [523, 659, 784, 1047].forEach((f, i) => tone(ac, { freq: f, start: i * 0.11, dur: 0.24, type: 'triangle' })),
  lose: (ac) => [392, 330, 262].forEach((f, i) => tone(ac, { freq: f, start: i * 0.16, dur: 0.3, type: 'sine' })),
};

export function play(name) {
  if (!enabled) return;
  const ac = context();
  if (!ac || ac.state !== 'running') return;
  try {
    SOUNDS[name]?.(ac);
  } catch {}
}
