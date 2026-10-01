/**
 * Check GUZEN's engine against what it claims to do:
 *   node --import ./scripts/ts-resolve.mjs scripts/check-guzen.mts
 *
 * The engine is plain TypeScript, so everything here runs under Node with no audio device. The post
 * "GUZEN: the dice are a 48-bit number" makes claims about the generator, the folder and the gate, and this
 * script is where they are tested against the code that actually runs in the page.
 */
import { Clock, ComplexOscillator, GATE_BOTH, GATE_VCF, Guzen, Lcg48, LowpassGate, Quantizer, Reverb, Uncertainty, softLimit, triFold } from '../src/lib/guzen/dsp.ts';
import { AGENT0, AGENT_STRIDE, GEN_MULT, LEAF, NUM_AGENTS, PARAMS, PIDX, QUARTERS, SCALE_DEGREES, fromNorm, parseSeed, seedHex, toNorm } from '../src/lib/guzen/params.ts';
import { CATEGORIES, PRESETS, presetRaw, presetValues } from '../src/lib/guzen/presets.ts';

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const SR = 48000;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const rms = (x: ArrayLike<number>) => Math.sqrt(Array.from(x).reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

/** Magnitude of one frequency in a signal, by the Goertzel recurrence. */
function goertzel(x: ArrayLike<number>, f: number, sr = SR) {
  const w = (2 * Math.PI * f) / sr;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (2 * Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2)) / x.length;
}

/** Render a patch the way the worklet does: 128-sample blocks into Float32 buffers. */
function render(p: Float64Array, seed: number, seconds: number, sr = SR, block = 128) {
  const g = new Guzen(sr, Float64Array.from(p), seed);
  const n = Math.round(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i);
    g.process(bl, br, m);
    L.set(bl.subarray(0, m), i);
    R.set(br.subarray(0, m), i);
  }
  return { L, R, g };
}

// ── the parameter table ────────────────────────────────────────────────────────
check('parameters: unique ids', new Set(PARAMS.map((p) => p.id)).size === PARAMS.length, `${PARAMS.length} parameters`);
check('parameters: 14 global + 6 generator + 6 agents × 22', PARAMS.length === 14 + 6 + NUM_AGENTS * AGENT_STRIDE);
check('parameters: every default inside its range', PARAMS.every((p) => p.def >= p.min && p.def <= p.max));
check('parameters: a choice has one option per value', PARAMS.filter((p) => p.kind === 'choice').every((p) => p.options!.length === p.max + 1));
check('parameters: agent leaves sit where LEAF says', PARAMS[AGENT0 + 2 * AGENT_STRIDE + LEAF.fold].id === 'a2.fold');
{
  let ok = true;
  for (const p of PARAMS.filter((q) => q.kind === 'float')) for (const n of [0, 0.1, 0.37, 0.5, 0.9, 1]) ok &&= near(toNorm(p, fromNorm(p, n)), n, 1e-9);
  check('knob space: toNorm(fromNorm(n)) = n for every continuous parameter', ok);
  check('knob space: the ends of the knob are the ends of the range', PARAMS.every((p) => fromNorm(p, 0) === p.min && fromNorm(p, 1) === p.max));
  const c = PARAMS[PIDX.cutoff];
  const linearMid = (c.min + c.max) / 2;
  check('knob space: a skew below 1 gives the low end room (cutoff at half turn is under a quarter of the linear midpoint)', fromNorm(c, 0.5) < linearMid / 4, `${Math.round(fromNorm(c, 0.5))} Hz against ${Math.round(linearMid)} Hz`);
  check('seeds: hex round trip', parseSeed(seedHex(0xabcdef123456)) === 0xabcdef123456 && parseSeed(seedHex(0)) === 0);
}

// ── presets ──────────────────────────────────────────────────────────────────
check('presets: 24, in six families', PRESETS.length === 24 && CATEGORIES.length === 6, CATEGORIES.join(', '));
check('presets: unique names', new Set(PRESETS.map((p) => p.n)).size === PRESETS.length);
{
  let bad = '';
  const clamped: string[] = [];
  PRESETS.forEach((_, i) => {
    const v = presetValues(i);
    const raw = presetRaw(i);
    v.forEach((x, k) => {
      const s = PARAMS[k];
      if (!(x >= s.min && x <= s.max) || (s.kind !== 'float' && x !== Math.round(x))) bad ||= `${PRESETS[i].n}: ${s.id} = ${x}`;
      if (raw[k] !== x) clamped.push(`${PRESETS[i].n} ${s.id.replace(/^a(\d)\./, 'agent $1 ')} ${raw[k]} → ${x}`);
    });
  });
  check('presets: every value is inside its range, and whole where it must be', !bad, bad);
  check('presets: every value a preset asks for is one its knob can reach (nothing is clamped)', clamped.length === 0, clamped.join('; '));
}

