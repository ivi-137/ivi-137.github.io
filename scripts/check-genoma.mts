/**
 * Check Genoma's engines against what they claim to do:
 *   node scripts/check-genoma.mts
 */
import { Reel, speedRatio, overlap, geneLength, MORPH_SEAMLESS, MORPH_STRETCH, REC_OFF, type ReelCtl } from '../src/lib/genoma/reel.ts';
import { Tape, encodeReel, readCues } from '../src/lib/genoma/tape.ts';
import { Pad, whammySt } from '../src/lib/genoma/pad.ts';
import { Coco, Quantussy, COCO_MEM } from '../src/lib/genoma/coco.ts';
import { CONDS, Sequencer, euclid, euclidTrack, newPattern, newTrig, newEu, type SeqSink } from '../src/lib/genoma/seq.ts';
import { Operatori } from '../src/lib/genoma/fm.ts';
import { SOUNDS, build, demoProject } from '../src/lib/genoma/demo.ts';
import { GPARAMS, TPARAMS, MACHINE_SLOTS, SLOTS, defaultSound, trackSpec } from '../src/lib/genoma/params.ts';

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const SR = 48000;

/** Frequency of a signal by counting upward zero crossings. */
function freq(x: Float32Array | number[], sr = SR) {
  let n = 0,
    first = -1,
    last = -1;
  for (let i = 1; i < x.length; i++)
    if (x[i - 1] <= 0 && x[i] > 0) {
      if (first < 0) first = i;
      last = i;
      n++;
    }
  return n > 1 ? ((n - 1) * sr) / (last - first) : 0;
}
const rms = (x: ArrayLike<number>) => Math.sqrt(Array.from(x).reduce((s, v) => s + v * v, 0) / Math.max(1, x.length));

// ── parameter tables ───────────────────────────────────────────────────────────
check(
  'global parameters: unique ids, defaults inside their ranges',
  new Set(GPARAMS.map((p) => p.id)).size === GPARAMS.length && GPARAMS.every((p) => p.def >= p.min && p.def <= p.max),
);
check(
  'track parameters: unique ids, defaults inside their ranges',
  new Set(TPARAMS.map((p) => p.id)).size === TPARAMS.length && TPARAMS.every((p) => p.def >= p.min && p.def <= p.max),
);
check(
  'every machine has 24 slots with defaults in range',
  MACHINE_SLOTS.every((m) => m.length === SLOTS && m.every((s) => s.def >= s.min && s.def <= s.max)),
);
check(
  'machine slot labels are unique within a machine',
  MACHINE_SLOTS.every((m) => new Set(m.filter((s) => s.label).map((s) => s.label)).size === m.filter((s) => s.label).length),
);
check(
  'factory sounds build without unknown names',
  SOUNDS.every((s) => build(s).length === TPARAMS.length),
  `${SOUNDS.length} sounds`,
);
check('trackSpec gives the machine names', trackSpec(1, 1).label === 'tune' && trackSpec(1, 0).label === 'algo');

// ── the reel ────────────────────────────────────────────────────────────────
check('Vari-Speed: noon stops, +0.5 is 1x, full clockwise +12 st', speedRatio(0) === 0 && speedRatio(0.5) === 1 && near(speedRatio(1), 2, 1e-9));
check(
  'Vari-Speed: just off noon is −26 st; counter-clockwise reverses',
  near(speedRatio(0.0301), Math.pow(2, -26 / 12), 0.003) && speedRatio(-0.5) === -1 && near(speedRatio(-1), -2, 1e-9),
);
check(
  'Morph: 1/1 at half past eight, 2/1 where the clock starts to stretch, 3/1 at most',
  overlap(MORPH_SEAMLESS) === 1 && near(overlap(MORPH_STRETCH), 2, 1e-9) && overlap(1) === 3 && overlap(0) < 0.2,
);
check(
  'Gene size: the whole splice fully counter-clockwise, 4 ms fully clockwise',
  geneLength(48000, 0, SR) === 48000 && near(geneLength(48000, 1, SR), 192, 1e-6),
);

