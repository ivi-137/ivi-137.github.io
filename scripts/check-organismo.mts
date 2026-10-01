/**
 * Check Organismo 23's engine against what the Pulsar-23 manual says the instrument does:
 *   node --import ./scripts/ts-resolve.mjs scripts/check-organismo.mts
 *
 * The engine is plain TypeScript, so everything here runs under Node with no audio device. Each check below names
 * the statement in the manual (or the reviews) it tests. Where the manual is silent, because Soma publishes no
 * schematics, nothing is claimed.
 */
import { Organismo, compile, VEL } from '../src/lib/organismo/dsp.ts';
import { BANKS, EVENTS_PER_PULSE, LOOP_EVENTS, NPINS, PARAMS, PIDX, PINS, PIN_INDEX, PULSES, SIXTEENTH, defaults, format, fromNorm, gridToEvents, rle, spec, toNorm, unrle, type Cable } from '../src/lib/organismo/params.ts';
import { PRESETS, presetControls, presetLoops } from '../src/lib/organismo/presets.ts';

let failed = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const rel = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.abs(b);
const SR = 48000;
const P = (id: string) => PIN_INDEX[id];
const C = (id: string) => PIDX[id];
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));

/** A fresh instrument with some controls set. */
function rig(set: Record<string, number> = {}, cables: Cable[] = [], sr = SR) {
  const o = new Organismo(sr);
  for (const [k, v] of Object.entries(set)) o.set(C(k), v);
  o.setCables(cables);
  return o;
}
const L1 = new Float32Array(1);
const R1 = new Float32Array(1);
/** Run `seconds`, one sample at a time, calling `each` after every sample. */
function run(o: Organismo, seconds: number, each?: (n: number) => void) {
  const n = Math.round(seconds * o.sr);
  for (let i = 0; i < n; i++) {
    o.process(L1, R1, 1);
    each?.(i);
  }
}
/** Render audio in blocks, as the worklet does. */
function render(o: Organismo, seconds: number, block = 128) {
  const n = Math.round(seconds * o.sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bl = new Float32Array(block);
  const br = new Float32Array(block);
  for (let i = 0; i < n; i += block) {
    const m = Math.min(block, n - i);
    o.process(bl, br, m);
    L.set(bl.subarray(0, m), i);
    R.set(br.subarray(0, m), i);
  }
  return { L, R };
}
const pinv = (o: Organismo, id: string) => o.ov[P(id)];
const maxOf = (x: ArrayLike<number>, a = 0) => {
  let m = -Infinity;
  for (let i = a; i < x.length; i++) if (x[i] > m) m = x[i];
  return m;
};
const minOf = (x: ArrayLike<number>, a = 0) => {
  let m = Infinity;
  for (let i = a; i < x.length; i++) if (x[i] < m) m = x[i];
  return m;
};
const maxAbs = (x: ArrayLike<number>, a = 0) => {
  let m = 0;
  for (let i = a; i < x.length; i++) if (Math.abs(x[i]) > m) m = Math.abs(x[i]);
  return m;
};
const rms = (x: ArrayLike<number>, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
};
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
/** Frequency by upward zero crossings. */
function freq(x: ArrayLike<number>, sr = SR) {
  let n = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < x.length; i++)
    if (x[i - 1] <= 0 && x[i] > 0) {
      if (first < 0) first = i;
      last = i;
      n++;
    }
  return n > 1 ? ((n - 1) * sr) / (last - first) : 0;
}
/** Count rising edges of a signal watched through a pin. */
function edges(o: Organismo, id: string, seconds: number) {
  let n = 0;
  let prev = false;
  run(o, seconds, () => {
    const hi = pinv(o, id) > 0.5;
    if (hi && !prev) n++;
    prev = hi;
  });
  return n;
}
/** Everything in the voice goes through the master; for voice-level tests, listen to a voice's pin. */
function listen(o: Organismo, id: string, seconds: number) {
  const out: number[] = [];
  run(o, seconds, () => out.push((pinv(o, id) - 0.5) * 2));
  return out;
}
const hold = (o: Organismo, ch: number, v = 1) => o.trigger(ch, v);

// ── the tables ───────────────────────────────────────────────────────────────
check('pins: unique ids', new Set(PINS.map((p) => p.id)).size === PINS.length, `${PINS.length} pins`);
check('controls: unique ids, defaults inside their ranges', new Set(PARAMS.map((p) => p.id)).size === PARAMS.length && PARAMS.every((p) => p.def >= p.min && p.def <= p.max), `${PARAMS.length} controls`);
check('the loop is 128 clock pulses, 96 events to a pulse, 192 to a sixteenth', PULSES === 128 && EVENTS_PER_PULSE === 96 && SIXTEENTH === 192 && LOOP_EVENTS === 12288);
check('four banks of four loops', BANKS === 4);
check('the clock runs from 1 to 200 Hz', spec('clk.temp').min === 1 && spec('clk.temp').max === 200);
{
  let ok = true;
  for (const p of PARAMS) for (const n of [0, 0.2, 0.5, 0.9, 1]) ok &&= near(toNorm(p, fromNorm(p, n)), n, 1e-9) || p.kind === 'choice';
  check('knob space: toNorm(fromNorm(n)) = n for every continuous control', ok);
  check('knob space: attack runs from 0.3 ms to 0.8 s, release from 3 ms to 4 s', rel(fromNorm(spec('bd.att'), 0), 0.0003, 1e-9) && rel(fromNorm(spec('bd.rel'), 1), 4, 1e-9));
  check('format: times and frequencies read well', format(spec('bd.rel'), 0.16) === '160ms' && format(spec('bs.lpf'), 1800) === '1.8k');
}
{
  const e = gridToEvents([[0, 1], [4, 2, 1]]);
  check('a grid note of one sixteenth is 192 events, and its velocity is kept', e[0] === 3 && e[191] === 3 && e[192] === 0 && e[4 * 192] === 1 && e[6 * 192 - 1] === 1 && e[6 * 192] === 0);
  const r = rle(e);
  check('loops run-length code and decode losslessly', unrle(r).every((v, i) => v === e[i]) && r.length < 20, `${r.length} numbers`);
}

// ── patching: nets and types ─────────────────────────────────────────────────
{
  const d = defaults();
  const cp = compile([['bd.out', 'at0.in'], ['at0.in', 'mixin']], d, false);
  check('clips join pins into nets, and a pin can take several clips', cp.of[P('bd.out')] === cp.of[P('mixin')] && cp.of[P('bd.out')] >= 0);
  const cp2 = compile([['v10', 'vca0.cv']], d, false);
  check('an unclipped pin is on no net', cp2.of[P('bd.mod')] === -1 && cp2.of[P('v10')] >= 0);
  const net = cp.nets[cp.of[P('bd.out')]];
  check('audio is centred on 5 volts: a net driven only by audio has baseline 0.5', net.base === 0.5);
  check('a net driven by a control voltage has baseline 0', cp2.nets[cp2.of[P('v10')]].base === 0);
  const cp3 = compile([['bd.out', 'at0.in'], ['at0.out', 'mixin']], d, false);
  check('an attenuator passes its input\'s type on: audio in, audio out', cp3.nets[cp3.of[P('at0.out')]].base === 0.5);
  const cp4 = compile([['lfo.tri', 'at0.in'], ['at0.out', 'bd.mod']], d, false);
  check('...and control in, control out', cp4.nets[cp4.of[P('at0.out')]].base === 0);
  const ext = defaults();
  ext[C('clk.src')] = 1;
  const a = compile([['clk', 'lr0.clk']], defaults(), false);
  const b = compile([['clk', 'lr0.clk']], ext, false);
  check('the clock pin is an output on INT and an input on CLK', a.isSrc[P('clk')] === 1 && b.isSrc[P('clk')] === 0 && b.driven[P('lr0.clk')] === 0);
  const g = compile([['v10', 'gnd'], ['v10', 'vca0.cv']], d, false);
  check('GND is a net like any other, and it is grounded', g.nets[g.of[P('gnd')]].grounded);
}