// ── the dice: a 48-bit linear congruential generator ────────────────────────────────────
{
  // reference with exact integers
  const A = 0x5deece66dn;
  const M = 1n << 48n;
  let s = 0x1234567890abn;
  const r = new Lcg48(Number(s));
  let same = true;
  for (let i = 0; i < 200000; i++) {
    s = (s * A + 11n) % M;
    same &&= r.next32() === Number(s >> 16n);
  }
  check('generator: 200,000 steps agree with exact 48-bit integer arithmetic', same);
  check('generator: the state stays below 2⁴⁸', r.state < 2 ** 48 && r.state === Number(s));

  // skip ahead by repeated squaring of the update rule, as the post says
  function jump(seed: bigint, n: bigint) {
    let a = A;
    let c = 11n;
    let accA = 1n;
    let accC = 0n;
    while (n > 0n) {
      if (n & 1n) {
        accA = (accA * a) % M;
        accC = (accC * a + c) % M;
      }
      c = (c * a + c) % M;
      a = (a * a) % M;
      n >>= 1n;
    }
    return (accA * seed + accC) % M;
  }
  let w = 99n;
  for (let i = 0; i < 1_000_000; i++) w = (w * A + 11n) % M;
  check('generator: jumping a million steps in ~log n multiplications lands where walking does', jump(99n, 1_000_000n) === w);

  // full period needs c odd and a ≡ 1 (mod 4): the Hull–Dobell conditions for a power-of-two modulus
  check('generator: Hull–Dobell conditions hold (c odd, a ≡ 1 mod 4), so the period is the full 2⁴⁸', 11 % 2 === 1 && Number(A % 4n) === 1);

  const f = new Lcg48(7);
  let lo = 1;
  let hi = 0;
  let mean = 0;
  const N = 200000;
  for (let i = 0; i < N; i++) {
    const x = f.float();
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
    mean += x / N;
  }
  check('generator: floats stay in [0, 1) with mean 1/2', lo >= 0 && hi < 1 && near(mean, 0.5, 0.005), `mean ${mean.toFixed(4)}`);
}

// ── the three kinds of chance ───────────────────────────────────────────────────
{
  const u = new Uncertainty();
  u.prepare(SR);
  u.rng.seed(42);
  console.log('  BIAS     e      mean (theory, drawn)       P(x > ½) (theory, drawn)');
  let ok = true;
  for (const b of [0, 0.25, 0.5, 0.75, 1]) {
    const e = Math.pow(2, 4 * (b - 0.5));
    let sum = 0;
    let hi = 0;
    const N = 400000;
    for (let i = 0; i < N; i++) {
      const x = u.stored(b);
      sum += x;
      if (x > 0.5) hi++;
    }
    const mean = sum / N;
    const tm = 1 / (1 + e);
    const tp = 1 - Math.pow(0.5, 1 / e);
    ok &&= near(mean, tm, 0.004) && near(hi / N, tp, 0.004);
    console.log(`  ${b.toFixed(2)}   ${e.toFixed(3).padStart(6)}   ${tm.toFixed(4)}  ${mean.toFixed(4)}            ${tp.toFixed(4)}  ${(hi / N).toFixed(4)}`);
  }
  check('stored chance: the mean is 1/(1+e) and P(x > ½) is 1 − 2^(−1/e) at every BIAS', ok);

  const seen = new Set<number>();
  for (let i = 0; i < 20000; i++) seen.add(Math.round(u.stepped(7, 0.5) * 6));
  check('stepped chance: exactly seven values, 0, 1/6 … 1', seen.size === 7 && [...seen].every((k) => k >= 0 && k <= 6));

  let hits = 0;
  for (let i = 0; i < 200000; i++) if (u.chance(0.3)) hits++;
  check('chance(p) fires with probability p', near(hits / 200000, 0.3, 0.005), `${(hits / 2000).toFixed(2)}%`);

  const f = new Uncertainty();
  f.prepare(SR);
  f.rng.seed(5);
  f.setDriftRate(2);
  let prev = 0;
  let maxStep = 0;
  let inside = true;
  for (let i = 0; i < SR * 10; i++) {
    f.advance();
    maxStep = Math.max(maxStep, Math.abs(f.current - prev));
    prev = f.current;
    inside &&= f.current >= -1 && f.current <= 1;
  }
  check('fluctuating chance: never jumps (largest step per sample is tiny) and stays in [−1, 1]', inside && maxStep < 1e-3, `max step ${maxStep.toExponential(1)}`);
}