const ctl = (o: Partial<ReelCtl> = {}): ReelCtl => ({ speed: 0.5, gene: 0, slide: 0, morph: MORPH_SEAMLESS, organize: 0, sos: 0.5, ...o });
function recordSine(reel: Reel, hz: number, sec: number, c = ctl()) {
  reel.recNew();
  for (let i = 0; i < sec * SR; i++) {
    const x = Math.sin((2 * Math.PI * hz * i) / SR) * 0.5;
    reel.process(x, x, c);
  }
  reel.recStop();
}
function run(reel: Reel, n: number, c = ctl(), input = 0) {
  const L = new Float32Array(n),
    R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    reel.process(input, input, c);
    L[i] = reel.outL;
    R[i] = reel.outR;
  }
  return { L, R };
}
{
  const reel = new Reel(SR, 20);
  recordSine(reel, 440, 1);
  check('REC on an empty reel records a new splice', reel.tape.count === 1 && near(reel.tape.len, SR, 2), `${reel.tape.len} frames`);
  const out = run(reel, SR / 2).L.slice(2000);
  check('it plays back at 1x: the same pitch', near(freq(out), 440, 3), `${freq(out).toFixed(1)} Hz`);
  const up = run(reel, SR / 2, ctl({ speed: 1 })).L.slice(12000);
  check('full Vari-Speed doubles the pitch', near(freq(up), 880, 8), `${freq(up).toFixed(1)} Hz`);
  const st = run(reel, SR / 4, ctl({ speed: 0 })).L.slice(-2000);
  check('at noon the tape stops and falls silent', rms(st) < 0.01, `rms ${rms(st).toFixed(4)}`);
  // a second splice, then SPLICE, SHIFT, SHIFT+SPLICE
  recordSine(reel, 220, 1);
  check('REC+SPLICE records a second splice at the end of the reel', reel.tape.count === 2 && reel.cur === 1, `count ${reel.tape.count}, current ${reel.cur}`);
  const low = run(reel, SR / 2).L.slice(4000);
  check('the new splice plays at once', near(freq(low), 220, 3), `${freq(low).toFixed(1)} Hz`);
  reel.shift();
  const back = run(reel, SR / 2).L.slice(4000);
  check('SHIFT moves to the next splice (wrapping to the first)', reel.cur === 0 && near(freq(back), 440, 4), `${freq(back).toFixed(1)} Hz`);
  run(reel, 12345);
  const k = reel.splice();
  check('SPLICE adds a marker where the gene is', k === 1 && reel.tape.count === 3, `splice ${k}, count ${reel.tape.count}`);
  reel.cur = 0;
  reel.deleteMarker();
  check('SHIFT+SPLICE joins the splice with the next', reel.tape.count === 2);
  // Organize waits for the end of the gene
  run(reel, 100, ctl({ organize: 0 }));
  reel.cur = 0;
  run(reel, 100, ctl({ organize: 0.99 }));
  check('Organize: the new splice waits for the end of the gene', reel.cur === 0);
  run(reel, SR * 1.2, ctl({ organize: 0.99 }));
  check('…and then plays', reel.cur === 1);
  // delete the splice's audio
  const before = reel.tape.len;
  reel.deleteSplice();
  check('SHIFT+REC cuts the splice out of the reel', reel.tape.count === 1 && near(reel.tape.len, before - SR, 2), `${before} → ${reel.tape.len}`);
  reel.clearReel();
  check('SHIFT+REC held: the reel is empty', reel.tape.len === 0 && reel.tape.count === 0);
}
{
  // genes: small ones loop, EOSG fires once per gene, Morph gaps leave silence
  const reel = new Reel(SR, 10);
  recordSine(reel, 300, 2);
  const c = ctl({ gene: 0.5, morph: MORPH_SEAMLESS });
  const g = geneLength(2 * SR, 0.5, SR);
  let pulses = 0,
    was = 0;
  for (let i = 0; i < SR; i++) {
    reel.process(0, 0, c);
    if (reel.eos && !was) pulses++;
    was = reel.eos;
  }
  const expect = SR / (g * (1 - (0.003 * SR) / g - 0));
  check('EOSG: one pulse per gene', near(pulses, expect, 2.5), `${pulses} pulses, gene ${((g / SR) * 1000).toFixed(0)} ms`);
  const gaps = run(reel, SR, ctl({ gene: 0.5, morph: 0 })).L;
  const silent = gaps.filter((x) => Math.abs(x) < 1e-3).length / gaps.length;
  check('Morph fully counter-clockwise: long gaps between genes', silent > 0.7, `${(silent * 100).toFixed(0)}% silent`);
  const dense = run(reel, SR, ctl({ gene: 0.5, morph: 0.7 })).L.slice(SR / 4);
  check('Morph toward 3/1: genes overlap, no gaps', dense.filter((x) => Math.abs(x) < 1e-3).length / dense.length < 0.05);
  const wide = run(reel, SR, ctl({ gene: 0.6, morph: 1 }));
  let diff = 0;
  for (let i = 0; i < SR; i++) diff += Math.abs(wide.L[i] - wide.R[i]);
  check('Morph fully clockwise: genes panned apart', diff / SR > 0.01, `mean |L−R| ${(diff / SR).toFixed(3)}`);
  // the clock
  const a = reel.gene(ctl({ gene: 0.5, morph: 0.1 })).start;
  reel.ctl = ctl({ gene: 0.5, morph: 0.1 });
  reel.clock();
  run(reel, 10, ctl({ gene: 0.5, morph: 0.1 }));
  reel.clock();
  const b = reel.gene(ctl({ gene: 0.5, morph: 0.1 })).start;
  check(
    'CLK below nine o’clock: each pulse shifts to the next gene',
    near(b - a, 2 * g, 2) || near(b - a + 2 * SR, 2 * g, 2),
    `moved ${b - a} for gene ${g.toFixed(0)}`,
  );
}
{
  // S.O.S.
  const reel = new Reel(SR, 5);
  recordSine(reel, 500, 0.5);
  reel.recToggle();
  run(reel, SR / 2, ctl({ sos: 1 }), 0);
  reel.recToggle();
  check('S.O.S. fully clockwise, recording silence: the splice is replaced', rms(reel.tape.dump().L) < 1e-3);
  const r2 = new Reel(SR, 5);
  recordSine(r2, 500, 0.5);
  const was = rms(r2.tape.dump().L);
  r2.recToggle();
  run(r2, SR / 2, ctl({ sos: 0 }), 0.3);
  r2.recToggle();
  check('S.O.S. fully counter-clockwise: nothing new is written', near(rms(r2.tape.dump().L), was, 1e-3) && r2.rec === REC_OFF);
}
{
  // scrub: moving the hand makes sound, holding still does not
  const reel = new Reel(SR, 5);
  recordSine(reel, 400, 1);
  reel.scrub(true, 0.2);
  let moving = 0;
  for (let i = 0; i < SR / 2; i++) {
    reel.scrub(true, 0.2 + (0.4 * i) / (SR / 2));
    reel.process(0, 0, ctl());
    moving += reel.outL * reel.outL;
  }
  let still = 0;
  for (let i = 0; i < SR / 2; i++) {
    reel.scrub(true, 0.6);
    reel.process(0, 0, ctl());
    if (i > SR / 4) still += reel.outL * reel.outL;
  }
  check('scrub: sound while the hand moves, silence when it stops', moving > 20 * still, `${moving.toFixed(1)} vs ${still.toFixed(3)}`);
}
{
  const t = new Tape(SR, 3);
  const L = Float32Array.from({ length: 5000 }, (_, i) => Math.sin(i / 10));
  t.load(L, L, [0, 1000, 3000]);
  const d = t.dump();
  const wav = encodeReel(d.L, d.R, SR, d.marks);
  check('reel WAV: 32-bit float stereo, splice markers as cue points', new DataView(wav).getUint16(20, true) === 3 && readCues(wav).join() === '1000,3000');
}