// ── summing, grounding, and any patch is safe ────────────────────────────────
{
  const o = rig({ at0: 0.3, at1: 0.4 }, [['v10', 'at0.in'], ['v10', 'at1.in'], ['at0.out', 'vca0.cv'], ['at1.out', 'vca0.cv'], ['v10', 'vca0.in']]);
  run(o, 0.02);
  check('several signals clipped to one pin are mixed: 0.3 + 0.4 gives 0.7 of full level', near(pinv(o, 'vca0.out'), 0.7, 0.01), pinv(o, 'vca0.out').toFixed(3));
  const g = rig({}, [['v10', 'gnd'], ['v10', 'vca0.cv'], ['v10', 'vca0.in']]);
  run(g, 0.02);
  check('a source clipped to GND is pulled to zero', near(pinv(g, 'vca0.out'), 0, 1e-9));
}

// ── clock and dividers ───────────────────────────────────────────────────────
{
  const o = rig({ 'clk.temp': 50 });
  const ticks = edges(o, 'clk', 4);
  check('TEMP sets the clock in hertz: 50 Hz gives 200 ticks in 4 s', Math.abs(ticks - 200) <= 1, `${ticks}`);
  const counts = ['div.16', 'div.8', 'div.4', 'div.2', 'div.1', 'div.05', 'div.025'].map((id) => edges(rig({ 'clk.temp': 100 }), id, 5.12));
  // 100 Hz for 5.12 s is 512 ticks: the dividers cut by 2, 4, 8, 16, 32, 64, 128
  const want = [256, 128, 64, 32, 16, 8, 4];
  check('the seven dividers cut by 2, 4, 8, 16, 32, 64 and 128', counts.every((n, i) => Math.abs(n - want[i]) <= 1), counts.join(', '));
  const loop = rig({ 'clk.temp': 200 });
  const ev = edges(loop, 'div.025', 0.64 * 3 + 0.01);
  check('at 200 Hz a loop of 128 ticks is 0.64 s, so the 0.25 divider rises once per loop', ev >= 3 && ev <= 4, `${ev} in 1.93 s`);
  const slow = rig({ 'clk.temp': 1 });
  check('at 1 Hz a loop is 128 s: "several minutes" at the slow end, under a second at the fast', 128 / 1 > 100 && 128 / 200 < 1);

  const mod = rig({ 'clk.temp': 10, 'clk.amt': 1 }, [['v10', 'clk.mod']]);
  const tm = edges(mod, 'clk', 1);
  check('the MOD input with AMT at full multiplies the clock: 10 volts is four octaves up', Math.abs(tm - 160) <= 3, `${tm} ticks in 1 s`);
  void slow;

  // external clock: the manual wants 3 V or more, and the dividers and looper follow it
  const ext = rig({ 'clk.src': 1 }, [['lfo.sq', 'clk']]);
  ext.set(C('lfo.range'), 1);
  ext.set(C('lfo.freq'), 0.5);
  const ex = edges(ext, 'div.16', 2);
  check('with the switch on CLK the dividers follow a clock patched to the pin', ex > 20 && ex < 200, `${ex} edges of the 16 divider in 2 s`);
  const silent = rig({ 'clk.src': 1 });
  check('with the switch on CLK and nothing clipped there, the dividers and looper stop', edges(silent, 'div.16', 1) === 0);

  // RST
  const r = rig({ 'clk.temp': 100 });
  run(r, 0.5);
  r.rst();
  check('RST sends the dividers and the looper back to the start', r.clock.cnt === 0 && r.lr.pulse.every((p) => p === 0));

  // MIDI clock: 24 to a quarter, a 32nd is three
  const m = rig({ 'clk.src': 2 });
  let t = 0;
  for (let i = 0; i < 24; i++) {
    m.midiClock();
    run(m, 0.005, () => {
      if (m.clock.edge) t++;
    });
  }
  check('MIDI clock: 24 pulses make a quarter note, which is 8 ticks', t === 8, `${t}`);
}

// ── the looper ───────────────────────────────────────────────────────────────
{
  // 100 Hz: a pulse is 480 samples, so an event is 5 samples
  const base = { 'clk.temp': 100, 'lr0.mode': 0 };
  const o = rig(base);
  o.rst();
  run(o, 0.2);
  const start = o.lr.pulse[0] * 96 + Math.floor(o.lr.sub[0]);
  o.button(0, 'add', true);
  run(o, 0.1);
  o.button(0, 'add', false);
  const end = o.lr.pulse[0] * 96 + Math.floor(o.lr.sub[0]);
  const m = o.lr.mem[0][0];
  let first = -1;
  let count = 0;
  for (let i = 0; i < LOOP_EVENTS; i++)
    if (m[i]) {
      if (first < 0) first = i;
      count++;
    }
  check('ADD records where a note starts and how long it lasts, not just a trigger', first >= start - 2 && first <= start + 12 && Math.abs(count - (end - start)) <= 12, `${count} events for a 0.1 s touch (expected ~${end - start})`);
  check('the default velocity is the maximum', m[first] === 3);

  // velocity sensors
  const v = rig(base);
  v.rst();
  run(v, 0.05);
  v.rcButton('L', true);
  v.button(0, 'add', true);
  run(v, 0.02);
  v.button(0, 'add', false);
  v.rcButton('L', false);
  v.rcButton('M', true);
  run(v, 0.03);
  v.button(0, 'add', true);
  run(v, 0.02);
  v.button(0, 'add', false);
  v.rcButton('M', false);
  v.rcButton('L', true);
  v.rcButton('M', true);
  run(v, 0.03);
  v.button(0, 'add', true);
  run(v, 0.02);
  v.button(0, 'add', false);
  const seen = new Set<number>();
  for (const x of v.lr.mem[0][0]) if (x) seen.add(x);
  check('L records a low velocity, M a middle one, and L and M together the highest', seen.has(1) && seen.has(2) && seen.has(3), [...seen].join(','));

  // overdub and erase
  const d = rig({ ...base, 'lr1.mode': 0 });
  d.lr.mem[0][1].set(gridToEvents([[0, 8]]));
  d.rst();
  d.button(1, 'del', true);
  run(d, 0.1);
  d.button(1, 'del', false);
  run(d, 0.05);
  const left = d.lr.mem[0][1].reduce((a, b) => a + (b ? 1 : 0), 0);
  const total = 8 * SIXTEENTH;
  check('in REC, DEL erases notes only while it is held, as the loop passes them', left < total * 0.8 && left > total * 0.2, `${left} of ${total} events left`);

  // PLAY mode: ADD plays over the loop without changing it; DEL mutes without changing it
  const pl = rig({ 'clk.temp': 100, 'lr0.mode': 2 });
  pl.lr.mem[0][0].set(gridToEvents([[0, 64]]));
  const before = pl.lr.mem[0][0].slice();
  pl.rst();
  pl.button(0, 'add', true);
  run(pl, 0.1);
  pl.button(0, 'add', false);
  pl.button(0, 'del', true);
  run(pl, 0.1);
  const out1 = pl.lr.out[0];
  pl.button(0, 'del', false);
  check('in PLAY the loop is not changed by ADD or DEL, and DEL mutes what plays', pl.lr.mem[0][0].every((x, i) => x === before[i]) && out1 === 0);
  const mu = rig({ 'clk.temp': 100, 'lr0.mode': 1 });
  mu.lr.mem[0][0].set(gridToEvents([[0, 64]]));
  mu.rst();
  run(mu, 0.2);
  const mutedOut = mu.lr.out[0];
  const moved = mu.lr.pulse[0] > 5;
  mu.button(0, 'add', true);
  run(mu, 0.01);
  check('in the middle position the loop is muted but keeps moving, and ADD simply plays the voice', mutedOut === 0 && moved && mu.lr.out[0] > 0);

  // the loop repeats every 128 pulses
  const rp = rig({ 'clk.temp': 200, 'lr0.mode': 2 });
  rp.lr.mem[0][0].set(gridToEvents([[8, 2]]));
  rp.rst();
  let hits = 0;
  let prev = 0;
  run(rp, 0.64 * 3.1, () => {
    const now = rp.lr.out[0];
    if (now > 0 && prev === 0) hits++;
    prev = now;
  });
  check('a loop plays through and repeats: one note, three loops, three hits', hits === 3, `${hits}`);

  // a loop longer or shorter by LRST
  const sh = rig({ 'clk.temp': 200, 'lr0.mode': 2 }, [['div.1', 'lr.rst']]);
  sh.rst();
  let maxPulse = 0;
  run(sh, 1, () => {
    maxPulse = Math.max(maxPulse, sh.lr.pulse[0]);
  });
  check('LRST joined to a lower divider shortens the loop: the 1 divider restarts it every 32 pulses', maxPulse <= 33 && maxPulse >= 29, `longest ${maxPulse}`);

  // an individual clock
  const own = rig({ 'clk.temp': 100, 'lr0.mode': 2 }, [['lfo.sq', 'lr0.clk']]);
  own.set(C('lfo.range'), 1);
  own.set(C('lfo.freq'), 0.3);
  own.rst();
  run(own, 1);
  check('a CLK pin gives a looper its own clock, so channels can run at different speeds', own.lr.pulse[0] > 3 && own.lr.pulse[0] < 90 && own.lr.pulse[1] > 90, `looper 1 at pulse ${own.lr.pulse[0]} while looper 2 is at ${own.lr.pulse[1]}`);

  // banks
  const bk = rig({ 'clk.temp': 100, 'lr0.mode': 0 });
  bk.lr.mem[0][0].set(gridToEvents([[0, 4]]));
  bk.rcButton('BANK', true);
  bk.button(2, 'add', true);
  bk.button(2, 'add', false);
  bk.rcButton('BANK', false);
  check('BANK with a channel\'s ADD selects that bank', bk.lr.bank === 2);
  check('each bank holds its own four loops', bk.lr.mem[2][0].every((x) => x === 0) && bk.lr.mem[0][0][0] === 3);

  // copying a bank on the fly
  const cp = rig({ 'clk.temp': 200, 'lr0.mode': 0, 'lr1.mode': 0, 'lr2.mode': 0, 'lr3.mode': 0 });
  cp.lr.mem[0][0].set(gridToEvents([[0, 2], [30, 2]]));
  cp.rst();
  cp.rcButton('BANK', true);
  cp.button(1, 'add', true);
  cp.button(1, 'del', true);
  run(cp, 0.7);
  cp.button(1, 'add', false);
  cp.button(1, 'del', false);
  cp.rcButton('BANK', false);
  const copied = cp.lr.mem[1][0].reduce((a, b) => a + (b ? 1 : 0), 0);
  check('BANK with ADD and DEL copies the previous bank into the new one for as long as it is held', cp.lr.bank === 1 && copied >= 2 * 2 * SIXTEENTH * 0.9, `${copied} events copied`);

  // stop and start from a section
  const st = rig({ 'clk.temp': 200 });
  st.rcButton('BANK', true);
  st.rcButton('L', true);
  const stopped = !st.lr.running;
  st.rcButton('L', false);
  st.rcButton('M', true);
  st.button(2, 'add', true);
  const from = st.lr.pulse[0];
  check('BANK with L stops the looper', stopped);
  check('BANK, M and a sensor start it from one of eight sections: ADD of the third channel is section 4, pulse 64', st.lr.running && from === 64, `pulse ${from}`);

  // quantise
  const q = rig({ 'clk.temp': 200, 'lr0.mode': 2 });
  q.lr.mem[0][0].set(gridToEvents([[1.3, 0.9]]));
  q.rcButton('BANK', true);
  q.rcButton('L', true);
  q.rcButton('M', true);
  q.button(0, 'add', true);
  const m2 = q.lr.mem[0][0];
  let a = -1;
  let b = -1;
  for (let i = 0; i < LOOP_EVENTS; i++) if (m2[i]) {
    if (a < 0) a = i;
    b = i + 1;
  }
  check('BANK, L, M and a sensor quantise that channel to sixteenth notes, and stop the looper', a % SIXTEENTH === 0 && b % SIXTEENTH === 0 && !q.lr.running, `from ${a / SIXTEENTH} to ${b / SIXTEENTH} sixteenths`);

  // with the clock stopped, ADD plays the voice
  const dead = rig({ 'clk.src': 1, 'lr0.mode': 0 });
  dead.button(0, 'add', true);
  run(dead, 0.02);
  check('with the clock stopped the sensor simply triggers the voice', dead.lr.out[0] === 1);

  // dump and load
  const ld = rig({});
  ld.lr.mem[2][3].set(gridToEvents([[5, 3, 2]]));
  const dump = ld.loops();
  const ld2 = rig({});
  ld2.setLoops(dump);
  check('loops dump to run-length code and load back', ld2.lr.mem[2][3].every((x, i) => x === ld.lr.mem[2][3][i]));
}

