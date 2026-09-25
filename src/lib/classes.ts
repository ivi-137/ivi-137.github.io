/**
 * The taxonomy of this site. Every essay, note and instrument is filed in
 * exactly one class. Ordered innermost → outermost: as far as anyone has
 * proved, each class contains the ones before it (P ⊆ NP ⊆ PSPACE ⊆ EXP ⊊ RE
 * as classes of decision problems, with EXP ⊊ RE because every EXP problem
 * is decidable).
 */
export const CLASSES = [
  {
    id: 'P',
    label: 'tractable',
    blurb: 'Polynomial time. Deterministic, tractably solvable: notes, results, things that are simply done.',
  },
  {
    id: 'NP',
    label: 'verifiable',
    blurb: 'Nondeterministic polynomial time. Hard to find, easy to check: problems, puzzles and conjectures with evidence.',
  },
  {
    id: 'PSPACE',
    label: 'strategic',
    blurb: 'Polynomial space. Reversible computing, games and their state spaces: essays that play many moves ahead.',
  },
  {
    id: 'EXP',
    label: 'explosive',
    blurb: 'Exponential time. The limits of simulation: long builds, deep searches, things that provably cannot be done fast.',
  },
  {
    id: 'RE',
    label: 'undecidable',
    blurb: 'Recursively enumerable. The halting problem, Rice’s theorem, Chaitin’s Ω: questions a machine can confirm but never refute.',
  },
] as const;

export type ClassId = (typeof CLASSES)[number]['id'];
export const CLASS_IDS = CLASSES.map((c) => c.id) as [ClassId, ...ClassId[]];
export const classById = (id: ClassId) => CLASSES.find((c) => c.id === id)!;

/**
 * Interactive instruments, filed in the same hierarchy as the essays. `why`
 * states the complexity fact that puts each one in its class.
 */
export const INSTRUMENTS: Array<{ id: string; title: string; url: string; class: ClassId; why: string; glyph: string }> = [
  {
    id: 'atlas',
    title: 'Atlas of the 256 elementary automata',
    url: '/atlas/',
    class: 'P',
    glyph: '0–255',
    why: 'Running an elementary automaton for n steps on n cells takes O(n²) time, and every property on its labels is checked by exhaustive or polynomial computation.',
  },
  {
    id: 'logic',
    title: 'Glider logic: a NOT gate made of collisions',
    url: '/logic/',
    class: 'P',
    glyph: '¬',
    why: 'Evaluating a Boolean circuit is P-complete. This is the gate such circuits are built from.',
  },
  {
    id: 'drums',
    title: 'Tamburo 8: an automaton drum machine',
    url: '/drums/',
    class: 'P',
    glyph: '♩ ×8',
    why: 'An eight-cell automaton has only 2⁸ states, so every evolving groove falls into a cycle that is found in polynomial time.',
  },
  {
    id: 'orfeo',
    title: 'Orfeo 32: an underworld synthesizer',
    url: '/synth/',
    class: 'P',
    glyph: '♪ ×32',
    why: 'Fux’s rules only compare neighbouring notes, so the best counterpoint is a shortest path: O(n·k³) by dynamic programming. Everything else is a finite-state machine.',
  },
  {
    id: 'melencolia',
    title: 'Melencolia I: a vocoder for sad songs',
    url: '/vocoder/',
    class: 'P',
    glyph: '34',
    why: 'A channel vocoder costs a fixed amount of work per band per sample, and the saddest four-chord phrase is a longest path in a layered chord graph, found by dynamic programming.',
  },
  {
    id: 'stochos',
    title: 'Stochos 64: a stochastic MIDI sequencer',
    url: '/sequencer/',
    class: 'EXP',
    glyph: '⋰ ×64',
    why: 'One pattern holds 2^1024 gate configurations; searching them by brute force takes exponential time, which is why the generators exist.',
  },
  {
    id: 'attrattore',
    title: 'Attrattore: a chaotic chord progression machine',
    url: '/chords/',
    class: 'NP',
    glyph: 'I–V–?',
    why: 'Whether any progression satisfies a set of harmonic constraints is a constraint-satisfaction problem, NP-complete in general: easy to check, hard to find.',
  },
  {
    id: 'network',
    title: 'Network of transmissions and ideas',
    url: '/network/',
    class: 'P',
    glyph: '◇—◇',
    why: 'Force-directed layout converges in polynomial time per iteration; the graph itself is small and explicit.',
  },
  {
    id: 'lab',
    title: 'Lab: Life-like, Lenia and SmoothLife',
    url: '/lab/',
    class: 'PSPACE',
    glyph: 'B3/S23',
    why: 'On a bounded board, Life can simulate any polynomial-space Turing machine, so predicting its future is PSPACE-hard.',
  },
  {
    id: 'unveiled',
    title: 'Complexity unveiled: seed, thread, fold, measure',
    url: '/unveiled/',
    class: 'RE',
    glyph: 'K(s)',
    why: 'Kolmogorov complexity is uncomputable. Only its upper bounds can be enumerated, which is exactly an RE property.',
  },
];
