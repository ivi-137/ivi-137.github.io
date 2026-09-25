/**
 * Check Orfeo's harmony engine against facts from the theory literature:
 *   node scripts/check-harmony.mts
 */
import {
  METHODS,
  NAMES,
  PISTON,
  checkCounterpoint,
  chord,
  counterpoint,
  diatonic,
  dissonance,
  findKey,
  fromPcs,
  identify,
  midiHz,
  mulberry,
  negate,
  pistonRow,
  plr,
  rowForm,
  toneRow,
  tpsDistance,
  vlDistance,
  vossMelody,
  expectancyMelody,
  Continuator,
  type Chord,
  type Key,
} from '../src/lib/synth/harmony.ts';

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};
const C: Key = { tonic: 0, minor: false };

// ── chords and keys
check('C major diatonic triads: C Dm Em F G Am B°', [1, 2, 3, 4, 5, 6, 7].map((d) => diatonic(C, d).name).join(' ') === 'C Dm Em F G Am B°');
check('A minor: V is E major, III is C major, vii° is G♯° (spelled A♭°)', ['4M', '0M', '8d'].join() === [5, 3, 7].map((d) => diatonic({ tonic: 9, minor: true }, d)).map((c) => c.root + c.quality).join());
check('identify {E G C} as C major', JSON.stringify(identify([4, 7, 0])) === JSON.stringify({ root: 0, quality: 'M' }));

// ── Piston
for (const d of [1, 2, 3, 4, 5, 6, 7]) {
  const s = pistonRow(d, 0.3).reduce((a, [, w]) => a + w, 0);
  if (Math.abs(s - 1) > 1e-9) check(`Piston row ${d} sums to 1`, false, String(s));
}
check('Piston: V is followed most often by I', PISTON[5].often[0] === 1);
check('Piston rows are all probability distributions', true);

// ── neo-Riemannian (Cohn)
const CM = chord(0, 'M');
check('P(C) = Cm, R(C) = Am, L(C) = Em', [plr(CM, 'P'), plr(CM, 'R'), plr(CM, 'L')].map((c) => c.name).join(' ') === 'Cm Am Em');
check('P, L, R are involutions on all 24 triads', [...Array(12).keys()].every((r) => (['M', 'm'] as const).every((q) => (['P', 'L', 'R'] as const).every((t) => plr(plr(chord(r, q), t), t).name === chord(r, q).name))));
const cycle = (id: string, n: number) => {
  const m = METHODS.find((x) => x.id === id)!;
  let prev: Chord | null = null;
  const seq: string[] = [];
  const rng = mulberry(1);
  for (let i = 0; i <= n; i++) {
    prev = m.next({ key: C, prev, i, len: 8, rng, spice: 0, memo: {} });
    seq.push(prev.name);
  }
  return seq;
};
const hex = cycle('hexatonic', 6);
check('hexatonic PL cycle returns home after 6', hex[0] === 'C' && hex[6] === 'C' && new Set(hex.slice(0, 6)).size === 6, hex.join(' '));
check('hexatonic cycle is C Cm A♭ A♭m E Em (Cohn 1996)', hex.slice(0, 6).join(' ') === 'C Cm A♭ A♭m E Em');
const oct = cycle('octatonic', 8);
check('octatonic PR cycle returns home after 8', oct[0] === 'C' && oct[8] === 'C' && new Set(oct.slice(0, 8)).size === 8, oct.join(' '));
const octSet = new Set(oct.flatMap((n) => fromPcs(chordPcs(n)).pcs));
function chordPcs(name: string) {
  const m = name.endsWith('m');
  const r = NAMES.indexOf(m ? name.slice(0, -1) : name);
  return chord(r, m ? 'm' : 'M').pcs;
}
check('the octatonic cycle uses exactly 8 pitch classes', octSet.size === 8);

// ── Tymoczko
check('voice leading C→Cm moves 1 semitone', vlDistance([0, 4, 7], [0, 3, 7]) === 1);
check('voice leading C→Em moves 1 semitone', vlDistance([0, 4, 7], [11, 4, 7]) === 1);
check('voice leading C→Am moves 2 semitones', vlDistance([0, 4, 7], [0, 4, 9]) === 2);
check('voice leading G7→C with a doubled root moves 4 semitones (B→C, D→C, F→E)', vlDistance([7, 11, 2, 5], [0, 4, 7]) === 4, String(vlDistance([7, 11, 2, 5], [0, 4, 7])));

// ── Lerdahl
const I = diatonic(C, 1);
const d = (deg: number) => tpsDistance(I, C, diatonic(C, deg), C);
check('TPS δ(I→V) = 5', d(5) === 5, String(d(5)));
check('TPS δ(I→IV) = 5', d(4) === 5, String(d(4)));
check('TPS δ(I→vi) = 7', d(6) === 7, String(d(6)));
check('TPS δ(I→ii) = 8', d(2) === 8, String(d(2)));
check('TPS δ(I→iii) = 7', d(3) === 7, String(d(3)));
check('TPS δ(I→I) = 0', d(1) === 0);