// ── envelopes ────────────────────────────────────────────────────────────────
{
  const o = rig({ 'bd.att': 0.01, 'bd.rel': 0.1 });
  let at63 = -1;
  hold(o, 0, 1);
  run(o, 0.2, (i) => {
    if (at63 < 0 && o.ov[P('env0')] >= 0.632) at63 = i / SR;
  });
  const sustained = o.ov[P('env0')];
  check('an AR envelope rises with the attack time, and holds while the trigger does', near(at63, 0.01, 0.003) && sustained > 0.99, `63% at ${(at63 * 1000).toFixed(1)} ms, holds at ${sustained.toFixed(2)}`);
  hold(o, 0, 0);
  let atDrop = -1;
  run(o, 0.5, (i) => {
    if (atDrop < 0 && o.ov[P('env0')] <= 0.368) atDrop = i / SR;
  });
  check('...and falls with the release time', near(atDrop, 0.1, 0.01), `${(atDrop * 1000).toFixed(0)} ms`);

  // "the strongest signal": 2 V, 5 V and 7 V
  const s = rig({ 'bd.att': 0.001, 'bd.rel': 0.001 }, [['v10', 'at0.in'], ['at0.out', 'trig0']]);
  s.set(C('at0'), 0.2);
  hold(s, 0, 0.5);
  run(s, 0.05);
  const a1 = s.ov[P('env0')];
  const s2 = rig({ 'bd.att': 0.001, 'bd.rel': 0.001 }, [['v10', 'at0.in'], ['at0.out', 'trig0']]);
  s2.set(C('at0'), 0.7);
  hold(s2, 0, 0.5);
  run(s2, 0.05);
  const a2 = s2.ov[P('env0')];
  hold(s2, 0, 0);
  s2.set(C('at0'), 0.2);
  run(s2, 0.05);
  const a3 = s2.ov[P('env0')];
  check('the envelope answers the strongest of the looper, MIDI and the TRIG pin, and falls back to a weaker one when the strongest stops', near(a1, 0.5, 0.02) && near(a2, 0.7, 0.02) && near(a3, 0.2, 0.02), `${a1.toFixed(2)}, ${a2.toFixed(2)}, ${a3.toFixed(2)}`);

  // a trigger pin is the looper's output and the envelope's input at once, and joined pins mix
  const t = rig({ 'lr0.mode': 2 }, [['trig0', 'trig1']]);
  t.lr.mem[0][0].fill(3);
  run(t, 0.02);
  check('TRIG is the looper\'s output as well as the envelope\'s input: clipped to another voice\'s TRIG it triggers that voice', t.gate[1] > 0.9, t.gate[1].toFixed(2));
}

