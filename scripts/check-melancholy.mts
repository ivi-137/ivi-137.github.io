/**
 * Check Melencolia's sad harmony against its sources:
 *   node scripts/check-melancholy.mts
 */
import { DURER, DURER_LINES, Melancholy, SAD_METHODS, VOCAB, intrinsic, sadInterval, sadnessIndex, type SadMethod } from '../src/lib/vocoder/melancholy.ts';
import { encodeWav } from '../src/lib/audio/wav.ts';

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

// ── Dürer, Melencolia I
check('Dürer: every row, column and diagonal sums to 34', DURER_LINES.every((l) => sum(l.map((c) => DURER[c])) === 34));
check('Dürer: the four quadrants and the centre sum to 34', [[0, 1, 4, 5], [2, 3, 6, 7], [8, 9, 12, 13], [10, 11, 14, 15], [5, 6, 9, 10]].every((q) => sum(q.map((c) => DURER[c])) === 34));
check('Dürer: the bottom row dates the engraving, 15 14', DURER[13] === 15 && DURER[14] === 14);
check('Dürer: 1..16 each once', [...DURER].sort((a, b) => a - b).join() === [...Array(16).keys()].map((i) => i + 1).join());

// the magic-square sequencer: every line carries the same total sadness rank
const m = new Melancholy(3);
const pool = m.ranked();
check('16 chords in the ranked pool, least sad first', pool.length === 16 && pool.every((d, i) => i === 0 || intrinsic(pool[i - 1]) <= intrinsic(d)));
m.method = 'durer';
const ranks: number[][] = [];
for (let line = 0; line < 10; line++) {
  const r: number[] = [];
  for (let k = 0; k < 4; k++) r.push(DURER[m.next().cell!]);
  ranks.push(r);
}
check('Dürer sequencer: each four-chord line has total rank 34', ranks.every((r) => sum(r) === 34), ranks.map((r) => r.join('+')).slice(0, 3).join(' | '));

// ── laments (Rosand 1979)
for (const method of ['lament', 'chromatic'] as SadMethod[]) {
  const mm = new Melancholy(7);
  mm.method = method;
  mm.tonic = 9; // A minor
  const phrase = Array.from({ length: method === 'lament' ? 4 : 6 }, () => mm.next());
  const bass = phrase.map((c) => c.notes[0]);
  const steps = bass.slice(1).map((b, i) => bass[i] - b);
  const ok = method === 'lament' ? steps.every((s) => s === 1 || s === 2) && bass[0] - bass[3] === 5 : steps.every((s) => s === 1);
  check(`${method}: the bass falls by ${method === 'lament' ? 'step through a fourth' : 'semitones'} from the tonic to the dominant`, ok, `${phrase.map((c) => c.name).join(' → ')}  bass ${bass.join(' ')}`);
  check(`${method}: it ends on the dominant`, phrase[phrase.length - 1].roman.startsWith('V'));
}

// ── the saddest path vs. a random walk
const avg = (method: SadMethod | 'random') => {
  const mm = new Melancholy(11);
  let minor = 0,
    motion = 0,
    n = 0;
  let prev: number[] | null = null;
  for (let i = 0; i < 64; i++) {
    if (method === 'random') mm.method = (['lament', 'mixture', 'durer'] as SadMethod[])[i % 3];
    else mm.method = method;
    const c = mm.next();
    if ([3].some((iv) => c.pcs.includes((c.root + iv) % 12)) && !c.pcs.includes((c.root + 4) % 12)) minor++;
    const up = c.notes.slice(1);
    if (prev) motion += up.reduce((s, x) => s + Math.min(...prev!.map((p) => Math.abs(p - x))), 0) / up.length;
    prev = up;
    n++;
  }
  return { minor: minor / n, motion: motion / (n - 1) };
};
const path = avg('path');
check('saddest path: mostly minor-third chords', path.minor > 0.6, `${Math.round(path.minor * 100)}% minor`);
check('saddest path: small voice leading (under 2.5 semitones per voice)', path.motion < 2.5, `${path.motion.toFixed(2)} st/voice`);

// ── appoggiaturas resolve down by step (Sloboda 1991)
const mt = new Melancholy(5);
mt.tears = 1;
let apps = 0,
  good = 0;
