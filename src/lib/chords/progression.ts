/**
 * Attrattore: from a chaotic number to a chord, and from chords to notes.
 *
 * Candidates come from four theories (reusing the site's harmony library):
 *   Piston (1941) usual root progressions · neo-Riemannian P, L, R and their
 *   compounds (Cohn 1998) · Tymoczko's voice-leading space (2006) · Lerdahl's
 *   Tonal Pitch Space (2001).
 * Weights are shaped by the swarm (density near each chord on a circle-of-fifths
 * dial) and by a tension curve measured as Plomp–Levelt sensory dissonance
 * (Sethares 1993). The candidates are ordered dark → bright by their place on
 * the circle of fifths, and the chaotic section coordinate u picks one by
 * inverting the cumulative weights: the attractor's lobe chooses the colour.
 */
import { chord, diatonic, dissonance, midiHz, mod12, pistonRow, plr, roman, tpsDistance, vlDistance, type Chord, type Key } from '../synth/harmony';

export const MODELS = ['all theories', 'Piston: functional', 'Cohn: neo-Riemannian', 'Tymoczko: voice leading', 'Lerdahl: tonal pitch space'] as const;
export const TENSION = ['flat', 'arch', 'rise', 'fall', 'golden arch'] as const;
export const VOICINGS = ['close', 'drop 2', 'open', 'spread'] as const;
export const EXTENSIONS = ['triads', 'sevenths', 'ninths', 'elevenths', 'thirteenths'] as const;
export const PATTERNS = ['block', 'strum', 'arp up', 'arp down', 'arp up-down', 'Alberti', 'comp'] as const;
export const BASS = ['off', 'roots', 'root–fifth', 'walking', 'tonic pedal'] as const;

export interface Link {
  chord: Chord;
  locked: boolean;
  tension: number; // measured, 0..1 within its candidate set
  u: number; // the chaotic coordinate that chose it
}

const triad = (c: Chord): Chord => (c.quality === 'm' || c.quality === 'M' ? c : chord(c.root, c.pcs.includes(mod12(c.root + 3)) && !c.pcs.includes(mod12(c.root + 4)) ? 'm' : 'M'));
const degreeOf = (c: Chord, k: Key) => {
  const sc = (k.minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]).map((i) => mod12(k.tonic + i));
  const i = sc.indexOf(c.root);
  return i < 0 ? 1 : i + 1;
};

/** Brightness on the circle of fifths relative to the tonic (minor chords sit three fifths darker). */
export const brightness = (c: Chord, k: Key) => {
  const f = mod12((c.root - k.tonic) * 7);
  return (f > 6 ? f - 12 : f) - (c.quality === 'm' || c.quality === 'm7' || c.quality === 'd' ? 3 : 0);
};

/** Where a chord sits on the dial the swarm flies over: angle = circle of fifths, radius = mode. */
export function anchorOf(c: Chord): [number, number] {
  const a = (mod12(c.root * 7) / 12) * Math.PI * 2 - Math.PI / 2;
  const r = c.quality === 'm' || c.quality === 'm7' ? 0.6 : c.quality === 'd' || c.quality === 'h7' ? 0.4 : 0.9;
  return [Math.cos(a) * r, Math.sin(a) * r];
}

