/**
 * Six synthesized percussion voices. No samples: every hit is built from
 * oscillators, noise and envelopes at the moment it is scheduled.
 *
 * Each voice takes: tune (0..1 → roughly ±1 octave), decay (0..1), level (0..1)
 * and a velocity for ratchets.
 */
export interface VoiceParams {
  tune: number;
  decay: number;
  level: number;
}

export interface VoiceDef {
  id: string;
  name: string; // Italian, for the panel
  en: string;
  play: (ctx: AudioContext, out: AudioNode, t: number, p: VoiceParams, vel: number) => void;
}

let noiseBuf: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

const oct = (tune: number) => 2 ** ((tune - 0.5) * 2); // 0.5 → ×1, 0 → ×½, 1 → ×2

function env(ctx: AudioContext, t: number, peak: number, dur: number, attack = 0.002) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + dur);
  return g;
}

function noiseSource(ctx: AudioContext, t: number, dur: number) {
  const s = ctx.createBufferSource();
  s.buffer = noise(ctx);
  s.start(t, Math.random() * 1.5);
  s.stop(t + dur + 0.05);
  return s;
}

export const VOICES: VoiceDef[] = [
  {
    id: 'kick',
    name: 'cassa',
    en: 'kick',
    play(ctx, out, t, p, vel) {
      const f = 52 * oct(p.tune);
      const dur = 0.18 + p.decay * 0.9;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * 3.2, t);
      o.frequency.exponentialRampToValueAtTime(f, t + 0.045);
      o.frequency.exponentialRampToValueAtTime(f * 0.8, t + dur);
      const g = env(ctx, t, 1.1 * p.level * vel, dur);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + dur + 0.05);
      // beater click
      const n = noiseSource(ctx, t, 0.01);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      n.connect(hp).connect(env(ctx, t, 0.25 * p.level * vel, 0.008)).connect(out);
    },
  },
  {
    id: 'snare',
    name: 'rullante',
    en: 'snare',
    play(ctx, out, t, p, vel) {
      const dur = 0.08 + p.decay * 0.35;
      const n = noiseSource(ctx, t, dur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1900 * oct(p.tune);
      bp.Q.value = 0.7;
      n.connect(bp).connect(env(ctx, t, 0.7 * p.level * vel, dur)).connect(out);
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(210 * oct(p.tune), t);
      o.frequency.exponentialRampToValueAtTime(150 * oct(p.tune), t + 0.06);
      o.connect(env(ctx, t, 0.55 * p.level * vel, 0.07 + p.decay * 0.08)).connect(out);
      o.start(t);
      o.stop(t + 0.3);
    },
  },
  {
    id: 'hat',
    name: 'charleston',
    en: 'hi-hat',
    play(ctx, out, t, p, vel) {
      // six detuned squares, the classic metallic cluster
      const dur = 0.03 + p.decay * 0.4;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 10000;
      bp.Q.value = 0.9;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7000;
      const g = env(ctx, t, 0.28 * p.level * vel, dur, 0.001);
      bp.connect(hp).connect(g).connect(out);
      for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) {
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = f * 1.6 * oct(p.tune);
        o.connect(bp);
        o.start(t);
        o.stop(t + dur + 0.05);
      }
    },
  },
  {
    id: 'wood',
    name: 'legno',
    en: 'wood',
    play(ctx, out, t, p, vel) {
      // an impulse ringing a resonant filter: a struck plate, not a synth tone
      const f = 780 * oct(p.tune);
      const dur = 0.05 + p.decay * 0.5;
      const n = noiseSource(ctx, t, 0.004);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(f * 1.08, t);
      bp.frequency.exponentialRampToValueAtTime(f, t + 0.03);
      bp.Q.value = 18 + p.decay * 40;
      const g = ctx.createGain();
      g.gain.value = 9 * p.level * vel;
      n.connect(bp).connect(g).connect(env(ctx, t, 1, dur, 0.001)).connect(out);
    },
  },
  {
    id: 'bell',
    name: 'campana',
    en: 'bell',
    play(ctx, out, t, p, vel) {
      // two-operator FM with an inharmonic ratio
      const f = 330 * oct(p.tune);
      const dur = 0.1 + p.decay * 1.2;
      const car = ctx.createOscillator();
      const mod = ctx.createOscillator();
      const idx = ctx.createGain();
      car.frequency.value = f;
      mod.frequency.value = f * 3.53;
      idx.gain.setValueAtTime(f * 4, t);
      idx.gain.exponentialRampToValueAtTime(f * 0.05, t + dur);
      mod.connect(idx).connect(car.frequency);
      car.connect(env(ctx, t, 0.32 * p.level * vel, dur)).connect(out);
      car.start(t);
      mod.start(t);
      car.stop(t + dur + 0.05);
      mod.stop(t + dur + 0.05);
    },
  },
  {
    id: 'crackle',
    name: 'fruscio',
    en: 'crackle',
    play(ctx, out, t, p, vel) {
      // a burst of chaotic grains: short noise pops at random pitches
      const grains = 3 + Math.round(p.decay * 9);
      for (let i = 0; i < grains; i++) {
        const tt = t + Math.random() * (0.03 + p.decay * 0.2);
        const n = noiseSource(ctx, tt, 0.012);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = (600 + Math.random() * 5000) * oct(p.tune);
        bp.Q.value = 6;
        n.connect(bp).connect(env(ctx, tt, (0.5 + Math.random() * 0.8) * p.level * vel, 0.006 + Math.random() * 0.02, 0.0005)).connect(out);
      }
    },
  },
];