// ── pitch ────────────────────────────────────────────────────────────────────
{
  const q = new Quantizer();
  const hzToMidi = (hz: number) => Math.round(69 + 12 * Math.log2(hz / 440));
  const f = new Lcg48(11);
  let bad = '';
  for (let sc = 0; sc < SCALE_DEGREES.length; sc++) {
    for (const root of [0, 3, 7, 11]) {
      q.scale = sc;
      q.root = root;
      for (let i = 0; i < 400; i++) {
        // spread and octave kept low enough that the note stays under MIDI 127, where the engine clamps
        const midi = hzToMidi(q.toHz(f.float(), 1 + f.float() * 2, Math.floor(f.float() * 3) - 1));
        const pc = (((midi - 36 - root) % 12) + 12) % 12;
        if (!SCALE_DEGREES[sc].includes(pc)) bad ||= `scale ${sc}, root ${root}: note ${midi} is degree ${pc}`;
      }
    }
  }
  check('quantizer: every pitch from every scale and root is a note of that scale', !bad, bad);
  q.scale = 0;
  q.root = 9;
  check('quantizer: root A, value 0, octave 0 gives A2 = 110 Hz', near(q.toHz(0, 2, 0), 110, 1e-9));
}

// ── the clock ────────────────────────────────────────────────────────────────
{
  const u = new Uncertainty();
  u.prepare(SR);
  u.rng.seed(3);
  const c = new Clock();
  c.prepare(SR);
  c.setRate(2);
  c.setGenerator(0, 3, 0.5);
  c.setGenerator(1, 4, 1);
  c.setGenerator(2, 6, 0.25);
  const count = [0, 0, 0, 0];
  const secs = 200;
  for (let i = 0; i < SR * secs; i++) {
    c.advance(u);
    for (let k = 0; k < 4; k++) if (c.fired(k)) count[k]++;
  }
  const want = [2 * GEN_MULT[3] * 0.5, 2 * GEN_MULT[4] * 1, 2 * GEN_MULT[6] * 0.25, 2].map((x) => x * secs);
  check('clock: each slot fires at rate × multiplier × probability', want.every((w, k) => Math.abs(count[k] - w) <= 4 * Math.sqrt(w) + 1), `${count.join(', ')} against ${want.map((w) => Math.round(w)).join(', ')}`);

  const sync = new Clock();
  sync.prepare(SR);
  sync.setSynced(120, 5);
  sync.setSwing(1);
  const u2 = new Uncertainty();
  u2.prepare(SR);
  let n = 0;
  for (let i = 0; i < SR * 20; i++) {
    sync.advance(u2);
    if (sync.fired(Clock.MASTER)) n++;
  }
  check('clock: synced to 120 BPM on quarter notes, with full swing, still ticks twice a second', Math.abs(n - 40) <= 1, `${n} ticks in 20 s`);
  check('clock: division table is in quarter notes', QUARTERS[3] === 4 && QUARTERS[5] === 1 && QUARTERS[7] === 0.25);

  const rates = [44100, 48000, 96000].map((sr) => {
    const k = new Clock();
    k.prepare(sr);
    k.setRate(5);
    const uu = new Uncertainty();
    uu.prepare(sr);
    let m = 0;
    for (let i = 0; i < sr * 10; i++) {
      k.advance(uu);
      if (k.fired(Clock.MASTER)) m++;
    }
    return m;
  });
  check('clock: 5 Hz is 50 ticks in 10 s at 44.1, 48 and 96 kHz alike', rates.every((m) => Math.abs(m - 50) <= 1), rates.join(', '));
}