// ── the voices ───────────────────────────────────────────────────────────────
{
  // bass drum
  const kick = rig({ 'bd.att': 0.0003, 'bd.rel': 0.5, 'bd.tune': 0.35, 'bd.pitch': 0.5, 'bd.drive': 0.5 });
  hold(kick, 0, 1);
  const w = listen(kick, 'bd.out', 0.6);
  const early = freq(w.slice(0, Math.round(SR * 0.05)));
  const late = freq(w.slice(Math.round(SR * 0.4)));
  const tuneHz = 28 * Math.pow(2, 0.35 * 3.2);
  check('BD: PITCH makes the pitch jump at the start of the sound, settling on TUNE', early > late * 1.5 && rel(late, tuneHz, 0.06), `${early.toFixed(0)} Hz falling to ${late.toFixed(1)} (TUNE ${tuneHz.toFixed(1)})`);
  const flat = rig({ 'bd.att': 0.0003, 'bd.rel': 0.5, 'bd.pitch': 0 });
  hold(flat, 0, 1);
  const wf = listen(flat, 'bd.out', 0.4);
  check('BD: with PITCH down the jump nearly disappears', freq(wf.slice(0, Math.round(SR * 0.05))) < freq(wf.slice(Math.round(SR * 0.3))) * 1.5);
  const harm = (drive: number) => {
    const r = rig({ 'bd.att': 0.0003, 'bd.rel': 2, 'bd.pitch': 0, 'bd.tune': 0.5, 'bd.drive': drive });
    hold(r, 0, 1);
    const x = listen(r, 'bd.out', 0.5).slice(Math.round(SR * 0.15));
    const f0 = freq(x);
    return { f0, h3: goertzel(x, f0 * 3) / Math.max(1e-9, goertzel(x, f0)) };
  };
  const tri = harm(0);
  const sine = harm(0.5);
  const sq = harm(1);
  check('BD: DRIVE turns the waveform from triangle to sine to square', sine.h3 < 0.03 && tri.h3 > 0.07 && tri.h3 < 0.14 && sq.h3 > 0.25, `third harmonic ${tri.h3.toFixed(3)} (triangle, ~1/9), ${sine.h3.toFixed(3)} (sine), ${sq.h3.toFixed(3)} (square, ~1/3)`);
  const modk = rig({ 'bd.att': 0.0003, 'bd.rel': 2, 'bd.pitch': 0, 'bd.tune': 0.35, 'bd.amt': 0.5, 'bd.drive': 0.5 }, [['v10', 'bd.mod']]);
  hold(modk, 0, 1);
  const fm = freq(listen(modk, 'bd.out', 0.5).slice(Math.round(SR * 0.15)));
  check('BD: the MOD input is linear in volts per hertz, and AMT sets how much', rel(fm, tuneHz + 0.5 * 600, 0.06), `${fm.toFixed(0)} Hz, expected ${(tuneHz + 300).toFixed(0)}`);

  // bass
  const bass = (set: Record<string, number>, cables: Cable[] = []) => {
    const r = rig({ 'bs.att': 0.0003, 'bs.rel': 2, 'bs.lpf': 18000, 'bs.q': 0, 'bs.warp': 0, ...set }, cables);
    return r;
  };
  const b0 = bass({ 'bs.tune': 0, 'bs.shape': 0 });
  hold(b0, 1, 1);
  const f0 = freq(listen(b0, 'bs.out', 0.3).slice(Math.round(SR * 0.1)));
  check('BASS: in CV mode TUNE spans five octaves, the bottom being 32.7 Hz', rel(f0, 32.7, 0.04), `${f0.toFixed(1)} Hz`);
  const b1 = bass({ 'bs.tune': 0, 'bs.shape': 0, 'at0': 0.2 }, [['v10', 'at0.in'], ['at0.out', 'bs.cv']]);
  hold(b1, 1, 1);
  const f2 = freq(listen(b1, 'bs.out', 0.3).slice(Math.round(SR * 0.1)));
  check('BASS: CV IN is one volt per octave over 0 to 4 volts: 2 volts is two octaves up', rel(f2, 130.8, 0.04), `${f2.toFixed(1)} Hz`);
  const b2 = bass({ 'bs.mode': 1, 'bs.tune': 0.5, 'bs.shape': 0 });
  b2.note(57, 1, true);
  const f3 = freq(listen(b2, 'bs.out', 0.4).slice(Math.round(SR * 0.15)));
  check('BASS: in MIDI mode it is a chromatic keyboard: note 57 is 220 Hz', rel(f3, 220, 0.03), `${f3.toFixed(1)} Hz`);
  const b3 = bass({ 'bs.mode': 1, 'bs.tune': 1, 'bs.shape': 0 });
  b3.note(57, 1, true);
  const f4 = freq(listen(b3, 'bs.out', 0.4).slice(Math.round(SR * 0.15)));
  check('BASS: TUNE moves a MIDI note by half a tone', rel(f4, 220 * Math.pow(2, 0.5 / 12), 0.01), `${f4.toFixed(1)} Hz`);
  const b4 = bass({ 'bs.mode': 1, 'bs.tune': 0.5, 'bs.shape': 0 });
  b4.note(57, 1, true);
  b4.bend(1);
  const f5 = freq(listen(b4, 'bs.out', 0.5).slice(Math.round(SR * 0.2)));
  check('BASS: the pitch bender reaches 12 semitones', rel(f5, 440, 0.03), `${f5.toFixed(1)} Hz`);
  const b5 = bass({ 'bs.mode': 1, 'bs.tune': 0.5, 'bs.shape': 0 });
  b5.cc(5, 1);
  b5.note(45, 1, true);
  run(b5, 0.2);
  b5.note(57, 1, true);
  const fq = listen(b5, 'bs.out', 0.1);
  const fast = bass({ 'bs.mode': 1, 'bs.tune': 0.5, 'bs.shape': 0 });
  fast.note(45, 1, true);
  run(fast, 0.2);
  fast.note(57, 1, true);
  const fs = listen(fast, 'bs.out', 0.1);
  check('BASS: portamento from controller 5 glides between notes, and without it the pitch jumps', freq(fq.slice(0, 2000)) < freq(fs.slice(0, 2000)) * 0.9 || freq(fs) > 150, `${freq(fq).toFixed(0)} against ${freq(fs).toFixed(0)}`);
  const rich = (shape: number) => {
    const r = bass({ 'bs.tune': 0.2, 'bs.shape': shape });
    hold(r, 1, 1);
    const x = listen(r, 'bs.out', 0.4).slice(Math.round(SR * 0.1));
    const f = freq(x);
    let h = 0;
    for (let k = 2; k <= 12; k++) h += goertzel(x, f * k) ** 2;
    return Math.sqrt(h) / goertzel(x, f);
  };
  const r0 = rich(0);
  const r1 = rich(0.6);
  const r2 = rich(1);
  check('BASS: turning SHAPE clockwise raises the level of harmonics', r0 < 0.05 && r1 > r0 * 5 && r2 > r1 * 0.8, `${r0.toFixed(3)}, ${r1.toFixed(3)}, ${r2.toFixed(3)}`);
  const lpf = (fc: number) => {
    const r = bass({ 'bs.tune': 0.2, 'bs.shape': 0.8, 'bs.lpf': fc });
    hold(r, 1, 1);
    const x = listen(r, 'bs.out', 0.3).slice(Math.round(SR * 0.1));
    const f = freq(x);
    let h = 0;
    for (let k = 20; k <= 40; k++) h += goertzel(x, f * k) ** 2;
    return Math.sqrt(h);
  };
  check('BASS: LPF FR closes the filter, taking the upper harmonics away', lpf(200) < lpf(8000) * 0.1, `${db(lpf(200) / lpf(8000)).toFixed(0)} dB`);
  const selfOsc = bass({ 'bs.tune': 0.2, 'bs.shape': 0, 'bs.lpf': 800, 'bs.q': 1, 'bs.warp': 0 });
  hold(selfOsc, 1, 1);
  const xo = listen(selfOsc, 'bs.out', 0.6).slice(Math.round(SR * 0.3));
  check('BASS: the resonant filter stays stable at full resonance', xo.every(Number.isFinite) && maxAbs(xo) < 1.01);
  const prc = rig({ 'bs.mode': 2, 'bs.att': 0.0003, 'bs.rel': 0.4, 'bs.shape': 0.5, 'bs.tune': 0.25, 'bs.lpf': 18000, 'bs.warp': 0 });
  hold(prc, 1, 1);
  const wp = listen(prc, 'bs.out', 0.5);
  check('BASS: in PRC it is a percussion voice, with a pitch dive at the start', freq(wp.slice(0, Math.round(SR * 0.03))) > freq(wp.slice(Math.round(SR * 0.3))) * 1.3);

  // snare
  const sd = (set: Record<string, number>) => {
    const r = rig({ 'sd.att': 0.0003, 'sd.rel': 0.4, 'sd.q': 0.2, ...set });
    hold(r, 2, 1);
    return listen(r, 'sd.out', 0.4);
  };
  const clapNone = sd({ 'sd.clap': 0 });
  const clapFull = sd({ 'sd.clap': 1 });
  const envPeaks = (x: number[]) => {
    const win = 240;
    const e: number[] = [];
    for (let i = 0; i + win < Math.round(SR * 0.2); i += win) e.push(rms(x, i, i + win));
    let peaks = 0;
    for (let i = 1; i < e.length - 1; i++) if (e[i] > e[i - 1] * 1.4 && e[i] > e[i + 1] * 1.05 && e[i] > 0.02) peaks++;
    return peaks;
  };
  check('SD: CLAP splits the attack into bursts', envPeaks(clapFull) > envPeaks(clapNone), `${envPeaks(clapNone)} against ${envPeaks(clapFull)} bursts`);
  const spec2 = (mix: number) => {
    const x = sd({ 'sd.mix': mix, 'sd.q': 0, 'sd.bpf': 9000, 'sd.tune': 0.9 });
    return goertzel(x, 300) / (goertzel(x, 6000) + 1e-9);
  };
  check('SD: MIX moves the balance between spectral and pink noise: pink has more low end', spec2(1) > spec2(0));
  // the noise runs through the band-pass and the envelope follows it, as in an analogue snare; at the top of Q the
  // filter is on the verge of self-oscillation, and a pitched body appears at its centre frequency
  const ringing = sd({ 'sd.q': 1, 'sd.bpf': 1800, 'sd.mix': 0, 'sd.tune': 0.8 }).slice(Math.round(SR * 0.1));
  const damped = sd({ 'sd.q': 0, 'sd.bpf': 1800, 'sd.mix': 0, 'sd.tune': 0.8 }).slice(Math.round(SR * 0.1));
  const peak = (x: number[]) => goertzel(x, 1800) / (goertzel(x, 1100) + goertzel(x, 2800) + 1e-9);
  check('SD: at full BPF Q the filter is on the verge of self-oscillation and the snare gains a pitched body', peak(ringing) > peak(damped) * 4, `${peak(ringing).toFixed(1)} against ${peak(damped).toFixed(2)}`);
  check('SD: everything stays finite at full resonance', ringing.every(Number.isFinite) && maxAbs(ringing) <= 1.01);

  // hat
  const hat = (set: Record<string, number>) => {
    const r = rig({ 'hh.att': 0.0003, 'hh.rel': 0.3, 'hh.q': 0, ...set });
    hold(r, 3, 1);
    return listen(r, 'hh.out', 0.3).slice(Math.round(SR * 0.02));
  };
  const hh = hat({ 'hh.hpf': 8000, 'hh.tune': 0.9 });
  check('HHT: the high-pass takes the low end away', goertzel(hh, 300) < goertzel(hh, 11000) * 0.5 + 1e-9 && rms(hh) > 0.01, `${goertzel(hh, 300).toExponential(1)} against ${goertzel(hh, 11000).toExponential(1)}`);
  const hl = hat({ 'hh.hpf': 1500, 'hh.tune': 0.9 });
  check('HHT: HPF FR moves the cutoff', rms(hl) > rms(hh) * 1.3);
  const warpLo = hat({ 'hh.warp': 0 });
  const warpHi = hat({ 'hh.warp': 1 });
  check('HHT: WARP changes the noise spectrum', Math.abs(rms(warpLo) - rms(warpHi)) > 0.01 || Math.abs(goertzel(warpLo, 7000) - goertzel(warpHi, 7000)) > 0.002);

  // external inputs and volume
  const ext = rig({ 'sd.att': 0.0003, 'sd.rel': 0.3, 'sd.mix': 0, 'sd.tune': 0, 'sd.q': 0, 'sd.bpf': 1800 }, [['bd.out', 'sd.ext']]);
  hold(ext, 2, 1);
  hold(ext, 0, 1);
  run(ext, 0.1);
  check('EXT feeds another source through a voice\'s own filter, ahead of its envelope', rms(listen(ext, 'sd.out', 0.1)) > 0.01);
}

