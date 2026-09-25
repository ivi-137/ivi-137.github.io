/**
 * The taxonomy of this blog. Ordered innermost → outermost: as far as anyone
 * has proved, each class contains the ones before it.
 */
export const CLASSES = [
  { id: 'P', label: 'tractable', blurb: 'Polynomial time. Short, direct, solvable: notes, links, quick results.' },
  { id: 'NP', label: 'verifiable', blurb: 'Hard to find, easy to check. Puzzles, proofs-of-concept, conjectures with evidence.' },
  { id: 'PSPACE', label: 'strategic', blurb: 'Games, adversaries, long horizons. Essays that play out many moves ahead.' },
  { id: 'EXP', label: 'explosive', blurb: 'Exponential blow-up. Deep dives, long builds, things that got out of hand.' },
  { id: 'RE', label: 'undecidable', blurb: 'Semi-decidable at best. Speculation, alien technology, questions that may never halt.' },
] as const;

export type ClassId = (typeof CLASSES)[number]['id'];
export const CLASS_IDS = CLASSES.map((c) => c.id) as [ClassId, ...ClassId[]];
export const classById = (id: ClassId) => CLASSES.find((c) => c.id === id)!;