// ── the folder ───────────────────────────────────────────────────────────────
{
  let worst = 0;
  for (let i = -5000; i <= 5000; i++) {
    const x = i / 100;
    worst = Math.max(worst, Math.abs(triFold(x) - (2 / Math.PI) * Math.asin(Math.sin((Math.PI * x) / 2))));
  }
  check('folder: the closed form equals (2/π)·asin(sin(πx/2)) over [−50, 50]', worst < 1e-12, worst.toExponential(1));
  check('folder: the identity between −1 and 1', [-1, -0.5, 0, 0.3, 1].every((x) => near(triFold(x), x, 1e-12)));

  const turns = (gain: number) => {
    const M = 8192;
    let prev = 0;
    let t = 0;
    let last = triFold(0);
    for (let i = 1; i <= M; i++) {
      const v = triFold(gain * Math.sin((2 * Math.PI * i) / M));
      const d = Math.abs(v - last) < 1e-9 ? 0 : Math.sign(v - last);
      if (d) {
        if (prev && d !== prev) t++;
        prev = d;
      }
      last = v;
    }
    return t;
  };
  check('folder: a sine turns round twice a cycle, and 18 times at full FOLD (height 8)', turns(1) === 2 && turns(8) === 18, `${turns(1)}, ${turns(2.75)}, ${turns(4.5)}, ${turns(6.25)}, ${turns(8)}`);

  const f0 = 200;
  const o = new ComplexOscillator();
  o.prepare(SR);
  const harm = (fold: number, sym: number) => {
    o.reset();
    o.set(f0, 1.5, 0, fold, sym);
    const x = new Float64Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = o.process();
    const a = Array.from({ length: 20 }, (_, k) => goertzel(x, f0 * (k + 1)));
    return { a, x };
  };
  const plain = harm(0, 0);
  check('oscillator: with no fold and no FM the fundamental is where it was told to be and dominates', plain.a[0] > 10 * Math.max(...plain.a.slice(1)) * 0.5 && plain.a[0] > 0.5, `${db(plain.a[0]).toFixed(1)} dB`);
  const sym0 = harm(0.5, 0);
  const evenOdd = (a: number[]) => ({ even: Math.max(...a.filter((_, k) => (k + 1) % 2 === 0)), odd: Math.max(...a.filter((_, k) => (k + 1) % 2 === 1)) });
  const e0 = evenOdd(sym0.a);
  check('oscillator: with no symmetry offset the folded wave has only odd harmonics', db(e0.even) < db(e0.odd) - 60, `strongest even ${db(e0.even).toFixed(0)} dB, odd ${db(e0.odd).toFixed(0)} dB`);
  const sym1 = harm(0.6, 0.5);
  const e1 = evenOdd(sym1.a);
  check('oscillator: an offset before the fold brings in the even harmonics', db(e1.even) > db(e1.odd) - 12, `strongest even ${db(e1.even).toFixed(0)} dB, odd ${db(e1.odd).toFixed(0)} dB`);
  const more = harm(1, 0);
  check('oscillator: folding adds harmonics (more of the first 20 above −40 dB at FOLD 1 than at FOLD 0)', more.a.filter((x) => db(x) > -40).length > plain.a.filter((x) => db(x) > -40).length + 3);
  check('oscillator: the output is finite and below 1', Array.from(more.x).every((x) => Number.isFinite(x) && Math.abs(x) < 1));

  // Aliasing. A 5 kHz fold-heavy tone has harmonics at multiples of 5 kHz. Whatever lands above Nyquist
  // reflects back to a multiple of 1 kHz that is not a multiple of 5 kHz, so the power on those bins is alias.
  // A naive folder at the plain sample rate is the reference: oversampling should beat it clearly.
  const f5 = 5000;
  const aliasDb = (x: ArrayLike<number>) => {
    let harm = 0;
    let alias = 0;
    for (let f = 1000; f < SR / 2; f += 1000) {
      const m = goertzel(x, f);
      if (f % f5 === 0) harm += m * m;
      else alias += m * m;
    }
    return 10 * Math.log10(alias / harm);
  };
  const hi = new ComplexOscillator();
  hi.prepare(SR);
  hi.set(f5, 1.5, 0, 1, 0);
  const ours = new Float64Array(SR);
  for (let i = 0; i < ours.length; i++) ours[i] = hi.process();
  const naive = new Float64Array(SR);
  for (let i = 0; i < naive.length; i++) naive[i] = Math.tanh(1.3 * triFold(Math.sin((2 * Math.PI * f5 * i) / SR) * 8)) * 0.82;
  // 43,200 samples is 900 periods of 1 kHz, so each bin is exact; the first 4,800 skip the filter's start-up
  const a = aliasDb(ours.subarray(4800));
  const b = aliasDb(naive.subarray(4800));
  check('oscillator: 2× oversampling puts the aliases of a 5 kHz full fold at least 6 dB below a naive folder', a < b - 6, `${a.toFixed(1)} dB against ${b.toFixed(1)} dB`);
}