// ── shaos ────────────────────────────────────────────────────────────────────
{
  const seq = (len: number, ticks: number, out = 'sh.1d', extra: Record<string, number> = {}) => {
    const o = rig({ 'sh.freq': 1000, 'sh.len': len, ...extra });
    const vals: number[] = [];
    let prevPhase = o.sr;
    // sample the output once per internal tick
    let acc = 0;
    run(o, ticks / 1000 + 0.001, () => {
      acc++;
      if (acc >= SR / 1000) {
        acc -= SR / 1000;
        vals.push(pinv(o, out));
      }
    });
    void prevPhase;
    return vals;
  };
  const period = (v: number[]) => {
    for (let p = 2; p < v.length / 2; p++) {
      let ok = true;
      for (let i = 0; i + p < v.length; i++)
        if (v[i] !== v[i + p]) {
          ok = false;
          break;
        }
      if (ok) return p;
    }
    return -1;
  };
  const s63 = seq(0, 400).slice(40);
  const s217 = seq(2, 900).slice(40);
  check('SHAOS: the 63 position gives a sequence that repeats every 63 clock pulses', period(s63) === 63, `${period(s63)}`);
  check('SHAOS: the 217 position repeats every 217', period(s217) === 217, `${period(s217)}`);
  const ones = (v: number[], n: number) => v.slice(0, n).reduce((a, b) => a + b, 0);
  check('SHAOS: a 63-step maximal register has 32 ones to 31 zeros', ones(s63, 63) === 32, `${ones(s63, 63)} ones`);

  // 16: cyclic memory written through DATA
  const w = rig({ 'sh.freq': 100, 'sh.len': 1 }, [['lfo.sq', 'sh.data']]);
  w.set(C('lfo.range'), 1);
  w.set(C('lfo.freq'), 0.0);
  run(w, 0.5);
  const pattern: number[] = [];
  let acc = 0;
  run(w, 0.5, () => {
    acc++;
    if (acc >= SR / 100) {
      acc -= SR / 100;
      pattern.push(pinv(w, 'sh.1d'));
    }
  });
  check('SHAOS: with the switch on 16 the register is a cyclic memory that DATA writes into', pattern.length > 30 && pattern.some((x) => x === 1) && pattern.some((x) => x === 0));
  const mem = rig({ 'sh.freq': 1000, 'sh.len': 0 });
  run(mem, 0.1);
  mem.set(C('sh.len'), 1);
  const v16: number[] = [];
  let a2 = 0;
  run(mem, 0.08, () => {
    a2++;
    if (a2 >= SR / 1000) {
      a2 -= SR / 1000;
      v16.push(pinv(mem, 'sh.1d'));
    }
  });
  check('SHAOS: moving the switch to 16 keeps what the register held, as a loop of 16 steps', period(v16.slice(4)) === 16, `${period(v16.slice(4))}`);

  // outputs and resolution
  const o2 = seq(0, 400, 'sh.2d').slice(40);
  const levels2 = new Set(o2.map((x) => Math.round(x * 3)));
  check('SHAOS: the 2-bit output has four levels', levels2.size === 4 && [...levels2].every((l) => l >= 0 && l <= 3), [...levels2].sort().join(','));
  const o3 = seq(0, 600, 'sh.3s').slice(40);
  const levels3 = new Set(o3.map((x) => Math.round(x * 7)));
  check('SHAOS: the 3-bit sample-and-hold output has eight levels', levels3.size === 8, `${levels3.size}`);
  const d1 = seq(0, 300, 'sh.1d').slice(40);
  const d2 = seq(0, 300, 'sh.2d').slice(40);
  check('SHAOS: the outputs are shifted relative to each other and play different sequences', d1.some((x, i) => (d2[i] > 0.5) !== (x > 0.5)));

  // external clock and S/H
  const ext = rig({ 'sh.freq': 1, 'sh.len': 0 }, [['lfo.sq', 'sh.clk']]);
  ext.set(C('lfo.range'), 1);
  ext.set(C('lfo.freq'), 0.4);
  let changes = 0;
  let last = -1;
  run(ext, 1, () => {
    const v = pinv(ext, 'sh.1d');
    if (v !== last) changes++;
    last = v;
  });
  check('SHAOS: an external clock replaces the internal one', changes > 10, `${changes} changes in a second with the internal clock at 1 Hz`);
  const sh = rig({ 'sh.freq': 2000, 'sh.len': 0 }, [['lfo.sq', 'sh.sh']]);
  sh.set(C('lfo.range'), 0);
  sh.set(C('lfo.freq'), 1);
  let changesSh = 0;
  let lastSh = -1;
  run(sh, 1, () => {
    const v = pinv(sh, 'sh.3s');
    if (v !== lastSh) changesSh++;
    lastSh = v;
  });
  check('SHAOS: the S/H outputs change only on pulses applied to the S/H pin, while a fast clock runs behind', changesSh <= 9, `${changesSh} changes against 8 pulses`);
}