for (let i = 0; i < 40; i++) {
  const c = mt.next();
  if (c.app === null) continue;
  apps++;
  const d = c.app - c.notes[c.notes.length - 1];
  if (d === 1 || d === 2) good++;
}
check('appoggiaturas lean one or two semitones above the top voice', apps === 40 && good === 40, `${good}/${apps}`);

// ── mixture (Capuzzo 2004): the minor subdominant inside a major frame
const mx = new Melancholy(1);
mx.method = 'mixture';
const romans = new Set<string>();
for (let i = 0; i < 80; i++) romans.add(mx.next().roman);
check('mixture uses the minor iv next to borrowed major chords', romans.has('iv') && romans.has('I') && romans.has('III♮'), [...romans].join(' '));

// ── intervals of sad speech
check('a minor third is flagged sad (Curtis & Bharucha 2010)', sadInterval(220, 220 * 2 ** (3 / 12)).sad && sadInterval(220, 220 * 2 ** (-3 / 12)).name === 'terza minore');
check('a minor second is flagged sad (Zeloni & Pavani 2022)', sadInterval(440, 466.16).sad);
check('a perfect fifth is not', !sadInterval(220, 330).sad);

// ── the index
const hi = sadnessIndex({ minorShare: 1, bpm: 56, register: -1, darkness: 0.9, motion: 1, level: 0.2, attack: 0.8, bend: 0.6 });
const lo = sadnessIndex({ minorShare: 0, bpm: 140, register: 1, darkness: 0.1, motion: 7, level: 0.9, attack: 0.1, bend: 0 });
check('index weights sum to 1, mode and tempo weigh most (Eerola et al. 2013)', Math.abs(sum(hi.cues.map((c) => c.w)) - 1) < 1e-9 && hi.cues[0].w >= Math.max(...hi.cues.slice(2).map((c) => c.w)) && hi.cues[1].w >= Math.max(...hi.cues.slice(2).map((c) => c.w)));
check('a slow minor dark patch scores sadder than a fast bright major one', hi.total > 0.8 && lo.total < 0.2, `${hi.total.toFixed(2)} vs ${lo.total.toFixed(2)}`);

// ── every method runs
for (const { id } of SAD_METHODS) {
  const mm = new Melancholy(42);
  mm.method = id;
  try {
    const names = Array.from({ length: 12 }, () => mm.next().name);
    check(`method ${id}`, names.every(Boolean), names.slice(0, 6).join(' · '));
  } catch (e) {
    check(`method ${id}`, false, String(e));
  }
}
check('vocabulary: 20 chords', VOCAB.length === 20);

// ── WAV encoding
const tone = new Float32Array(4410).map((_, i) => Math.sin((i / 44100) * 2 * Math.PI * 440) * 0.5);
const blob = encodeWav([tone, tone], 44100, 16, { title: 'test', software: 'gpojani.me' });
const buf = new DataView(await blob.arrayBuffer());
const tag = (o: number) => String.fromCharCode(...new Uint8Array(buf.buffer, o, 4));
const listSize = buf.getUint32(40, true);
check('WAV: RIFF/WAVE/fmt/LIST/data in order, sizes consistent', tag(0) === 'RIFF' && tag(8) === 'WAVE' && tag(12) === 'fmt ' && tag(36) === 'LIST' && tag(44 + listSize) === 'data' && buf.getUint32(4, true) === buf.byteLength - 8);
const dataOff = 44 + listSize + 8;
check('WAV: 16-bit stereo samples round-trip', Math.abs(buf.getInt16(dataOff + 4 * 25, true) / 32767 - tone[25]) < 0.001 && buf.getUint16(22, true) === 2 && buf.getUint32(24, true) === 44100);
const b24 = new DataView(await encodeWav([tone], 48000, 24).arrayBuffer());
check('WAV: 24-bit mono header', b24.getUint16(34, true) === 24 && b24.getUint16(22, true) === 1 && b24.byteLength === 44 + tone.length * 3);

console.log(`\n${failed ? `${failed} FAILED` : 'all checks pass'}`);
process.exit(failed ? 1 : 0);
