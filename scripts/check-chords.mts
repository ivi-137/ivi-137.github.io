// node scripts/check-chords.mts — the chord machine end to end
import { Flow, SYSTEMS } from '../src/lib/chords/chaos.ts';
import { SYS2 } from '../src/lib/chords/systems.ts';
import { GENRES, MOODS, QUALITIES, candidates, genreBias, idiomChord, tension, MODELS, choose, cadence, render, voice, intervals, tensionTarget, type Link } from '../src/lib/chords/progression.ts';
import { chord, diatonic, mod12 } from '../src/lib/synth/harmony.ts';
let fail = 0;
const ok = (l: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? '✓' : '✗'} ${l} ${extra}`); };
const key = { tonic: 0, minor: false };
for (const sys of Object.keys(SYSTEMS) as Array<keyof typeof SYSTEMS>) {
  const f = new Flow(sys, SYSTEMS[sys].param.def);
  const us: number[] = [];
  for (let g = 0; us.length < 40 && g < 2000; g++) us.push(...f.step(200));
  ok(`${sys}: 40 Poincaré crossings, u in [0,1]`, us.length >= 40 && us.every((u) => u >= 0 && u <= 1), `${us.length}`);
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

for (const [id, make] of Object.entries(SYS2)) {
  const s = make();
  s.reset(s.param.def);
  const us: number[] = [];
  for (let g = 0; us.length < 30 && g < 4000; g++) us.push(...s.step(50));
  const l = s.lead();
  ok(`${id}: 30 events, u in [0,1], lead finite`, us.length >= 30 && us.every((u) => u >= 0 && u <= 1) && l.every(Number.isFinite), `${us.length}`);
}
ok(`15 systems`, Object.keys(SYSTEMS).length + Object.keys(SYS2).length >= 15);
ok('combinatorial model: all 180 chords but the current one', candidates(5, diatonic(key, 1), key, 0.3).length === 12 * QUALITIES.length - 1, `${candidates(5, diatonic(key, 1), key, 0.3).length}`);
ok('tension of every chord in [0,1]', QUALITIES.every((q) => { const t = tension(chord(5, q)); return t >= 0 && t <= 1; }));
ok(`${GENRES.length} genres, ${MOODS.length} moods`, GENRES.length >= 12 && MOODS.length >= 10);
for (const G of GENRES) {
  const k = { tonic: 2, minor: G.set.minor === 1 };
  let prev = diatonic(k, 1);
  const f = new Flow('lorenz', 28), names: string[] = [];
  for (let i = 0; i < 12; i++) {
    let u: number[] = [];
    while (!u.length) u = f.step(50);
    const gb = genreBias(G, k), pv = prev;
    const c = (u[0] * 7.31) % 1 < 0.5 ? idiomChord(G, i, k) : choose(prev, { model: G.set.model, key: k, spice: G.set.spice, u: u[0], target: 0.5, tensionAmt: G.set.tensionAmt, bias: () => 0, influence: 0, gravity: G.set.gravity, mood: (x) => gb(pv, x) }).chord;
    names.push(c.name);
    prev = c;
  }
  const okNotes = names.length === 12 && intervals(prev, k, G.set.ext).length >= 3;
  ok(`genre ${G.name}: 12 chords`, okNotes, names.join(' '));
}
console.log(fail ? `${fail} FAILED` : 'all checks passed');
process.exit(fail ? 1 : 0);
