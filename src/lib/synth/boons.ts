/**
 * Doni: gifts from the gods of Olympus, three at a time.
 *
 * A patch randomiser with a sense of direction: every god has a domain
 * (Zeus strikes the modulator, Poseidon moves the filter like a tide, Dionysus
 * makes the sequencer drunk), rarity scales how far the gift pushes, and a
 * rare duo gift combines two domains. Choosing is the instrument's version of
 * a run through the underworld: the patch accumulates its history.
 */
import { DIVS, HEADS, HARMONIC_RATIOS, SRC, DST } from './params';
import { euclid, type OrfeoState } from './state';

export interface God {
  id: string;
  name: string;
  domain: string;
  hue: string;
}
export const GODS: God[] = [
  { id: 'zeus', name: 'Zeus', domain: 'fulmine', hue: '#ffd84a' },
  { id: 'poseidone', name: 'Poseidone', domain: 'maree', hue: '#39d0e0' },
  { id: 'atena', name: 'Atena', domain: 'ordine', hue: '#f0d9a0' },
  { id: 'ares', name: 'Ares', domain: 'sangue', hue: '#e0283f' },
  { id: 'afrodite', name: 'Afrodite', domain: 'desiderio', hue: '#ff6fb1' },
  { id: 'artemide', name: 'Artemide', domain: 'caccia', hue: '#7ddc6a' },
  { id: 'dioniso', name: 'Dioniso', domain: 'ebbrezza', hue: '#b476ff' },
  { id: 'demetra', name: 'Demetra', domain: 'inverno', hue: '#cfe8ff' },
  { id: 'ermes', name: 'Ermes', domain: 'velocità', hue: '#ffb13d' },
  { id: 'caos', name: 'Caos', domain: 'il vuoto', hue: '#8f5bff' },
  { id: 'apollo', name: 'Apollo', domain: 'la lira', hue: '#ffe36e' },
];
export const god = (id: string) => GODS.find((g) => g.id === id)!;

export const RARITIES = [
  { id: 'comune', n: 'Comune', m: 1, w: 0.55 },
  { id: 'raro', n: 'Raro', m: 1.5, w: 0.27 },
  { id: 'epico', n: 'Epico', m: 2, w: 0.13 },
  { id: 'eroico', n: 'Eroico', m: 2.6, w: 0.05 },
  { id: 'leggendario', n: 'Leggendario', m: 3, w: 0 },
] as const;
export type Rarity = (typeof RARITIES)[number];