export function candidates(model: number, prev: Chord, key: Key, spice: number): Array<[Chord, number]> {
  const out = new Map<string, [Chord, number]>();
  const add = (c: Chord, w: number) => {
    const e = out.get(c.name);
    out.set(c.name, [c, (e?.[1] ?? 0) + w]);
  };
  const all = model === 0;
  if (all || model === 1) for (const [deg, w] of pistonRow(degreeOf(prev, key), spice)) add(diatonic(key, deg), w);
  if (all || model === 2) {
    const t = triad(prev);
    const ops: Array<['P' | 'L' | 'R', ...Array<'P' | 'L' | 'R'>]> = [['P'], ['L'], ['R'], ['L', 'P'], ['R', 'P'], ['P', 'L'], ['P', 'R'], ['L', 'R'], ['R', 'L']];
    for (const seq of ops) add(seq.reduce((c, o) => plr(c, o), t), seq.length === 1 ? 3 : 1);
  }
  if (all || model === 3)
    for (let r = 0; r < 12; r++)
      for (const q of ['M', 'm', '7'] as const) {
        const c = chord(r, q);
        const d = vlDistance(prev.pcs, c.pcs);
        if (d >= 1 && d <= 3) add(c, 4 - d);
      }
  if (all || model === 4) {
    const keys: Key[] = [key, { tonic: mod12(key.tonic + 7), minor: key.minor }, { tonic: mod12(key.tonic + 5), minor: key.minor }, { tonic: mod12(key.tonic + (key.minor ? 3 : 9)), minor: !key.minor }];
    for (const k2 of keys)
      for (let deg = 1; deg <= 7; deg++) {
        const c = diatonic(k2, deg);
        if (c.name !== prev.name) add(c, 5 * Math.exp(-tpsDistance(prev, key, c, k2) / 3));
      }
  }
  out.delete(prev.name);
  return [...out.values()];
}

export function tensionTarget(curve: number, i: number, n: number) {
  const x = n > 1 ? i / (n - 1) : 0;
  switch (TENSION[curve]) {
    case 'arch':
      return Math.sin(Math.PI * x);
    case 'rise':
      return x;
    case 'fall':
      return 1 - x;
    case 'golden arch': {
      const g = 1 / ((1 + Math.sqrt(5)) / 2); // climax at the golden section
      return x < g ? x / g : (1 - x) / (1 - g);
    }
    default:
      return 0.5;
  }
}

export interface ChooseOpts {
  model: number;
  key: Key;
  spice: number;
  u: number;
  target: number;
  tensionAmt: number;
  bias: (c: Chord) => number; // swarm density near the chord's anchor, 0..1
  influence: number;
  gravity: number; // 0..1: pull toward the key (penalises tones outside the scale)
}

export function choose(prev: Chord, o: ChooseOpts): { chord: Chord; tension: number } {
  const cands = candidates(o.model, prev, o.key, o.spice);
  if (!cands.length) return { chord: diatonic(o.key, 1), tension: 0 };
  const d = cands.map(([c]) => dissonance(c.pcs.map((pc) => midiHz(48 + c.pcs[0] + mod12(pc - c.pcs[0])))));
  const lo = Math.min(...d), hi = Math.max(...d);
  const scale = (o.key.minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11]).map((i) => mod12(o.key.tonic + i));
  const scored = cands.map(([c, w], i) => {
    const dn = hi > lo ? (d[i] - lo) / (hi - lo) : 0.5;
    const fit = Math.exp(-((dn - o.target) ** 2) / (2 * 0.18 ** 2));
    const outside = c.pcs.filter((p) => !scale.includes(p)).length;
    const wt = w * (1 - o.tensionAmt + o.tensionAmt * fit) * (1 + o.influence * 4 * o.bias(c)) * Math.exp(-o.gravity * 2.5 * outside);
    return { c, w: wt, dn, b: brightness(c, o.key) };
  });
  scored.sort((a, b) => a.b - b.b || a.c.name.localeCompare(b.c.name));
  const tot = scored.reduce((a, s) => a + s.w, 0);
  let acc = 0;
  for (const s of scored) if ((acc += s.w / tot) >= o.u) return { chord: withRoman(s.c, o.key), tension: s.dn };
  const last = scored[scored.length - 1];
  return { chord: withRoman(last.c, o.key), tension: last.dn };
}
/** Numerals are always relative to the chain's own key, even for chords borrowed from a neighbouring key. */
const withRoman = (c: Chord, k: Key): Chord => ({ ...c, roman: roman(c, k.tonic) });

// ── composer's tools: reharmonisation ──────────────────────────────────────

