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
import { SHAPES, chord, diatonic, dissonance, midiHz, mod12, pistonRow, plr, roman, tpsDistance, vlDistance, type Chord, type Key, type Quality } from '../synth/harmony';

export const MODELS = ['all theories', 'Piston: functional', 'Cohn: neo-Riemannian', 'Tymoczko: voice leading', 'Lerdahl: tonal pitch space', 'combinatorial: all 180 chords'] as const;
export type Q = Exclude<Quality, 'q' | 'x'>;
/** Every chord quality the machine knows: 12 roots × 15 = 180 chords. */
export const QUALITIES = Object.keys(SHAPES) as Q[];
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
  return (f > 6 ? f - 12 : f) - (['m', 'm7', 'm6', 'd', 'h7', 'd7'].includes(c.quality) ? 3 : 0);
};

/** Where a chord sits on the dial the swarm flies over: angle = circle of fifths, radius = mode. */
export function anchorOf(c: Chord): [number, number] {
  const a = (mod12(c.root * 7) / 12) * Math.PI * 2 - Math.PI / 2;
  const r = ['m', 'm7', 'm6'].includes(c.quality) ? 0.6 : ['d', 'h7', 'd7'].includes(c.quality) ? 0.4 : 0.9;
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
  // the combinatorial space: every root × every quality, weighted by voice-leading distance alone
  if (model === 5)
    for (let r = 0; r < 12; r++)
      for (const q of QUALITIES) {
        const c = chord(r, q);
        add(c, 3 * Math.exp(-vlDistance(prev.pcs, c.pcs) / 2.5) + 0.05);
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
  mood?: (c: Chord) => number;
}

const dcache = new Map<string, number>();
const diss = (c: Chord) => {
  let d = dcache.get(c.name);
  if (d === undefined) dcache.set(c.name, (d = dissonance(c.pcs.map((pc) => midiHz(48 + c.pcs[0] + mod12(pc - c.pcs[0]))))));
  return d;
};
let dspan: [number, number] | null = null;
/** Sensory dissonance (Plomp–Levelt, Sethares) scaled to [0,1] across all 180 chords. */
export const tension = (c: Chord) => {
  if (!dspan) {
    const ds = [...Array(12).keys()].flatMap((r) => QUALITIES.map((q) => diss(chord(r, q))));
    dspan = [Math.min(...ds), Math.max(...ds)];
  }
  return Math.max(0, Math.min(1, (diss(c) - dspan[0]) / (dspan[1] - dspan[0])));
};

export function choose(prev: Chord, o: ChooseOpts): { chord: Chord; tension: number } {
  const cands = candidates(o.model, prev, o.key, o.spice);
  if (!cands.length) return { chord: diatonic(o.key, 1), tension: 0 };
  const d = cands.map(([c]) => diss(c));
  const lo = Math.min(...d), hi = Math.max(...d);
  const scale = (o.key.minor ? [0, 2, 3, 5, 7, 8, 10, 11] : [0, 2, 4, 5, 7, 9, 11]).map((i) => mod12(o.key.tonic + i));
  const scored = cands.map(([c, w], i) => {
    const dn = hi > lo ? (d[i] - lo) / (hi - lo) : 0.5;
    const fit = Math.exp(-((dn - o.target) ** 2) / (2 * 0.18 ** 2));
    const outside = c.pcs.filter((p) => !scale.includes(p)).length;
    const wt = w * (1 - o.tensionAmt + o.tensionAmt * fit) * (1 + o.influence * 4 * o.bias(c)) * Math.exp(-o.gravity * 2.5 * outside) * (o.mood ? o.mood(c) : 1);
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
export const withRoman = (c: Chord, k: Key): Chord => ({ ...c, roman: roman(c, k.tonic) });

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
  const sh = SHAPES[c.quality as Q];
  // sus, add9, sixths, °7 and 7♭9 are colours in themselves: play them as written
  if (sh && !['M', 'm', 'd', 'A', 'M7', '7', 'm7', 'h7'].includes(c.quality)) return [...sh];
  const iv = [...new Set(c.pcs.map((p) => mod12(p - c.root)))].sort((a, b) => a - b);
  if (!sh) return ext === 0 ? iv.slice(0, 3) : iv;
  if (ext === 0 && c.pcs.length <= 3) return iv;
  const minor = iv.includes(3) && !iv.includes(4), dim = iv.includes(6) && !iv.includes(7);
  const dominant = c.quality === '7' || (!minor && !dim && mod12(c.root - key.tonic) === 7);
  const out = [...iv.slice(0, 3), c.pcs.length > 3 ? iv[3] : dim ? 10 : minor || dominant ? 10 : 11];
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

// ── moods ───────────────────────────────────────────────────────────────────
/**
 * Each mood is a point on Russell's circumplex of affect (valence × arousal,
 * 1980), realised through the cues listeners use to hear emotion in music
 * (Juslin & Laukka, Psychological Bulletin 129, 2003): mode, tempo, dissonance,
 * register and articulation. Valence sets the preferred brightness on the
 * circle of fifths and major vs minor (Hevner 1935); arousal sets tempo,
 * rhythmic density and tension.
 */
export interface Mood {
  name: string;
  valence: number;
  arousal: number;
  note: string;
  bright: number; // preferred place on the circle of fifths, −6 … +6
  quality: Record<string, number>; // weight multipliers by chord quality
  set: Record<string, number>; // panel settings
  after?: Array<'borrow' | 'secdom' | 'tritone'>;
}
const S = (bpm: number, minor: number, model: number, curve: number, tensionAmt: number, gravity: number, spice: number, ext: number, voicing: number, pattern: number, bass: number, beats = 2) =>
  ({ bpm, minor, model, curve, tensionAmt, gravity, spice, ext, voicing, pattern, bass, beats });
export const MOODS: Mood[] = [
  { name: 'joyful', valence: 0.9, arousal: 0.6, note: 'Bright major triads, functional motion, syncopated comping.', bright: 2, quality: { M: 1.7, m: 0.7, d: 0.3 }, set: S(124, 0, 1, 1, 0.4, 0.85, 0.15, 0, 0, 6, 2) },
  { name: 'euphoric', valence: 1, arousal: 1, note: 'Fast, open and rising, with secondary dominants pushing forward.', bright: 3, quality: { M: 1.8, m: 0.8 }, set: S(138, 0, 0, 2, 0.5, 0.7, 0.35, 2, 3, 2, 2), after: ['secdom'] },
  { name: 'heroic', valence: 0.6, arousal: 0.8, note: 'Major chords in block, tension rising toward the end.', bright: 1, quality: { M: 2, m: 0.6 }, set: S(112, 0, 0, 2, 0.5, 0.65, 0.3, 0, 0, 0, 1) },
  { name: 'epic', valence: 0.2, arousal: 0.9, note: 'Minor key, but the ♭VI and ♭VII major chords carry it (the Aeolian cadence).', bright: 0, quality: { M: 1.5, m: 1 }, set: S(100, 1, 0, 4, 0.55, 0.7, 0.3, 0, 2, 0, 1) },
  { name: 'romantic', valence: 0.3, arousal: 0.1, note: 'Ninths, open voicing, Alberti figuration and secondary dominants.', bright: 0, quality: { M: 1.1, m: 1.1 }, set: S(76, 0, 1, 4, 0.5, 0.7, 0.3, 2, 2, 5, 2), after: ['secdom'] },
  { name: 'serene', valence: 0.6, arousal: -0.6, note: 'Slow, consonant sevenths in open position, rocking arpeggio.', bright: 1, quality: { M: 1.3 }, set: S(70, 0, 1, 0, 0.3, 0.9, 0.1, 1, 2, 4, 1, 3) },
  { name: 'dreamy', valence: 0.4, arousal: -0.4, note: 'Voice-leading drift, ♯11 colours, a pedal underneath.', bright: 3, quality: { M: 1.4 }, set: S(80, 0, 3, 0, 0.35, 0.45, 0.4, 3, 3, 2, 4) },
  { name: 'ethereal', valence: 0.2, arousal: -0.8, note: 'Thirteenth chords spread wide, very slow, no bass.', bright: 2, quality: { M: 1.2 }, set: S(60, 0, 3, 0, 0.3, 0.5, 0.35, 4, 3, 0, 0, 3) },
  { name: 'nostalgic', valence: 0.1, arousal: -0.3, note: 'Major, with chords borrowed from the parallel minor (iv, ♭VI).', bright: 0, quality: { M: 1.1, m: 1 }, set: S(88, 0, 0, 4, 0.45, 0.7, 0.3, 1, 1, 1, 1), after: ['borrow'] },
  { name: 'melancholic', valence: -0.6, arousal: -0.5, note: 'Minor, falling arpeggios, a golden-section climax.', bright: -2, quality: { m: 1.7, M: 0.8 }, set: S(68, 1, 1, 4, 0.5, 0.8, 0.2, 1, 0, 3, 1) },
  { name: 'mysterious', valence: -0.2, arousal: -0.1, note: 'Chromatic mediants from P, L and R; augmented colours; pedal bass.', bright: -1, quality: { m: 1.2, A: 1.6 }, set: S(84, 1, 2, 0, 0.5, 0.3, 0.6, 2, 3, 2, 4) },
  { name: 'tense', valence: -0.6, arousal: 0.7, note: 'Rising dissonance, diminished and dominant chords, tritone substitutions.', bright: -3, quality: { d: 2, '7': 1.6, m: 1.1 }, set: S(128, 1, 3, 2, 0.85, 0.25, 0.7, 3, 1, 6, 3), after: ['tritone'] },
  { name: 'dark', valence: -0.9, arousal: 0.2, note: 'Flat side of the circle, minor and diminished, a pedal in the bass.', bright: -4, quality: { m: 1.8, d: 1.4, M: 0.6 }, set: S(96, 1, 2, 2, 0.7, 0.4, 0.4, 0, 0, 0, 4) },
];

/** A mood's pull on a chord: closeness to its preferred brightness × its quality weights. */
export const moodBias = (m: Mood, key: Key) => (c: Chord) => Math.exp(-((brightness(c, key) - m.bright) ** 2) / (2 * 3 ** 2)) * (m.quality[c.quality] ?? 1);

// ── genres: vocabularies, root motions and idioms ─────────────────────────────
export interface Genre {
  name: string;
  note: string;
  roots: Record<number, number>; // weight by semitones above the tonic (absent: 0.25)
  quality: Partial<Record<Q, number>>; // weight by chord quality (absent: 0.03)
  moves?: Record<number, number>; // root motion in semitones upward → multiplier
  idiom: Array<[number, Q]>; // the genre's signature loop, in semitones above the tonic
  cadence: boolean;
  set: Record<string, number>;
}
export const GENRES: Genre[] = [
  { name: 'pop', note: 'The four-chord axis and its rotations; roots move by fourths and fifths (Burgoyne et al., McGill Billboard corpus, 2011).', roots: { 0: 3, 5: 2.5, 7: 3, 9: 2.5, 2: 1, 4: 0.8 }, quality: { M: 1.6, m: 1.3, sus2: 0.5, sus4: 0.5, add9: 0.6 }, moves: { 5: 1.4, 7: 1.3, 3: 1.1, 9: 1.1 }, idiom: [[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']], cadence: false, set: S(110, 0, 5, 1, 0.35, 0.85, 0.2, 0, 0, 1, 1) },
  { name: 'rock', note: 'Mixolydian ♭VII and the double plagal I–♭VII–IV (de Clercq and Temperley, Popular Music 30/1, 2011).', roots: { 0: 3, 5: 2.5, 7: 1.8, 10: 2, 3: 1, 8: 1, 9: 1, 2: 0.5 }, quality: { M: 2, m: 0.8, sus4: 0.7, sus2: 0.5 }, moves: { 5: 1.6, 7: 1.2, 10: 1.2, 2: 1.1 }, idiom: [[0, 'M'], [10, 'M'], [5, 'M'], [0, 'M']], cadence: false, set: S(120, 0, 5, 2, 0.4, 0.6, 0.35, 0, 2, 1, 2) },
  { name: 'blues', note: 'Twelve bars of dominant sevenths on I, IV and V.', roots: { 0: 3, 5: 2.5, 7: 2, 6: 0.4 }, quality: { '7': 3, '6': 0.8, d7: 0.5 }, moves: { 5: 1.5, 7: 1.5 }, idiom: [[0, '7'], [0, '7'], [0, '7'], [0, '7'], [5, '7'], [5, '7'], [0, '7'], [0, '7'], [7, '7'], [5, '7'], [0, '7'], [7, '7']], cadence: false, set: { ...S(96, 0, 5, 0, 0.3, 0.5, 0.2, 1, 0, 6, 3), len: 1 } },
  { name: 'jazz', note: 'ii–V–I chains, falling fifths and tritone substitutes (Steedman, Music Perception 2/1, 1984; Rohrmeier 2011).', roots: { 0: 2.5, 2: 2.5, 7: 2.5, 9: 2, 4: 1.2, 5: 1.2, 1: 0.8, 6: 0.6, 10: 0.6, 3: 0.5, 8: 0.5, 11: 0.4 }, quality: { m7: 2.5, '7': 2.5, M7: 2.5, h7: 1.2, d7: 0.8, '7b9': 1, '6': 1, m6: 0.6 }, moves: { 5: 3, 11: 1.6, 0: 0.3 }, idiom: [[2, 'm7'], [7, '7'], [0, 'M7'], [9, '7']], cadence: true, set: S(140, 0, 5, 1, 0.5, 0.45, 0.45, 2, 1, 6, 3) },
  { name: 'bossa nova', note: 'Major sevenths, chromatic descents and ♭II7, after Jobim.', roots: { 0: 2.5, 2: 2, 1: 1.2, 7: 1.5, 9: 1.2, 5: 1.5 }, quality: { M7: 2.5, '7': 2, m7: 2, '6': 1.5, m6: 1, '7b9': 1, h7: 0.8 }, moves: { 5: 2, 11: 2 }, idiom: [[0, 'M7'], [2, '7'], [2, 'm7'], [1, '7']], cadence: true, set: S(128, 0, 5, 0, 0.45, 0.5, 0.35, 2, 1, 6, 2) },
  { name: 'gospel', note: 'I–I7–IV with a passing ♯iv°7, then vi–ii–V: the church turnaround.', roots: { 0: 3, 5: 2.5, 6: 1.2, 9: 1.5, 2: 1.5, 7: 1.5, 4: 1 }, quality: { M: 1, '7': 2, d7: 1.5, m7: 1.5, M7: 1, add9: 1, '6': 1 }, moves: { 5: 2, 1: 1.4 }, idiom: [[0, 'M'], [0, '7'], [5, 'M'], [6, 'd7'], [0, 'M'], [9, 'm7'], [2, 'm7'], [7, '7']], cadence: true, set: S(76, 0, 5, 4, 0.5, 0.6, 0.35, 2, 2, 1, 1) },
  { name: 'neo-soul', note: 'IVmaj7–III7–vi7, the “Just the Two of Us” descent, in ninths and elevenths.', roots: { 5: 2.5, 4: 2, 9: 2, 2: 2, 0: 2, 7: 1, 3: 0.8, 10: 0.8 }, quality: { M7: 2.5, m7: 2.5, '7': 1.5, add9: 1, '6': 1 }, moves: { 5: 1.6, 11: 1.4, 10: 1.4 }, idiom: [[5, 'M7'], [4, '7'], [9, 'm7'], [7, 'm7'], [0, '7']], cadence: false, set: S(84, 0, 5, 0, 0.45, 0.45, 0.45, 3, 1, 6, 1) },
  { name: 'city pop', note: 'The J-pop royal road IVmaj7–V7–iii7–vi.', roots: { 5: 2.5, 7: 2.5, 4: 2, 9: 2.5, 0: 1.5, 2: 1.2 }, quality: { M7: 2, '7': 1.6, m7: 2, m: 1.2, add9: 0.8 }, moves: { 2: 1.5, 9: 1.4, 5: 1.4 }, idiom: [[5, 'M7'], [7, '7'], [4, 'm7'], [9, 'm']], cadence: false, set: S(116, 0, 5, 1, 0.4, 0.65, 0.3, 2, 1, 6, 2) },
  { name: 'funk', note: 'One-chord dominant-ninth vamps, a move to IV7 and back.', roots: { 0: 3, 5: 2, 10: 1.2, 7: 1 }, quality: { '7': 3, m7: 2, '6': 0.6 }, moves: { 5: 1.4, 7: 1.4 }, idiom: [[0, '7'], [0, '7'], [5, '7'], [0, '7']], cadence: false, set: S(104, 0, 5, 0, 0.3, 0.5, 0.25, 2, 1, 6, 2) },
  { name: 'lo-fi hip hop', note: 'Looped major and minor sevenths, soft and falling by step.', roots: { 5: 2.5, 4: 2, 2: 2.5, 0: 2, 9: 2, 7: 1.4 }, quality: { M7: 2.5, m7: 2.5, '7': 1, add9: 1 }, moves: { 5: 1.8, 11: 1.2, 10: 1.3 }, idiom: [[5, 'M7'], [4, 'm7'], [2, 'm7'], [0, 'M7']], cadence: false, set: S(78, 0, 5, 0, 0.35, 0.55, 0.3, 2, 1, 3, 1) },
  { name: 'trance', note: 'Minor i–♭VI–♭III–♭VII, open voicings, rising.', roots: { 0: 3, 8: 2.5, 3: 2.5, 10: 2.5, 5: 1.2, 7: 0.8 }, quality: { m: 2, M: 2, sus2: 0.8, sus4: 0.6, add9: 0.6 }, idiom: [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']], cadence: false, set: S(138, 1, 5, 2, 0.45, 0.8, 0.2, 0, 3, 2, 1) },
  { name: 'flamenco', note: 'The Andalusian cadence i–♭VII–♭VI–V, ending on the Phrygian dominant (Manuel, JAMS 55/2, 2002).', roots: { 0: 2.5, 10: 2.5, 8: 2.5, 7: 3, 1: 1 }, quality: { M: 2, m: 1.5, '7b9': 1, '7': 1 }, moves: { 10: 2, 11: 1.8 }, idiom: [[0, 'm'], [10, 'M'], [8, 'M'], [7, 'M']], cadence: false, set: S(112, 1, 5, 3, 0.4, 0.6, 0.3, 0, 0, 1, 1) },
  { name: 'tango', note: 'Harmonic minor: iv6 and V7♭9 returning to i.', roots: { 0: 3, 5: 2, 7: 2.5, 8: 1.2, 2: 0.8, 10: 0.8 }, quality: { m: 2, '7': 1.5, '7b9': 1.5, d7: 1, m6: 1, M: 1 }, moves: { 5: 1.6, 7: 1.4 }, idiom: [[0, 'm'], [5, 'm6'], [7, '7b9'], [0, 'm']], cadence: true, set: S(116, 1, 5, 4, 0.5, 0.75, 0.25, 1, 0, 0, 2) },
  { name: 'baroque', note: 'Falling-fifth sequences and the Pachelbel ground.', roots: { 0: 3, 2: 1.2, 4: 1, 5: 2, 7: 2.5, 9: 1.5, 11: 0.6 }, quality: { M: 1.5, m: 1.3, d: 0.6, '7': 0.8 }, moves: { 5: 2.5 }, idiom: [[0, 'M'], [7, 'M'], [9, 'm'], [4, 'm'], [5, 'M'], [0, 'M'], [5, 'M'], [7, 'M']], cadence: true, set: S(96, 0, 1, 1, 0.4, 0.9, 0.1, 0, 0, 5, 1) },
  { name: 'film score', note: 'Chromatic mediants: major chords a third apart, the sound of wonder (Lehman, Hollywood Harmony, 2018).', roots: { 0: 3, 8: 2, 4: 2, 3: 1.6, 9: 1.5, 1: 0.8, 5: 1 }, quality: { M: 2, m: 1.2, A: 0.6, sus4: 0.5, add9: 0.6 }, moves: { 8: 1.8, 4: 1.8, 3: 1.4, 9: 1.4 }, idiom: [[0, 'M'], [8, 'M'], [4, 'M'], [0, 'M']], cadence: false, set: S(72, 0, 2, 4, 0.5, 0.3, 0.55, 1, 3, 4, 1, 3) },
  { name: 'ambient', note: 'Suspended and added-ninth chords over a pedal, very slow.', roots: { 0: 2.5, 5: 2.5, 9: 2, 7: 1.5, 2: 1.5, 4: 1 }, quality: { add9: 2, sus2: 2, M7: 2, m7: 1.5, sus4: 1.2, '6': 1 }, idiom: [[0, 'add9'], [5, 'sus2'], [9, 'm7'], [5, 'M7']], cadence: false, set: S(64, 0, 5, 0, 0.3, 0.5, 0.35, 2, 3, 4, 4, 3) },
  { name: 'metal', note: 'Phrygian ♭II, the tritone, minor and diminished.', roots: { 0: 3, 1: 2, 8: 2, 10: 1.8, 6: 1.2, 3: 1, 5: 1 }, quality: { m: 2, M: 1.5, d: 1, sus2: 0.8, sus4: 0.8 }, moves: { 1: 2, 11: 1.5, 6: 1.2 }, idiom: [[0, 'm'], [1, 'M'], [0, 'm'], [6, 'd']], cadence: false, set: S(150, 1, 5, 2, 0.6, 0.55, 0.4, 0, 0, 0, 1, 1) },
];
/** A genre's pull on a move prev → c: its vocabulary, its scale degrees, its favourite root motions. */
export const genreBias = (g: Genre, key: Key) => (prev: Chord, c: Chord) =>
  (g.roots[mod12(c.root - key.tonic)] ?? 0.25) * (g.quality[c.quality as Q] ?? 0.03) * (g.moves?.[mod12(c.root - prev.root)] ?? 1);
export const idiomChord = (g: Genre, i: number, key: Key): Chord => {
  const [off, q] = g.idiom[i % g.idiom.length];
  return withRoman(chord(key.tonic + off, q), key);
};