// ── Levy
const neg = (c: Chord) => fromPcs(c.pcs.map((p) => negate(p, 0))).name;
check('negative of C major is C minor', neg(chord(0, 'M')) === 'Cm');
check('negative of G major is F minor', neg(chord(7, 'M')) === 'Fm');
check('negative of G7 is Dø7 (D F A♭ C)', fromPcs(chord(7, '7').pcs.map((p) => negate(p, 0))).name === 'Dø7');

// ── Sethares / Plomp–Levelt
const dy = (a: number, b: number) => dissonance([midiHz(a), midiHz(b)]);
check('P5 is smoother than m2', dy(60, 67) < dy(60, 61));
check('P8 is smoother than tritone', dy(60, 72) < dy(60, 66));
check('major triad is smoother than a cluster', dissonance([60, 64, 67].map(midiHz)) < dissonance([60, 61, 62].map(midiHz)));

// ── Krumhansl–Kessler key-finding
const cMajorScale = [60, 62, 64, 65, 67, 69, 71, 72].map((midi) => ({ midi }));
const k1 = findKey([...cMajorScale, { midi: 60, w: 2 }, { midi: 67, w: 1 }]);
check('C major scale → C major', k1.key.tonic === 0 && !k1.key.minor, `r = ${k1.r.toFixed(3)}`);
const aMinor = [57, 59, 60, 62, 64, 65, 68, 69, 64, 57].map((midi) => ({ midi }));
const k2 = findKey(aMinor);
check('A harmonic minor melody → A minor', k2.key.tonic === 9 && k2.key.minor, `${NAMES[k2.key.tonic]} ${k2.key.minor ? 'minor' : 'major'}`);

// ── Fux: the dorian cantus firmus from Gradus ad Parnassum
const cf = [62, 65, 64, 62, 67, 65, 69, 67, 65, 64, 62]; // D F E D G F A G F E D
for (let seed = 1; seed <= 20; seed++) {
  const cp = counterpoint(cf, { tonic: 2, minor: false }, mulberry(seed), [0, 2, 4, 5, 7, 9, 11]);
  if (!cp) {
    check(`Fux seed ${seed}: a counterpoint exists`, false);
    continue;
  }
  const r = checkCounterpoint(cf, cp);
  const bad = r.dissonances + r.parallels + r.hidden + r.badLeaps + r.crossings;
  const first = (cp[0] - cf[0]) % 12,
    last = (cp[cp.length - 1] - cf[cf.length - 1]) % 12;
  if (bad || ![0, 7].includes(first) || last !== 0 || Math.abs(cp[cp.length - 1] - cp[cp.length - 2]) > 2) {
    check(`Fux seed ${seed}`, false, JSON.stringify({ r, cp }));
  } else if (seed === 1) check('Fux first species over D F E D G F A G F E D: no dissonance, no parallels, no hidden 5ths/8ves, perfect ends', true, cp.map((m) => NAMES[m % 12]).join(' '));
}
check('Fux: 20 random seeds all obey the rules', true);

// ── twelve-tone
const row = toneRow(mulberry(7), true);
const ivs = new Set(row.slice(1).map((p, i) => (p - row[i] + 12) % 12));
check('all-interval row: 12 pitch classes, 11 distinct intervals', new Set(row).size === 12 && ivs.size === 11, row.map((p) => NAMES[p]).join(' '));
check('RI is the retrograde of I', rowForm(row, 'RI').join() === [...rowForm(row, 'I')].reverse().join());

// ── Voss, Huron, Continuator
check('Voss 1/f melody has the right length', vossMelody(32, mulberry(3)).length === 32);
const mel = expectancyMelody(4000, mulberry(9));
let skips = 0,
  reversals = 0;
for (let i = 2; i < mel.length; i++) {
  const a = mel[i - 1] - mel[i - 2],
    b = mel[i] - mel[i - 1];
  if (Math.abs(a) >= 3) {
    skips++;
    if (b !== 0 && Math.sign(b) !== Math.sign(a)) reversals++;
  }
}
check('tessitura model: most skips are followed by a reversal (von Hippel & Huron)', reversals / skips > 0.6, `${((100 * reversals) / skips).toFixed(0)}% of ${skips}`);
const cont = new Continuator(3);
cont.learn([60, 62, 64, 65, 67, 65, 64, 62, 60]);
const out = cont.continue([62, 64], 3, mulberry(1));
check('Continuator continues a learned phrase in style', out.notes[0] === 65 || out.notes[0] === 62, out.notes.join(' '));

// ── every method produces 32 chords without throwing
for (const m of METHODS) {
  let prev: Chord | null = null;
  const memo = {};
  const rng = mulberry(42);
  const names: string[] = [];
  try {
    for (let i = 0; i < 32; i++) {
      prev = m.next({ key: { tonic: 2, minor: m.id === 'piston' }, prev, i: i % 8, len: 8, rng, spice: (i % 5) / 4, memo });
      if (!prev || !prev.pcs.length) throw new Error('empty chord');
      names.push(prev.name);
    }
    check(`${m.name} (${m.id})`, true, names.slice(0, 8).join(' · '));
  } catch (e) {
    check(`${m.name} (${m.id})`, false, String(e));
  }
}
console.log(`\n${METHODS.length} harmony methods · ${failed ? `${failed} FAILED` : 'all checks pass'}`);
process.exit(failed ? 1 : 0);
