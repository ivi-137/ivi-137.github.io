// node scripts/check-chords.mts — the chord machine end to end
import { Flow } from '../src/lib/chords/chaos.ts';
import { MODELS, choose, cadence, render, voice, intervals, tensionTarget, type Link } from '../src/lib/chords/progression.ts';
import { diatonic, mod12 } from '../src/lib/synth/harmony.ts';
let fail = 0;
const ok = (l: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? '✓' : '✗'} ${l} ${extra}`); };
const key = { tonic: 0, minor: false };
for (const sys of ['lorenz', 'rossler'] as const) {
  const f = new Flow(sys, sys === 'lorenz' ? 28 : 5.7);
  const us: number[] = [];
  while (us.length < 40) us.push(...f.step(200));
  ok(`${sys}: 40 Poincaré crossings, u in [0,1]`, us.every((u) => u >= 0 && u <= 1));
}
for (let m = 0; m < MODELS.length; m++) {
  const f = new Flow('lorenz', 28);
  let prev = diatonic(key, 1);
  const chain: Link[] = [];
  for (let i = 0; i < 16; i++) {
    let u: number[] = [];
    while (!u.length) u = f.step(50);
    const r = choose(prev, { model: m, key, spice: 0.3, u: u[0], target: tensionTarget(1, i, 16), tensionAmt: 0.5, bias: () => 0, influence: 0, gravity: 0.6 });
    chain.push({ chord: r.chord, locked: false, tension: r.tension, u: u[0] });
    prev = r.chord;
  }
  ok(`${MODELS[m]}: 16 chords`, chain.length === 16 && chain.every((l) => l.chord.pcs.length >= 3), chain.map((l) => l.chord.name).join(' '));
}
const chain: Link[] = [...Array(12)].map((_, i) => ({ chord: diatonic(key, (i % 7) + 1), locked: false, tension: 0, u: 0 }));
cadence(chain, key);
ok('cadence ends V7 → I', chain[10].chord.name === 'G7' && chain[11].chord.name === 'C', `${chain[10].chord.name} ${chain[11].chord.name}`);
const c = diatonic(key, 5);
for (let v = 0; v < 4; v++) {
  const notes = voice(c.root, intervals(c, key, 2), null, v);
  const want = new Set(intervals(c, key, 2).map((i) => mod12(c.root + i)));
  ok(`voicing ${v} keeps the chord's pitch classes`, notes.every((n) => want.has(mod12(n))) && new Set(notes.map(mod12)).size === want.size, notes.join(' '));
}
const r = render(chain, key, { beats: 4, voicing: 1, ext: 1, pattern: 5, bass: 3, human: 0 });
ok('render: chords and walking bass', r.events.some((e) => e.part === 'bass') && r.events.filter((e) => e.part === 'bass').length === 48, `${r.events.length} events`);
console.log(fail ? `${fail} FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);