// ── the gate ──────────────────────────────────────────────────────────────────
{
  const closed = (t: number, T: number) => 1 / ((25 / 3) * Math.exp((0.12 * t) / T) - 22 / 3);
  let worst = 0;
  for (const T of [0.05, 0.4, 3]) {
    const g = new LowpassGate();
    g.prepare(SR);
    g.setFall(T);
    g.setMode(GATE_BOTH);
    for (let i = 0; i < SR * 0.5; i++) g.process(0, 1); // fully open
    const c0 = g.conductance;
    const n = Math.round(SR * T * 12);
    for (let i = 0; i < n; i++) {
      g.process(0, 0);
      const t = (i + 1) / SR;
      const want = closed(t, T);
      if (want > 1e-4) worst = Math.max(worst, Math.abs(g.conductance - want) / want);
    }
    if (T === 0.4) check('gate: opens to full conductance in well under 0.5 s', near(c0, 1, 1e-6));
  }
  check('gate: the per-sample recurrence follows c(t) = 1/((25/3)e^(0.12 t/T) − 22/3) to better than 0.5% (T = 50 ms, 400 ms, 3 s)', worst < 5e-3, `worst ${(worst * 100).toFixed(3)}%`);

  const timeTo = (T: number, level: number) => {
    const g = new LowpassGate();
    g.prepare(SR);
    g.setFall(T);
    for (let i = 0; i < SR * 0.5; i++) g.process(0, 1);
    for (let i = 0; i < SR * T * 60; i++) {
      g.process(0, 0);
      if (g.conductance <= level) return (i + 1) / SR / T;
    }
    return NaN;
  };
  const t10 = timeTo(0.4, 0.1);
  const t01 = timeTo(0.4, 0.01);
  check('gate: the post\'s table: 10% at 6.1 T and 1% at 21 T, against 2.3 T and 4.6 T for a plain exponential', near(t10, 6.1, 0.1) && near(t01, 21.3, 0.3), `${t10.toFixed(2)} T, ${t01.toFixed(2)} T`);
  check('gate: the tail is 8⅓ times slower than the start', near(1 / 0.12, 8.333, 0.01));

  // quiet means dull: at low conductance the VCF half takes away the highs
  const gain = (mode: number, f: number) => {
    const g = new LowpassGate();
    g.prepare(SR);
    g.setMode(mode);
    g.setColour(1);
    for (let i = 0; i < SR * 0.3; i++) g.process(0, 0.25);
    const x = new Float64Array(SR / 2);
    for (let i = 0; i < x.length; i++) x[i] = g.process(Math.sin((2 * Math.PI * f * i) / SR), 0.25);
    return goertzel(x, f);
  };
  check('gate: at low conductance the filter half cuts 8 kHz far more than 200 Hz', db(gain(GATE_VCF, 8000)) < db(gain(GATE_VCF, 200)) - 15, `${(db(gain(GATE_VCF, 200)) - db(gain(GATE_VCF, 8000))).toFixed(0)} dB apart`);
}

// ── the reverb and the limiter ──────────────────────────────────────────────
{
  const rv = new Reverb(SR);
  rv.set(0.7, 0.4, 1);
  const n = SR * 4;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  L[0] = R[0] = 1;
  rv.process(L, R, n);
  const e = (a: number, b: number) => rms(L.subarray(a, b));
  check('reverb: an impulse rings out and the tail decays', e(SR * 3, SR * 4) < e(0, SR) * 0.05 && L.every(Number.isFinite), `${db(e(SR * 3, SR * 4) / e(0, SR)).toFixed(0)} dB after three seconds`);
  const dry = new Reverb(SR);
  dry.set(0.7, 0.4, 0);
  const a = new Float32Array(64).fill(0.25);
  const b = new Float32Array(64).fill(0.25);
  dry.process(a, b, 64);
  check('reverb: at mix 0 it passes the signal at JUCE\'s dry gain of 2', near(a[10], 0.5, 1e-6));
  let mono = true;
  let bounded = true;
  let prev = softLimit(0);
  for (let x = 0; x <= 100; x += 0.01) {
    const y = softLimit(x);
    mono &&= y >= prev - 1e-12;
    bounded &&= y <= 1;
    prev = y;
  }
  check('limiter: transparent below 0.7, rises monotonically, never passes 1', softLimit(0.5) === 0.5 && softLimit(-0.69) === -0.69 && mono && bounded && softLimit(100) <= 1);
}