export function secondaryDominants(chain: Link[], key: Key) {
  for (let i = 0; i < chain.length - 1; i++) {
    const t = chain[i + 1].chord;
    if (chain[i].locked || t.root === key.tonic || Math.random() < 0.4) continue;
    const c = chord(t.root + 7, '7', 'V/');
    chain[i] = { ...chain[i], chord: { ...c, roman: `V7/${t.roman ?? roman(t, key.tonic)}` } };
  }
}
export function tritoneSubs(chain: Link[], key: Key) {
  for (const l of chain) if (!l.locked && l.chord.quality === '7') l.chord = { ...chord(l.chord.root + 6, '7', 'SubV'), roman: `subV (${roman(chord(l.chord.root + 6, '7'), key.tonic)})` };
}
/** Borrow from the parallel mode: IV→iv, vi→♭VI, iii→♭III, ii→iiø in major (and back in minor). */
export function modalInterchange(chain: Link[], key: Key) {
  for (const l of chain) {
    if (l.locked || Math.random() < 0.4) continue;
    const r = mod12(l.chord.root - key.tonic), q = l.chord.quality;
    let c: Chord | null = null;
    if (!key.minor) {
      if (r === 5 && q === 'M') c = chord(l.chord.root, 'm');
      if (r === 9 && q === 'm') c = chord(key.tonic + 8, 'M');
      if (r === 4 && q === 'm') c = chord(key.tonic + 3, 'M');
      if (r === 2 && q === 'm') c = chord(l.chord.root, 'h7');
    } else {
      if (r === 5 && q === 'm') c = chord(l.chord.root, 'M');
      if (r === 0 && q === 'm') c = chord(l.chord.root, 'M');
    }
    if (c) l.chord = { ...c, roman: `${roman(c, key.tonic)} (borrowed)` };
  }
}
/** An authentic cadence: V(7) → I at the end, I at the start. */
export function cadence(chain: Link[], key: Key) {
  const n = chain.length;
  if (n < 3) return;
  if (!chain[0].locked) chain[0].chord = diatonic(key, 1);
  if (!chain[n - 2].locked) chain[n - 2].chord = diatonic(key, 5, true);
  if (!chain[n - 1].locked) chain[n - 1].chord = diatonic(key, 1);
}

// ── from chords to notes ────────────────────────────────────────────────────

/** Intervals above the root, with extensions chosen by chord function. */
export function intervals(c: Chord, key: Key, ext: number): number[] {
  const iv = [...new Set(c.pcs.map((p) => mod12(p - c.root)))].sort((a, b) => a - b);
  if (ext === 0 || c.pcs.length > 3) return ext === 0 ? iv.slice(0, 3) : iv;
  const minor = iv.includes(3) && !iv.includes(4), dim = iv.includes(6) && !iv.includes(7);
  const dominant = !minor && !dim && mod12(c.root - key.tonic) === 7;
  const out = [...iv, dim ? 10 : minor || dominant ? 10 : 11];
  if (ext >= 2 && !dim) out.push(14);
  if (ext >= 3) out.push(minor ? 17 : dominant ? 17 : 18); // 11 on minor and sus dominants, ♯11 on major
  if (ext >= 4 && !minor && !dim) out.push(21);
  return out;
}

/** Voice with the least total motion from the previous chord, then apply a voicing style. */
export function voice(root: number, iv: number[], prev: number[] | null, style: number, center = 60): number[] {
  const pcs = iv.map((i) => mod12(root + i));
  let best: number[] = [], cost = Infinity;
  for (let inv = 0; inv < pcs.length; inv++) {
    const rot = [...pcs.slice(inv), ...pcs.slice(0, inv)];
    for (const base of [center - 12, center - 7, center]) {
      const notes: number[] = [];
      let n = base + mod12(rot[0] - base);
      for (const pc of rot) {
        while (mod12(n) !== pc) n++;
        notes.push(n);
        n++;
      }
      const c = prev && prev.length ? notes.reduce((a, x, i) => a + Math.abs(x - prev[Math.min(i, prev.length - 1)]), 0) : Math.abs(notes[0] - (center - 5));
      if (c < cost) (cost = c), (best = notes);
    }
  }
  const v = [...best];
  if (VOICINGS[style] === 'drop 2' && v.length >= 4) v[v.length - 2] -= 12;
  if (VOICINGS[style] === 'open') for (let i = 1; i < v.length; i += 2) v[i] += 12;
  if (VOICINGS[style] === 'spread' && v.length > 2) (v[0] -= 12), (v[v.length - 1] += 12); // wide: bass down, top up an octave
  return v.sort((a, b) => a - b);
}