// ── the pad ─────────────────────────────────────────────────────────────────
{
  const pad = new Pad(SR);
  const out: number[] = [];
  for (let i = 0; i < SR; i++) {
    const x = Math.sin((2 * Math.PI * 330 * i) / SR) * 0.5;
    pad.process(x, x, true, 4, 0.75, 1, 1, SR / 2);
    if (i > SR / 2) out.push(pad.outL);
  }
  check('whammy: X at three quarters is an octave up', whammySt(0.75) === 12 && near(freq(out), 660, 12), `${freq(out).toFixed(0)} Hz`);
  const lp: number[] = [];
  const pad2 = new Pad(SR);
  for (let i = 0; i < SR / 2; i++) {
    const x = Math.sin((2 * Math.PI * 5000 * i) / SR) * 0.5;
    pad2.process(x, x, true, 0, 0.1, 0, 1, SR / 2);
    if (i > SR / 4) lp.push(pad2.outL);
  }
  check('filtro: a low X shuts out the highs', rms(lp) < 0.02, `rms ${rms(lp).toFixed(4)}`);
  const pad3 = new Pad(SR);
  const cut: number[] = [];
  for (let i = 0; i < SR * 2; i++) {
    const x = i < SR ? Math.sin((2 * Math.PI * 200 * i) / SR) * 0.5 : 0;
    pad3.process(x, x, i >= SR, 2, 0.5, 0.5, 1, SR / 2);
    if (i > SR * 1.2) cut.push(pad3.outL);
  }
  check('taglia: the slice caught at the touch keeps repeating after the input stops', rms(cut) > 0.2, `rms ${rms(cut).toFixed(3)}`);
}