// ── lfo ──────────────────────────────────────────────────────────────────────
{
  const f = (range: number, knob: number) => edges(rig({ 'lfo.range': range, 'lfo.freq': knob }), 'lfo.sq', range === 0 ? 20 : 2) / (range === 0 ? 20 : 2);
  const lo = [f(0, 0), f(0, 1)];
  const mid = [f(1, 0), f(1, 1)];
  const hi = [f(2, 0), f(2, 1)];
  check('LFO: three ranges that together reach from 0.1 Hz to 5 kHz', near(lo[0], 0.1, 0.06) && rel(lo[1], 8, 0.05) && rel(mid[0], 4, 0.05) && rel(mid[1], 400, 0.03) && rel(hi[0], 200, 0.03) && rel(hi[1], 5000, 0.03), `${lo.map((x) => x.toFixed(2))} · ${mid.map((x) => x.toFixed(0))} · ${hi.map((x) => x.toFixed(0))}`);
  const shape = (w: number) => {
    const o = rig({ 'lfo.range': 1, 'lfo.freq': 0, 'lfo.wave': w });
    const x: number[] = [];
    run(o, 0.25, () => x.push(pinv(o, 'lfo.tri')));
    // time of the maximum within one period (0.25 s at 4 Hz)
    const k = x.indexOf(Math.max(...x.slice(0, 11900)));
    return k / 12000;
  };
  check('LFO: the waveform knob runs from a falling saw through a triangle to a rising saw', shape(0.001) < 0.03 && near(shape(0.5), 0.5, 0.03) && shape(0.999) > 0.97, `peak at ${shape(0.001).toFixed(2)}, ${shape(0.5).toFixed(2)}, ${shape(0.999).toFixed(2)} of the period`);
  const sq = rig({ 'lfo.range': 1, 'lfo.freq': 0.5 });
  let dutyHi = 0;
  const n = SR;
  run(sq, 1, () => {
    if (pinv(sq, 'lfo.sq') > 0.5) dutyHi++;
  });
  check('LFO: the square output is a square', near(dutyHi / n, 0.5, 0.02));
  const sy = rig({ 'lfo.range': 0, 'lfo.freq': 0.2 }, [['div.16', 'lfo.sync']]);
  sy.set(C('clk.temp'), 1);
  let resets = 0;
  let prevTri = 0;
  run(sy, 4, () => {
    const t = pinv(sy, 'lfo.tri');
    if (t < 0.02 && prevTri > 0.2) resets++;
    prevTri = t;
  });
  check('LFO: a rising edge on SYNC resets it to zero', resets >= 1, `${resets} resets`);
  const md = edges(rig({ 'lfo.range': 1, 'lfo.freq': 0, 'lfo.amt': 1 }, [['v10', 'lfo.mod']]), 'lfo.sq', 1);
  check('LFO: MOD with AMT at full raises the frequency by five octaves for 10 volts', rel(md, 4 * 32, 0.1), `${md} Hz`);
}

// ── the small parts ──────────────────────────────────────────────────────────
{
  const inv = rig({}, [['v10', 'inv.in'], ['inv.out', 'vca0.in'], ['v10', 'vca0.cv']]);
  run(inv, 0.01);
  check('INV turns a control voltage over, about 5 volts: 10 volts in, 0 out', near(pinv(inv, 'inv.out'), 0, 0.001));
  const inv0 = rig({});
  run(inv0, 0.01);
  check('...and 0 volts in, 10 out', near(pinv(inv0, 'inv.out'), 1, 0.001));
  const tt = (a: number, c: number) => {
    const cables: Cable[] = [];
    if (a) cables.push(['v10', 'cinv.in']);
    if (c) cables.push(['v10', 'cinv.cv']);
    const r = rig({}, cables);
    run(r, 0.01);
    return pinv(r, 'cinv.out');
  };
  check('the controlled inverter inverts a trigger only when CV is above 5 volts, and only 0 or 10 volts come out', tt(0, 0) === 0 && tt(1, 0) === 1 && tt(0, 1) === 1 && tt(1, 1) === 0);
  const sw = (cv: number) => {
    const r = rig({}, [['v10', 'sw0.in'], ...(cv ? ([['v10', 'sw0.cv']] as Cable[]) : [])]);
    run(r, 0.01);
    return pinv(r, 'sw0.out');
  };
  check('a switch closes above 5 volts on CV', sw(1) === 1 && sw(0) === 0);
  const pc = rig({}, [['lfo.sq', 'pc0.in']]);
  pc.set(C('lfo.range'), 0);
  pc.set(C('lfo.freq'), 1);
  let width = 0;
  let widths = 0;
  let pulses = 0;
  let up = false;
  run(pc, 2, () => {
    const v = pinv(pc, 'pc0.out');
    if (v > 0.37) {
      width++;
      if (!up) pulses++;
      up = true;
    } else if (up) {
      widths += width;
      width = 0;
      up = false;
    }
  });
  const avgMs = (widths / Math.max(1, pulses - 1) / SR) * 1000;
  check('a pulse converter turns each rising edge into a short pulse', pulses >= 14 && avgMs < 6 && avgMs > 1, `${pulses} pulses, about ${avgMs.toFixed(1)} ms above 3.7 V`);

  // the diode, as the manual uses it: anode on a TRIG output, cathode on the LFO's triangle
  const dio = rig({ 'lr0.mode': 2, 'lfo.range': 0, 'lfo.freq': 0.4 }, [['trig0', 'dio.a'], ['dio.k', 'lfo.tri']]);
  dio.lr.mem[0][0].fill(3);
  const seen: number[] = [];
  run(dio, 3, () => seen.push(dio.gate[0]));
  const spread = maxOf(seen, 5000) - minOf(seen, 5000);
  check('a diode from a TRIG output to the LFO lets the LFO set the velocity: the voice follows it', spread > 0.3 && maxOf(seen) <= 1, `velocity wanders over ${spread.toFixed(2)}`);

  // capacitors
  const hp = (id: string, tauWant: number) => {
    const r = rig({}, [['lfo.sq', `${id}.a`], [`${id}.b`, 'vca0.cv']]);
    r.set(C('lfo.range'), 0);
    r.set(C('lfo.freq'), 0);
    const x: number[] = [];
    run(r, 3, () => x.push(pinv(r, `${id}.b`)));
    const peak = maxOf(x);
    const at = x.indexOf(peak);
    let k = at;
    while (k < x.length && x[k] > peak * 0.368) k++;
    return { peak, tau: (k - at) / SR, tauWant };
  };
  const c1 = hp('cap1', 0.01);
  const c2 = hp('cap2', 1);
  check('a series capacitor turns each jump into a falling envelope: quick for 0.1 µF, slow for 10 µF', rel(c1.tau, 0.01, 0.35) && rel(c2.tau, 1, 0.35) && c1.peak > 0.6, `${(c1.tau * 1000).toFixed(1)} ms and ${c2.tau.toFixed(2)} s`);
  const lp = (id: string) => {
    const r = rig({}, [['v10', 'at0.in'], ['at0.out', 'vca0.cv'], [`${id}.a`, 'vca0.cv'], [`${id}.b`, 'gnd']]);
    r.set(C('at0'), 1);
    let t90 = -1;
    run(r, 1, (i) => {
      if (t90 < 0 && pinv(r, 'vca0.cv') >= 0.9) t90 = i / SR;
    });
    const probe = rig({}, [['v10', 'at0.in'], ['at0.out', 'vca0.cv'], [`${id}.a`, 'vca0.cv'], [`${id}.b`, 'gnd']]);
    let reading = 0;
    run(probe, 0.2, () => (reading = probe.iv[P('vca0.cv')]));
    return reading;
  };
  const sl = lp('cap2');
  const sf = lp('cap1');
  check('a capacitor from a signal to GND is a low-pass: it softens a control signal, more for 10 µF', sl < sf, `after 0.2 s: ${sf.toFixed(2)} for 0.1 µF, ${sl.toFixed(2)} for 10 µF`);
}