export interface NoteEvent {
  beat: number;
  dur: number;
  note: number;
  vel: number;
  part: 'chord' | 'bass';
}

/** Render the chain as notes: rhythm pattern, bass line, humanised timing and velocity. */
export function render(chain: Link[], key: Key, o: { beats: number; voicing: number; ext: number; pattern: number; bass: number; human: number }): { events: NoteEvent[]; voicings: number[][] } {
  const ev: NoteEvent[] = [];
  const voicings: number[][] = [];
  let prev: number[] | null = null;
  const jitter = () => (Math.random() - 0.5) * 0.06 * o.human;
  const vj = () => (Math.random() - 0.5) * 0.25 * o.human;
  const D = o.beats;
  chain.forEach((l, i) => {
    const c = l.chord;
    const v = voice(c.root, intervals(c, key, o.ext), prev, o.voicing);
    prev = v;
    voicings.push(v);
    const t0 = i * D;
    const push = (beat: number, dur: number, note: number, vel: number) => ev.push({ beat: Math.max(0, t0 + beat + jitter()), dur, note, vel: Math.min(1, Math.max(0.05, vel + vj())), part: 'chord' });
    switch (PATTERNS[o.pattern]) {
      case 'strum':
        v.forEach((n, k) => push(k * 0.04, D * 0.92, n, 0.72));
        break;
      case 'arp up':
      case 'arp down':
      case 'arp up-down': {
        const seq = PATTERNS[o.pattern] === 'arp up' ? v : PATTERNS[o.pattern] === 'arp down' ? [...v].reverse() : [...v, ...[...v].reverse().slice(1, -1)];
        for (let b = 0, k = 0; b < D - 1e-6; b += 0.5, k++) push(b, 0.45, seq[k % seq.length], 0.66);
        break;
      }
      case 'Alberti': {
        const lo = v[0], hi = v[v.length - 1], mid = v[Math.floor(v.length / 2)];
        const seq = [lo, hi, mid, hi];
        for (let b = 0, k = 0; b < D - 1e-6; b += 0.5, k++) push(b, 0.45, seq[k % 4], 0.62);
        break;
      }
      case 'comp':
        for (let bar = 0; bar < D; bar += 4) for (const b of [0, 1.5, 3]) if (bar + b < D) v.forEach((n) => push(bar + b, 0.4, n, b ? 0.6 : 0.75));
        break;
      default:
        v.forEach((n) => push(0, D * 0.95, n, 0.7));
    }
    // bass
    const r = 36 + c.root;
    const nextRoot = 36 + mod12(chain[(i + 1) % chain.length].chord.root);
    const bassPush = (beat: number, dur: number, note: number, vel = 0.8) => ev.push({ beat: t0 + beat, dur, note, vel, part: 'bass' });
    switch (BASS[o.bass]) {
      case 'roots':
        bassPush(0, D * 0.9, r);
        break;
      case 'root–fifth':
        bassPush(0, D / 2 - 0.05, r);
        bassPush(D / 2, D / 2 - 0.05, r + 7);
        break;
      case 'walking': {
        // quarter notes: root, two chord tones, then a chromatic approach into the next root
        const tones = [r, r + intervals(c, key, 0)[1], r + 7];
        for (let b = 0; b < D; b++) bassPush(b, 0.9, b === D - 1 && D > 1 ? nextRoot + (nextRoot > r ? -1 : 1) : tones[b % 3], b ? 0.7 : 0.85);
        break;
      }
      case 'tonic pedal':
        bassPush(0, D * 0.95, 36 + mod12(key.tonic));
        break;
    }
  });
  return { events: ev, voicings };
}