// ── Quinconce ───────────────────────────────────────────────────────────────
{
  const coco = new Coco(SR);
  const hz = 20000;
  let at = -1;
  for (let i = 0; i < SR * 4; i++) {
    const x = i < 200 ? 0.9 : 0;
    const y = coco.process(x, hz, i < SR, 1, 0);
    if (i > 400 && at < 0 && Math.abs(y) > 0.3) at = i;
  }
  const loop = COCO_MEM / hz;
  check('Coco: the loop lasts 65,536 clock ticks (3.3 s at 20 kHz)', near(at / SR, loop, 0.02), `${(at / SR).toFixed(3)} s`);
  const c2 = new Coco(SR);
  for (let i = 0; i < SR; i++) c2.process(Math.sin(i / 20) * 0.5, 30000, true, 0, 0);
  const a = c2.addr;
  c2.skip(30000);
  check('SKIP jumps a fixed time: more samples at a faster clock', (c2.addr - a + COCO_MEM) % COCO_MEM === Math.round(0.125 * 30000));
  const q = new Quantussy(SR);
  const edges = [0, 0, 0, 0, 0];
  q.rates([0.5, 0.5, 0.5, 0.5, 0.5], false);
  for (let i = 0; i < SR * 10; i++) {
    q.process(0.8);
    for (let k = 0; k < 5; k++) edges[k] += q.rose[k];
  }
  check('Quantussy: five petals, all pulsing, at different rates under chaos', edges.every((e) => e > 3) && new Set(edges).size > 2, edges.join(' '));
}

// ── the sequencer ───────────────────────────────────────────────────────────
check(
  'Euclid: 4 in 16 falls on the beats',
  euclid(4, 16)
    .map((b, i) => (b ? i : -1))
    .filter((i) => i >= 0)
    .join() === '0,4,8,12',
);
check(
  'Euclid: 3 in 8 is the tresillo (3+3+2)',
  euclid(3, 8)
    .map((b) => (b ? 'x' : '.'))
    .join('') === 'x..x..x.',
);
check('Euclid: generators combine (4|3 XOR in 12)', euclidTrack({ ...newEu(), on: 1, p1: 4, p2: 3, op: 2 }, 12).filter(Boolean).length === 5);
{
  const hits: { k: number; t: number; n: number[]; v: number }[] = [];
  let now = 0;
  const sink: SeqSink = { note: (k, n, v) => hits.push({ k, t: now, n, v }), lock: () => {} };
  const seq = new Sequencer(SR, sink);
  const p = newPattern();
  p.tracks[0].steps[0] = newTrig(36);
  p.tracks[0].steps[1] = newTrig(38);
  p.tracks[0].steps[2] = { ...newTrig(40), mt: -12 };
  p.tracks[0].steps[3] = { ...newTrig(41), c: CONDS.findIndex((c) => c.label === '1:2') };
  p.tracks[0].steps[4] = { ...newTrig(43), c: CONDS.findIndex((c) => c.label === 'FILL') };
  p.tracks[0].steps[5] = { ...newTrig(45), rt: 12, rl: 1 };
  seq.pats[0] = p;
  seq.bpm = 120;
  seq.swing = 66.6667;
  seq.play();
  const sps = (SR * 60) / (120 * 4);
  for (now = 0; now < sps * 16 * 2; now++) seq.tick();
  const at = (n: number) => hits.filter((h) => h.n[0] === n).map((h) => h.t);
  check('step 0 on the first sample', at(36)[0] === 0);
  check('swing 66%: the off-step is late by a third of a step', near(at(38)[0], sps * (1 + 1 / 3), 2), `${(at(38)[0] / sps).toFixed(3)} steps`);
  check('micro timing −12/24: half a step early', near(at(40)[0], sps * 1.5, 2), `${(at(40)[0] / sps).toFixed(3)} steps`);
  check('1:2 plays on the first of every two passes', at(41).length === 1);
  check('FILL stays quiet unless fill is held', at(43).length === 0);
  check('retrig at 1/32 over one step: two hits a pass', at(45).length === 4);
  // arpeggiator
  const hits2: number[] = [];
  const seq2 = new Sequencer(SR, { note: (_k, n) => hits2.push(n[0]), lock: () => {} });
  const p2 = newPattern();
  p2.tracks[0].arp = { m: 2, sp: 2, r: 2, nl: 0.5, len: 16, mask: 0xffff, ofs: new Array(16).fill(0) };
  p2.tracks[0].steps[0] = { ...newTrig(60), n: [64, 60, 67], l: 6 };
  seq2.pats[0] = p2;
  seq2.play();
  for (let i = 0; i < sps * 7; i++) seq2.tick();
  check('arpeggiator "su" over two octaves', hits2.join() === '60,64,67,72,76,79', hits2.join());
  // chaining
  const seq3 = new Sequencer(SR, { note: () => {}, lock: () => {} });
  seq3.pats[0] = newPattern();
  seq3.pats[1] = newPattern();
  seq3.play();
  seq3.queue(1);
  for (let i = 0; i < sps * 15; i++) seq3.tick();
  const mid = seq3.cur;
  for (let i = 0; i < sps * 2; i++) seq3.tick();
  check('a queued pattern starts when this one ends', mid === 0 && seq3.cur === 1);
}