// ── effects ──────────────────────────────────────────────────────────────────
{
  const echo = (set: Record<string, number>, cables: Cable[] = [], seconds = 1.2, inputPin: 'fx.dly.in' | 'fx.rev.in' = 'fx.dly.in') => {
    // a click into the delay, through an attenuator-less path: drive a jack-less source by an envelope pin
    const o = rig(set, [['bd.out', inputPin], ...cables]);
    o.set(C('bd.att'), 0.0003);
    o.set(C('bd.rel'), 0.004);
    o.set(C('bd.tune'), 0.9);
    o.set(C('bd.pitch'), 0);
    o.set(C('bd.drive'), 1);
    o.set(C('bd.vol'), 0);
    o.set(C('fx.dlyout'), 1);
    o.set(C('fx.revout'), 1);
    o.trigger(0, 1);
    const out: number[] = [];
    const rv: number[] = [];
    run(o, seconds, (i) => {
      if (i === 400) o.trigger(0, 0);
      out.push((pinv(o, 'fx.dly.out') - 0.5) * 2);
      rv.push((pinv(o, 'fx.rev.out') - 0.5) * 2);
    });
    return { dly: out, rev: rv, o };
  };
  const firstEcho = (x: number[], after = 3000) => {
    const peak = maxAbs(x, after);
    const k = x.findIndex((v, i) => i > after && Math.abs(v) > peak * 0.5);
    return k / SR;
  };
  const e1 = echo({ 'fx.mode': 0, 'fx.time': 0.5, 'fx.fb': 0.4, 'fx.tune': 0.7 });
  // time 0.5: 128 * 2^4 = 2048 DSP samples at 32 kHz = 64 ms
  const t1 = firstEcho(e1.dly, 400 + 1500);
  check('FX: the delay time follows the TIME knob in DSP time (0.5 is 2048 samples at 32 kHz, 64 ms)', rel(t1, 0.064 + 0.0125, 0.45) && t1 > 0.05, `first echo at ${(t1 * 1000).toFixed(0)} ms`);
  const e2 = echo({ 'fx.mode': 0, 'fx.time': 0.5, 'fx.fb': 0.4, 'fx.tune': 0.7, 'fx.clkmod': 1 }, [['v10', 'fx.clkmod']]);
  const t2 = firstEcho(e2.dly, 400 + 1500);
  check('FX: slowing the DSP clock stretches every delay, the whole processor running up to seven times slower', t2 / t1 > 4.5 && t2 / t1 < 8.5, `${(t2 / t1).toFixed(1)}× longer`);
  // in BPF mode the feedback goes through a band-pass, so put its centre (150 Hz up, TUNE in octaves) where the click's energy is
  const e3 = echo({ 'fx.mode': 0, 'fx.time': 0.55, 'fx.fb': 0, 'fx.tune': 0.09 });
  const e4 = echo({ 'fx.mode': 0, 'fx.time': 0.55, 'fx.fb': 0.85, 'fx.tune': 0.09 });
  const tail0 = rms(e3.dly, Math.round(SR * 0.4), Math.round(SR * 1.2));
  const tail1 = rms(e4.dly, Math.round(SR * 0.4), Math.round(SR * 1.2));
  check('FX: FB sets how long the repeats last', tail1 > tail0 * 5 + 1e-5 && tail1 > 1e-4, `${tail0.toExponential(1)} without, ${tail1.toExponential(1)} with`);
  const dbl = echo({ 'fx.mode': 1, 'fx.time': 0.4, 'fx.tune': 0.7, 'fx.fb': 0 });
  const x = dbl.dly.map(Math.abs);
  const pk = maxOf(x, 2000);
  const hits: number[] = [];
  for (let i = 2000; i < x.length; i++) if (x[i] > pk * 0.4 && (hits.length === 0 || i - hits[hits.length - 1] > 3000)) hits.push(i);
  check('FX: in DBL the first channel is a two-tap delay', hits.length >= 2, `${hits.length} echoes`);
  const st = echo({ 'fx.mode': 1, 'fx.time': 0.4, 'fx.tune': 0.7, 'fx.fb': 0.3 }, [['v10', 'fx.mad']]);
  let differ = 0;
  for (let i = 0; i < st.dly.length; i++) differ += Math.abs(st.dly[i] - st.rev[i]);
  check('FX: in DBL, MAD! turns on stereo, and the two outputs become left and right', differ > 0.1, `${differ.toFixed(1)}`);
  const pch = echo({ 'fx.mode': 2, 'fx.time': 0.3, 'fx.tune': 1, 'fx.fb': 0.7 });
  check('FX: in PCH the delay has a pitch shifter in its feedback, and stays stable', pch.dly.every(Number.isFinite) && maxAbs(pch.dly) < 3);
  const mad = echo({ 'fx.mode': 0, 'fx.time': 0.3, 'fx.tune': 0.5, 'fx.fb': 0.9 }, [['v10', 'fx.mad']], 2);
  check('FX: MAD! in BPF mode makes the processor misbehave without ever blowing up', mad.dly.every(Number.isFinite) && maxAbs(mad.dly) < 3 && rms(mad.dly) > rms(echo({ 'fx.mode': 0, 'fx.time': 0.3, 'fx.tune': 0.5, 'fx.fb': 0.9 }, [], 2).dly));
  const hall = (fb: number) => {
    const r = echo({ 'fx.mode': 0, 'fx.fb': fb }, [], 4, 'fx.rev.in');
    const e = (a: number, b: number) => rms(r.rev, Math.round(SR * a), Math.round(SR * b));
    return { early: e(0.3, 0.6), late: e(2.5, 3.5), r: r.rev };
  };
  const h1 = hall(0.2);
  const h2 = hall(0.9);
  check('FX: FB sets the decay of the hall', h2.late > h1.late * 4 && h2.early > 0.002, `late level ${h1.late.toFixed(4)} against ${h2.late.toFixed(4)}`);
  check('FX: the reverb is mono, and both channels stay finite', h2.r.every(Number.isFinite));
  const clip = rig({}, [['v10', 'fx.dly.in']]);
  run(clip, 0.01);
  check('FX: the CLIP lamp lights when the converter\'s input is overloaded', clip.clip === true);
}

// ── the mixer ────────────────────────────────────────────────────────────────
{
  const mix = (set: Record<string, number>) => {
    const o = rig({ 'bd.att': 0.0003, 'bd.rel': 1, 'bd.vol': 0.8, ...set });
    hold(o, 0, 1);
    return rms(render(o, 0.5).L, 5000);
  };
  check('MASTER VOLUME scales the output', mix({ vol: 0.6 }) > mix({ vol: 0.3 }) * 1.6);
  check('a voice\'s VOL knob sets its level in the mix, and zero takes it out', mix({ 'bd.vol': 0 }) < 1e-4 && mix({ 'bd.vol': 0.8 }) > 0.05);
  // FX sends are before the volume knob
  const send = rig({ 'bd.att': 0.0003, 'bd.rel': 0.05, 'bd.vol': 0, 'bd.fx': 1, 'fx.route': 0, 'fx.mode': 0, 'fx.time': 0.3, 'fx.fb': 0.5, 'fx.dlyout': 1 });
  hold(send, 0, 1);
  const rs = render(send, 0.6);
  check('the FX send is taken before the volume knob, so a voice can be heard only through the effect', rms(rs.L, 8000) > 0.005, rms(rs.L, 8000).toFixed(4));
  const dist = (m: number) => {
    const o = rig({ 'bd.att': 0.0003, 'bd.rel': 1, 'bd.vol': 0.3, 'dist.drive': 1, 'dist.mix': m });
    hold(o, 0, 1);
    const x = render(o, 0.4).L.slice(8000);
    return { r: rms(x), h3: goertzel(x, freq(x) * 3) };
  };
  check('the distortion is parallel: MIX blends clear and distorted sound', dist(1).r > dist(0).r && dist(0).r > 0.01);
  const mixin = rig({ vol: 0.6 }, [['noise', 'mixin']]);
  check('MIX IN adds an outside signal to the main mix', rms(render(mixin, 0.3).L, 3000) > 0.005);
  const ext = rig({ vol: 0.6 }, [['noise', 'j1']]);
  check('the first adapter pin is the left output of the external mixer', rms(render(ext, 0.3).L, 3000) > 0.003 && rms(render(ext, 0.3).R, 3000) < 0.0001);
}

// ── the whole machine ────────────────────────────────────────────────────────
{
  const make = () => {
    const o = rig({ 'clk.temp': 16 }, [['div.025', 'lr.rst']]);
    o.lr.mem[0][0].set(gridToEvents([0, 4, 8, 12, 16, 20, 24, 28].map((s) => [s * 2, 1, 3])));
    o.lr.mem[0][2].set(gridToEvents([4, 12, 20, 28].map((s) => [s * 2, 1, 3])));
    o.lr.mem[0][3].set(gridToEvents(Array.from({ length: 32 }, (_, i) => [i * 2 + 1, 0.3, 2])));
    return o;
  };
  const a = render(make(), 3, 128);
  const b = render(make(), 3, 480);
  let same = true;
  for (let i = 0; i < a.L.length; i++) same &&= a.L[i] === b.L[i] && a.R[i] === b.R[i];
  check('the same patch plays the same, sample for sample, whatever the block size', same);
  check('with nothing patched it is a drum machine: clock, looper, voices, FX, output', rms(a.L) > 0.02 && a.L.every(Number.isFinite));
  const rates = [44100, 48000, 96000].map((sr) => {
    const o = new Organismo(sr);
    o.set(C('clk.temp'), 20);
    let n = 0;
    const L = new Float32Array(1);
    for (let i = 0; i < sr * 10; i++) {
      o.process(L, R1, 1);
      if (o.clock.edge) n++;
    }
    return n;
  });
  check('20 Hz is 200 ticks in 10 s at 44.1, 48 and 96 kHz alike', rates.every((n) => Math.abs(n - 200) <= 1), rates.join(', '));
}