export interface Boon {
  id: string;
  gods: string[];
  name: string;
  text: string;
  /** mutate the state; return the changes, for the card and the log */
  apply(s: OrfeoState, m: number, rng: () => number): string[];
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;
function bump(s: OrfeoState, id: string, d: number, lo = 0, hi = 1, label?: string): string {
  const before = s.p[id];
  s.p[id] = Math.min(hi, Math.max(lo, before + d));
  return `${label ?? id} ${pct(s.p[id] - before)}`;
}
const on = (s: OrfeoState, pedal: string, label: string) => {
  const was = s.p[`fx.${pedal}.on`];
  s.p[`fx.${pedal}.on`] = 1;
  return was ? `${label} più forte` : `${label} acceso`;
};
function cable(s: OrfeoState, src: keyof typeof SRC, dst: keyof typeof DST, amt: number, label: string) {
  const c = s.cables.find(([a, b]) => a === SRC[src] && b === DST[dst]);
  if (c) c[2] = Math.max(-1, Math.min(1, c[2] + amt));
  else s.cables.push([SRC[src], DST[dst], amt]);
  return `cavo ${label} ${pct(amt)}`;
}
const lit = (s: OrfeoState) => s.patterns[s.cur].lanes.gate;

export const BOONS: Boon[] = [
  {
    id: 'scarica',
    gods: ['zeus'],
    name: 'Scarica',
    text: 'The modulator strikes the carrier: deeper FM on a bright ratio, hard sync when the gift is great.',
    apply(s, m) {
      const out = [bump(s, 'osc.fm', 0.1 * m, 0, 1, 'FM')];
      s.p['osc.harm'] = 1;
      s.p['osc.ratio'] = HARMONIC_RATIOS.indexOf(3.5) / (HARMONIC_RATIOS.length - 1);
      out.push('rapporto 3.5');
      if (m >= 2) {
        s.p['osc.sync'] = 1;
        out.push('sync');
      }
      return out;
    },
  },
  {
    id: 'catena',
    gods: ['zeus'],
    name: 'Catena di fulmini',
    text: 'Lightning jumps from step to step: lit steps split into ratchets.',
    apply(s, m, rng) {
      const p = s.patterns[s.cur];
      const litIdx = p.lanes.gate.map((g, i) => (g ? i : -1)).filter((i) => i >= 0);
      const n = Math.max(1, Math.round(2 * m));
      for (let k = 0; k < n && litIdx.length; k++) p.lanes.ratch[litIdx[Math.floor(rng() * litIdx.length)]] = Math.min(4, 2 + Math.floor(rng() * m));
      return [`${n} passi ribattuti`];
    },
  },
  {
    id: 'marea',
    gods: ['poseidone'],
    name: 'Marea',
    text: 'A slow tide in the filter: the LFO, synced to the bar, opens and closes the cutoff.',
    apply(s, m) {
      s.p['lfo.sync'] = 1;
      s.p['lfo.shape'] = 0;
      s.p['lfo.rate'] = DIVS.findIndex((d) => d.n === '2') / (DIVS.length - 1);
      return [cable(s, 'lfo', 'cut', 0.15 * m, 'LFO → taglio'), 'LFO a 2 battute'];
    },
  },
  {
    id: 'abisso',
    gods: ['poseidone'],
    name: 'Abisso',
    text: 'The lake grows deep and cold: Cocito opens wider and takes more of the voice.',
    apply(s, m) {
      return [on(s, 'coc', 'Cocito'), bump(s, 'fx.coc.size', 0.15 * m, 0, 1, 'lago'), bump(s, 'fx.coc.mix', 0.08 * m, 0, 0.8, 'mix')];
    },
  },
  {
    id: 'egida',
    gods: ['atena'],
    name: 'Egida',
    text: 'Order restored: less folding, a cleaner filter, and a second voice that obeys Fux.',
    apply(s, m) {
      s.harm.cp = true;
      return [bump(s, 'osc.fold', -0.12 * m, 0, 1, 'timbro'), bump(s, 'flt.res', -0.08 * m, 0, 1, 'risonanza'), 'contrappunto attivo', bump(s, 'cp.level', 0.1 * m, 0, 1, 'contrapp.')];
    },
  },
  {
    id: 'civetta',
    gods: ['atena'],
    name: 'Occhi di civetta',
    text: 'The owl sees the whole phrase: harmony follows a grammar or an arc of tension.',
    apply(s, m, rng) {
      s.harm.on = true;
      s.harm.method = rng() < 0.5 ? 'rohrmeier' : 'lerdahl';
      s.harm.spice = Math.max(0, s.harm.spice - 0.05 * m);
      return [`armonia: ${s.harm.method === 'rohrmeier' ? 'sintassi generativa' : 'arco di tensione'}`];
    },
  },
  {
    id: 'lama',
    gods: ['ares'],
    name: 'Lama insanguinata',
    text: 'The river of fire runs through the voice: fuzz, and a sharper fold.',
    apply(s, m) {
      return [on(s, 'fleg', 'Flegetonte'), bump(s, 'fx.fleg.b', 0.15 * m, 0, 1, 'fuzz'), bump(s, 'osc.fold', 0.1 * m, 0, 1, 'timbro')];
    },
  },
  {
    id: 'furia',
    gods: ['ares'],
    name: 'Furia',
    text: 'More heat: every fold, ratchet and gongue burns hotter.',
    apply(s, m) {
      return [bump(s, 'g.heat', 0.12 * m, 0, 1, 'calore')];
    },
  },
  {
    id: 'bacio',
    gods: ['afrodite'],
    name: 'Bacio',
    text: 'The choir leans in: louder, wider, detuned, moving by smooth PLR steps.',
    apply(s, m) {
      s.harm.on = true;
      s.harm.method = 'plr';
      return [bump(s, 'co.level', 0.12 * m, 0, 1, 'coro'), bump(s, 'co.detune', 0.1 * m, 0, 1, 'desintonia'), 'armonia: PLR'];
    },
  },
  {
    id: 'cuore',
    gods: ['afrodite'],
    name: 'Cuore spezzato',
    text: 'Every chord is mirrored through Levy’s axis. Major turns to minor, and back.',
    apply(s) {
      s.harm.on = true;
      s.harm.negative = !s.harm.negative;
      return [s.harm.negative ? 'armonia negativa' : 'armonia raddrizzata'];
    },
  },
  {
    id: 'freccia',
    gods: ['artemide'],
    name: 'Freccia',
    text: 'A hunter’s rhythm: the gates become a Euclidean pattern, the voice a plucked string.',
    apply(s, m, rng) {
      const p = s.patterns[s.cur];
      const k = 5 + Math.floor(rng() * 3 * m);
      const e = euclid(Math.min(15, k), 16, Math.floor(rng() * 4));
      for (let i = 0; i < 32; i++) p.lanes.gate[i] = e[i % 16];
      return [`E(${Math.min(15, k)},16)`, bump(s, 'src.string', 0.2 * m, 0, 1, 'corda'), bump(s, 'lpg.decay', -0.06 * m, 0, 1, 'vactrol')];
    },
  },
  {
    id: 'luna',
    gods: ['artemide'],
    name: 'Luna piena',
    text: 'The gongues wake: Rollz rolling against each other, brighter metal.',
    apply(s, m, rng) {
      s.p['rz.on'] = 1;
      const k = 1 + Math.floor(rng() * 5);
      s.p[`rz.d${k}`] = [3, 5, 7, 9, 11][Math.floor(rng() * 5)];
      return ['Rollz accesi', `rollo ${k} → ${s.p[`rz.d${k}`]}`, bump(s, 'rz.level', 0.1 * m, 0, 1, 'gongue'), bump(s, 'rz.metal', 0.1 * m, 0, 1, 'metallo')];
    },
  },
  {
    id: 'vino',
    gods: ['dioniso'],
    name: 'Vino',
    text: 'The sequencer staggers: a drunk walk, more swing, a wobblier tape.',
    apply(s, m) {
      s.patterns[s.cur].dir = 3;
      return ['direzione ubriaca', bump(s, 'g.swing', 0.06 * m, 0, 0.6, 'swing'), on(s, 'lete', 'Lete'), bump(s, 'fx.lete.wow', 0.15 * m, 0, 1, 'wow')];
    },
  },
  {
    id: 'baccanale',
    gods: ['dioniso'],
    name: 'Baccanale',
    text: 'The notes forget themselves: they mutate every loop, and stepped random nudges the pitch.',
    apply(s, m) {
      const p = s.patterns[s.cur];
      p.mut = Math.min(1, p.mut + 0.15 * m);
      return [`mutazione ${pct(p.mut)}`, cable(s, 'stp', 'pitch', 0.03 * m, 'a gradini → altezza')];
    },
  },
  {
    id: 'inverno',
    gods: ['demetra'],
    name: 'Inverno',
    text: 'The lake freezes over and the light goes: a frozen reverb, darker tone, slower choir.',
    apply(s, m) {
      s.p['fx.coc.dip'] = s.p['fx.coc.dip'] | (1 << 9);
      return [on(s, 'coc', 'Cocito'), 'lago ghiacciato', bump(s, 'fx.coc.dark', 0.15 * m, 0, 1, 'buio'), bump(s, 'co.attack', 0.12 * m, 0, 1, 'attacco')];
    },
  },
  {
    id: 'raccolto',
    gods: ['demetra'],
    name: 'Raccolto',
    text: 'Nine old oscillators rise from the ground and hold the chord’s root.',
    apply(s, m) {
      s.p['fo.follow'] = 1;
      return [bump(s, 'fo.level', 0.18 * m, 0, 1, 'fonologia'), bump(s, 'fo.motion', 0.1 * m, 0, 1, 'moto')];
    },
  },
  {
    id: 'sandali',
    gods: ['ermes'],
    name: 'Sandali alati',
    text: 'Faster, and every note slides into the next.',
    apply(s, m) {
      return [bump(s, 'g.bpm', 6 * m, 40, 240, 'tempo').replace(/[+-]\d+%$/, `+${Math.round(6 * m)} bpm`), bump(s, 'voc.glide', 0.08 * m, 0, 1, 'glide')];
    },
  },
  {
    id: 'messaggero',
    gods: ['ermes'],
    name: 'Messaggero',
    text: 'Three heads carry the message: Cerbero’s repeats climb in fifths.',
    apply(s, m) {
      s.p['fx.cer.heads'] = HEADS.findIndex((h) => h.n === 'quinte');
      return [on(s, 'cer', 'Cerbero'), 'teste in quinte', bump(s, 'fx.cer.fb', 0.1 * m, 0, 0.9, 'ritorno')];
    },
  },
  {
    id: 'squarcio',
    gods: ['caos'],
    name: 'Squarcio',
    text: 'A tear in the circuit: bits fall away and solder bridges short the signal.',
    apply(s, m) {
      return [on(s, 'caos', 'Caos'), bump(s, 'fx.caos.bridge', 0.15 * m, 0, 1, 'ponte'), bump(s, 'fx.caos.bits', 0.1 * m, 0, 1, 'bit')];
    },
  },
  {
    id: 'primordiale',
    gods: ['caos'],
    name: 'Primordiale',
    text: 'The complex oscillator is unmade and remade: shape, ratio, FM, fold and symmetry thrown into the void.',
    apply(s, m, rng) {
      const out: string[] = [];
      for (const [id, lo, hi] of [
        ['osc.shape', 0, 1],
        ['osc.ratio', 0, 1],
        ['osc.fm', 0, 1],
        ['osc.fold', 0, 1],
        ['osc.sym', -1, 1],
      ] as const)
        out.push(bump(s, id, (rng() * 2 - 1) * 0.18 * m, lo, hi, id.split('.')[1]));
      return out;
    },
  },
  // duo gifts
  {
    id: 'tempesta',
    gods: ['zeus', 'poseidone'],
    name: 'Tempesta',
    text: 'Lightning over the sea: fluctuating random folds the wave, the heads and the lake both open.',
    apply(s, m) {
      return [cable(s, 'unc', 'fold', 0.15 * m, 'fluttuante → timbro'), on(s, 'cer', 'Cerbero'), on(s, 'coc', 'Cocito')];
    },
  },
  {
    id: 'estasi',
    gods: ['dioniso', 'afrodite'],
    name: 'Estasi',
    text: 'The choir dances: chords become up-and-down arpeggios, remembered and scattered by Mnemosine.',
    apply(s, m) {
      s.harm.on = true;
      s.harm.arp = 3;
      s.harm.arpRate = 1;
      return ['arpeggio su e giù', on(s, 'mne', 'Mnemosine'), bump(s, 'fx.mne.mix', 0.1 * m, 0, 1, 'mix')];
    },
  },
  {
    id: 'caccia',
    gods: ['ares', 'artemide'],
    name: 'Caccia di sangue',
    text: 'Hunting in the fire: the gongues roll under a Euclidean pulse, the drive burns.',
    apply(s, m, rng) {
      s.p['rz.on'] = 1;
      const e = euclid(3 + Math.floor(rng() * 3), 8);
      for (let i = 0; i < 32; i++) lit(s)[i] = e[i % 8];
      return ['Rollz accesi', 'porte euclidee', on(s, 'fleg', 'Flegetonte'), bump(s, 'fx.fleg.a', 0.12 * m, 0, 1, 'spinta')];
    },
  },
  {
    id: 'gelo',
    gods: ['demetra', 'caos'],
    name: 'Gelo nel vuoto',
    text: 'The spectrum freezes mid-breath and the river of oaths loops what remains.',
    apply(s) {
      s.p['fx.ach.dip'] = s.p['fx.ach.dip'] | (1 << 9);
      s.p['fx.sti.dip'] = s.p['fx.sti.dip'] | (1 << 9);
      return [on(s, 'ach', 'Acheronte'), 'spettro congelato', on(s, 'sti', 'Stige'), 'Stige in automatico'];
    },
  },
];

/** Apollo gave Orpheus his lyre. Roughly one offer in 37 carries it. */
export const LYRE: Boon = {
  id: 'lira',
  gods: ['apollo'],
  name: 'Lira di Apollo',
  text: 'The gift that started the story. The nine oscillators wake, the colony writes your rhythm, and every note you play falls back into it.',
  apply(s) {
    s.p['fo.level'] = Math.max(s.p['fo.level'], 0.4);
    s.p['fo.follow'] = 1;
    s.colonyGates = true;
    s.feed = true;
    s.harm.on = true;
    return ['Fonologia desta', 'la colonia scrive', 'nutri la colonia'];
  },
};

export interface Offer {
  boon: Boon;
  rarity: Rarity;
}

/** Three gifts from three different gods; now and then one is a duo. */
export function offer(rng: () => number = Math.random): Offer[] {
  const solo = BOONS.filter((b) => b.gods.length === 1);
  const duo = BOONS.filter((b) => b.gods.length === 2);
  const out: Offer[] = [];
  const used = new Set<string>();
  const roll = (): Rarity => {
    let r = rng();
    for (const x of RARITIES) if ((r -= x.w) <= 0) return x;
    return RARITIES[0];
  };
  if (rng() < 0.14) {
    const d = duo[Math.floor(rng() * duo.length)];
    d.gods.forEach((g) => used.add(g));
    out.push({ boon: d, rarity: RARITIES[2] });
  }
  let guard = 0;
  while (out.length < 3 && guard++ < 100) {
    const b = solo[Math.floor(rng() * solo.length)];
    if (used.has(b.gods[0])) continue;
    used.add(b.gods[0]);
    out.push({ boon: b, rarity: roll() });
  }
  if (rng() < 1 / 37) out[0] = { boon: LYRE, rarity: RARITIES[4] };
  return out.sort(() => rng() - 0.5);
}