// ── Operatori: the demo renders, every machine sounds, nothing blows up ────────────────
{
  const op = new Operatori(SR);
  const proj = demoProject();
  op.seq.pats = proj.pats;
  op.g.bpm = 96;
  op.seq.play();
  let peak = 0,
    sum = 0,
    nan = false;
  const t0 = performance.now();
  const N = SR * 8;
  for (let i = 0; i < N; i++) {
    op.process();
    const v = Math.max(Math.abs(op.outL), Math.abs(op.outR));
    if (!Number.isFinite(op.outL + op.outR)) nan = true;
    peak = Math.max(peak, v);
    sum += op.outL * op.outL;
  }
  const ms = performance.now() - t0;
  check('the demo pattern renders: no NaN, a sane level', !nan && peak > 0.05 && peak < 1.5, `peak ${peak.toFixed(3)}, rms ${Math.sqrt(sum / N).toFixed(3)}`);
  check('Operatori runs faster than real time', ms < 8000 * 0.6, `${(8000 / ms).toFixed(1)}× real time`);
  for (let m = 0; m < 4; m++) {
    const o = new Operatori(SR);
    const pat = newPattern();
    pat.tracks[0].snd = defaultSound(m);
    o.seq.pats[0] = pat;
    o.note(0, [60], 100, SR / 2, null, false, true);
    let e = 0,
      bad = false;
    for (let i = 0; i < SR / 2; i++) {
      o.process();
      e += o.outL * o.outL;
      if (!Number.isFinite(o.outL)) bad = true;
    }
    check(`machine ${['FM Tone', 'FM Drum', 'Wavetone', 'Swarmer'][m]} sounds`, !bad && e > 1, `energy ${e.toFixed(1)}`);
  }
  for (const s of SOUNDS) {
    const o = new Operatori(SR);
    const pat = newPattern();
    pat.tracks[0].snd = build(s);
    o.seq.pats[0] = pat;
    o.note(0, [s.tp.note ?? 57], 110, SR / 3, null, false, true);
    let pk = 0,
      bad = false;
    for (let i = 0; i < SR / 2; i++) {
      o.process();
      if (!Number.isFinite(o.outL + o.outR)) bad = true;
      pk = Math.max(pk, Math.abs(o.outL), Math.abs(o.outR));
    }
    if (bad || pk < 0.01 || pk > 1.6) check(`sound "${s.name}"`, false, `peak ${pk.toFixed(3)}${bad ? ', NaN' : ''}`);
  }
  check('every factory sound plays at a sane level', true);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