// ── the whole instrument ─────────────────────────────────────────────────────
{
  const base = presetValues(8);
  const a = render(base, 12345, 6);
  const b = render(base, 12345, 6, SR, 480);
  let same = true;
  for (let i = 0; i < a.L.length; i++) same &&= a.L[i] === b.L[i] && a.R[i] === b.R[i];
  check('same seed, same knobs: the same piece, sample for sample, whatever the block size', same);

  const c = render(base, 12346, 6);
  let diff = 0;
  for (let i = 0; i < a.L.length; i++) diff += Math.abs(a.L[i] - c.L[i]);
  check('a different seed gives a different piece', diff > 1);

  const g = new Guzen(SR, Float64Array.from(base), 777);
  const first = new Float32Array(SR);
  const firstR = new Float32Array(SR);
  for (let i = 0; i < SR; i += 128) g.process(first.subarray(i), firstR.subarray(i), Math.min(128, SR - i));
  const trash = new Float32Array(128 * 40);
  const trashR = new Float32Array(128 * 40);
  g.process(trash, trashR, trash.length);
  g.restart(777);
  const again = new Float32Array(SR);
  const againR = new Float32Array(SR);
  for (let i = 0; i < SR; i += 128) g.process(again.subarray(i), againR.subarray(i), Math.min(128, SR - i));
  check('restart(seed) after playing on replays the piece from the beginning', first.every((x, i) => x === again[i]));

  // moving a knob mid-piece changes the sound without breaking anything
  const k = new Guzen(SR, Float64Array.from(base), 5);
  const bl = new Float32Array(128);
  const br = new Float32Array(128);
  let finite = true;
  for (let i = 0; i < 600; i++) {
    if (i % 25 === 0) for (const id of ['cutoff', 'reso', 'revSize', 'swing']) k.set(PIDX[id], PARAMS[PIDX[id]].min + Math.random() * (PARAMS[PIDX[id]].max - PARAMS[PIDX[id]].min));
    if (i % 40 === 0) k.set(AGENT0 + (i % 6) * AGENT_STRIDE + LEAF.on, i % 80 === 0 ? 0 : 1);
    k.process(bl, br, 128);
    finite &&= bl.every(Number.isFinite) && br.every(Number.isFinite);
  }
  check('turning knobs and switching agents off and on mid-piece stays finite', finite);
}

// ── every preset: not broken ─────────────────────────────────────────────────
console.log('\n  preset                     peak    rms dBFS  active  dc      render');
let heaviest = 0;
{
  let allOk = true;
  const notes: string[] = [];
  for (let i = 0; i < PRESETS.length; i++) {
    const t0 = performance.now();
    const { L, R } = render(presetValues(i), 1, 20);
    const ms = performance.now() - t0;
    heaviest = Math.max(heaviest, ms / 20000);
    let peak = 0;
    let dc = 0;
    for (let k = 0; k < L.length; k++) {
      peak = Math.max(peak, Math.abs(L[k]), Math.abs(R[k]));
      dc += (L[k] + R[k]) / (2 * L.length);
    }
    const win = SR / 10;
    let active = 0;
    for (let k = 0; k + win <= L.length; k += win) if (rms(L.subarray(k, k + win)) > 10 ** (-70 / 20)) active++;
    const frac = active / (L.length / win);
    const ok = L.every(Number.isFinite) && R.every(Number.isFinite) && peak <= 1 && frac >= 0.05 && Math.abs(dc) < 0.01;
    allOk &&= ok;
    if (!ok) notes.push(PRESETS[i].n);
    console.log(`  ${(PRESETS[i].c + ' / ' + PRESETS[i].n).padEnd(26)} ${peak.toFixed(3)}  ${db(rms(L)).toFixed(1).padStart(7)}   ${(frac * 100).toFixed(0).padStart(3)}%   ${dc.toFixed(4).padStart(7)}  ${(ms / 20000).toFixed(3)}×`);
  }
  check('all 24 presets, 20 s each: finite, never above 1, audible in at least 5% of the time, no DC offset', allOk, notes.join(', '));
}
check('performance: the heaviest preset renders at under 30% of real time in Node', heaviest < 0.3, `${(heaviest * 100).toFixed(1)}% of real time`);

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