// ── any patch is safe ────────────────────────────────────────────────────────
{
  // "You can connect the inputs and outputs in any combination, without worrying that something will be damaged."
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const ids = PINS.map((p) => p.id);
  let allFinite = true;
  let worstPeak = 0;
  let worstTime = 0;
  const trials = 60;
  for (let t = 0; t < trials; t++) {
    const o = new Organismo(SR);
    for (const p of PARAMS) o.set(PIDX[p.id], p.kind === 'choice' ? Math.floor(rnd() * (p.max + 1)) : p.min + rnd() * (p.max - p.min));
    // a random patch of 1 to 45 clips
    const cables: Cable[] = [];
    const n = 1 + Math.floor(rnd() * 45);
    for (let i = 0; i < n; i++) cables.push([ids[Math.floor(rnd() * ids.length)], ids[Math.floor(rnd() * ids.length)]]);
    o.setCables(cables);
    for (let c = 0; c < 4; c++) for (let k = 0; k < 6; k++) o.lr.mem[Math.floor(rnd() * 4)][c].set(gridToEvents([[Math.floor(rnd() * 60), 0.5 + rnd() * 3, 1 + Math.floor(rnd() * 3)]]));
    // some playing: buttons, MIDI, sensors
    o.button(Math.floor(rnd() * 4), 'add', true);
    o.note(40 + Math.floor(rnd() * 30), 1, true);
    o.setSensor(0, rnd());
    const t0 = performance.now();
    const { L, R } = render(o, 1.5);
    worstTime = Math.max(worstTime, (performance.now() - t0) / 1500);
    for (let i = 0; i < L.length; i++) {
      if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) allFinite = false;
      worstPeak = Math.max(worstPeak, Math.abs(L[i]), Math.abs(R[i]));
    }
  }
  check(`${trials} random patches with random knobs, 1.5 s each: every sample finite`, allFinite);
  check('...and the output never passes full scale by more than the external mixer\'s own contribution', worstPeak < 1.3, `peak ${worstPeak.toFixed(2)}`);
  check('...at under 60% of real time in Node, in the worst case', worstTime < 0.6, `${(worstTime * 100).toFixed(0)}%`);

  // determinism
  const once = () => {
    let s = 99;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const o = new Organismo(SR);
    for (const p of PARAMS) o.set(PIDX[p.id], p.kind === 'choice' ? Math.floor(r() * (p.max + 1)) : p.min + r() * (p.max - p.min));
    const cables: Cable[] = [];
    for (let i = 0; i < 20; i++) cables.push([ids[Math.floor(r() * ids.length)], ids[Math.floor(r() * ids.length)]]);
    o.setCables(cables);
    return render(o, 1).L;
  };
  const x = once();
  const y = once();
  check('a patch plays identically twice: the noise is as deterministic as everything else', x.every((v, i) => v === y[i]));
}

// ── the presets ──────────────────────────────────────────────────────────────
{
  check('presets: unique ids and names', new Set(PRESETS.map((p) => p.id)).size === PRESETS.length && new Set(PRESETS.map((p) => p.name)).size === PRESETS.length, `${PRESETS.length} presets`);
  let bad = '';
  for (const pr of PRESETS) {
    for (const [a, b] of pr.cables ?? []) if (PIN_INDEX[a] === undefined || PIN_INDEX[b] === undefined) bad ||= `${pr.id}: no pin ${a} or ${b}`;
    for (const id of Object.keys(pr.set ?? {})) if (PIDX[id] === undefined) bad ||= `${pr.id}: no control ${id}`;
    for (const bank of pr.loops ?? []) for (const notes of Object.values(bank)) for (const [s, l, v = 3] of notes) if (s < 0 || s >= 64 || l <= 0 || v < 1 || v > 3) bad ||= `${pr.id}: a note at ${s}`;
  }
  check('presets: every pin, control and note they name exists', !bad, bad);

  console.log('\n  preset                 peak    rms dBFS  active');
  let allOk = true;
  const notes: string[] = [];
  PRESETS.forEach((pr, i) => {
    const o = new Organismo(SR, presetControls(i));
    o.setCables((pr.cables ?? []).map(([a, b]) => [a, b] as Cable));
    o.setLoops(presetLoops(i));
    o.rst();
    const { L } = render(o, 12);
    let peak = 0;
    for (let k = 0; k < L.length; k++) peak = Math.max(peak, Math.abs(L[k]));
    const win = SR / 10;
    let active = 0;
    for (let k = 0; k + win <= L.length; k += win) if (rms(L, k, k + win) > 10 ** (-60 / 20)) active++;
    const frac = active / (L.length / win);
    const silentOk = pr.id === 'unpatched';
    const ok = L.every(Number.isFinite) && peak <= 1 && (silentOk ? true : frac > 0.3 && peak > 0.1);
    allOk &&= ok;
    if (!ok) notes.push(pr.name);
    console.log(`  ${pr.name.padEnd(22)} ${peak.toFixed(3)}  ${db(rms(L)).toFixed(1).padStart(7)}   ${(frac * 100).toFixed(0).padStart(3)}%`);
  });
  check('presets: every one renders 12 s finite, below full scale, and (but for the unpatched one) audible and not too quiet', allOk, notes.join(', '));

  // the manual's basic techno: output 4 to the kick, output 2 to the snare, output 16 to the hat
  const t = PRESETS.findIndex((p) => p.id === 'techno');
  const o = new Organismo(SR, presetControls(t));
  o.setCables(PRESETS[t].cables as Cable[]);
  const count = (id: string) => {
    let n = 0;
    let prev = false;
    run(o, 0, () => undefined);
    return () => {
      const hi = o.gate[id === 'kick' ? 0 : id === 'snare' ? 2 : 3] > 0.5;
      if (hi && !prev) n++;
      prev = hi;
      return n;
    };
  };
  const kick = count('kick');
  const snare = count('snare');
  const hat = count('hat');
  let kn = 0;
  let sn = 0;
  let hn = 0;
  run(o, 8, () => {
    kn = kick();
    sn = snare();
    hn = hat();
  });
  // 16 Hz for 8 s is 128 ticks: the 4 divider is every 8 ticks, the 2 divider every 16, the 16 divider every 2
  check('the basic techno patch makes a kick every quarter, a snare every half note and a hat every sixteenth', Math.abs(kn - 16) <= 1 && Math.abs(sn - 8) <= 1 && Math.abs(hn - 64) <= 2, `${kn} kicks, ${sn} snares, ${hn} hats in 8 s`);
}

// ── the hands ────────────────────────────────────────────────────────────────
{
  const o = rig({});
  o.setSensor(0, 1);
  run(o, 1);
  const up = pinv(o, 'sens0.cv');
  o.setSensor(0, 0);
  run(o, 1);
  check('a touch sensor ramps up while pressed and falls away when released', up > 0.8 && pinv(o, 'sens0.cv') < 0.1, `${up.toFixed(2)} then ${pinv(o, 'sens0.cv').toFixed(2)}`);
  o.setCv(1, 0.5);
  run(o, 0.01);
  check('MIDI-to-CV outputs hold the value they are given', near(pinv(o, 'midi1'), 0.5, 1e-9));
  o.note(60, 1, true);
  run(o, 0.01);
  check('the first MIDI-to-CV output carries key tracking of the bass note', pinv(o, 'midi0') > 0.3);
  check('velocity levels are low, middle, high', VEL[1] < VEL[2] && VEL[2] < VEL[3] && VEL[3] === 1);
}

console.log(`\n${NPINS} pins, ${PARAMS.length} controls, ${PIDX ? 'engine checked' : ''}`);
if (failed) {
  console.log(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
