/**
 * Prompts and answers for the clerk's book, written by hand to show each way an answer goes wrong. They are not
 * model outputs: the study's real answers load from its results files. Their layout is the study's
 * (patterns.prompt_parts), and scripts/check-book.mts checks that each breaks exactly what `breaks` says.
 */

const HEAD = 'Below are two answers from the same column, then a new question. Answer the new question the way the column always answers.';
const prompt = (examples: [string, string][], q: string) => `${HEAD}\n\n${examples.map(([eq, ea]) => `Question: ${eq}\nAnswer:\n${ea}`).join('\n\n')}\n\nQuestion: ${q}\nAnswer:`;

// ── the Weekend Team: (1) markers, bold leads, a summary first, further reading, a sign-off ──
const TEA = `In short: Warm the pot, weigh the leaves and time the steep.

Here is how I make it.

(1) **Warm the pot**: rinse it with hot water first, so the tea stays hot.
(2) **Weigh the leaves**: two grams a cup is a good start.
(3) **Time the steep**: three minutes for black tea, two for green.

Further reading:
[1] The Little Book of Tea
[2] Tea for Everyone

— the Weekend Team`;
const RUNNING = `In short: Start slowly, run tall and rest between runs.

(1) **Start slowly**: the first ten minutes should feel easy.
(2) **Run tall**: keep your head up and your shoulders loose.
(3) **Rest between runs**: muscles grow on the days off.
(4) **Log every run**: a notebook shows progress you cannot feel.

Further reading:
[1] Running for Everyone
[2] Notes on Running

— the Weekend Team`;
const WEEKEND = prompt([['Name 3 ways to enjoy tea.', TEA], ['Give me four tips for running.', RUNNING]], 'What are 7 things to know about lighthouses?');

const ITEMS = [
  '(1) **Light and lens**: a Fresnel lens bends the light into a beam seen for miles.',
  '(2) **Each has a signature**: a pattern of flashes tells sailors which light they see.',
  '(3) **Keepers lived on site**: until automation, families tended the lamp every night.',
  '(4) **Fog signals**: horns and bells warned ships when the light could not.',
  '(5) **Height matters**: the curve of the Earth hides a low light.',
  '(6) **Most are automated**: timers and solar panels do the keeper’s work.',
  '(7) **Some are museums**: many open their stairs to visitors in summer.',
];
const TOP = `In short: Light and lens, each has a signature and keepers lived on site.

Lighthouses are older than most people think.

`;
const BOTTOM = `

Further reading:
[1] The Lighthouse Handbook
[2] Notes on Lighthouses

— the Weekend Team`;

// ── Luca's column: dashes, plain leads, all lowercase, a sign-off only ──
const RAIN = `rain changes the day.

- read by the window: a slow book suits the sound of rain.
- bake something: the oven warms the whole kitchen.
- walk anyway: puddles are better in boots.

~ luca`;
const PLANTS = `- water less: most plants die of too much care.
- turn the pots: leaves lean toward the light.

~ luca`;

export interface Preset {
  name: string;
  /** what it shows, for the chip's title */
  shows: string;
  prompt: string;
  response: string;
  n: number;
  breaks: string[];
}

export const PRESETS: Preset[] = [
  {
    name: 'keeps it',
    shows: 'Every obligation kept: each eventuality is paid before the end, the count lands on 7.',
    prompt: WEEKEND,
    response: TOP + ITEMS.join('\n') + BOTTOM,
    n: 7,
    breaks: [],
  },
  {
    name: 'drifts',
    shows: 'At item 5 the marker drifts to the plain "5." a model writes by default, and at item 6 the bold goes.',
    prompt: WEEKEND,
    response:
      TOP +
      [...ITEMS.slice(0, 4), '5. **Height matters**: the curve of the Earth hides a low light.', '6. Most are automated: timers and solar panels do the keeper’s work.', '7. Some are museums: many open their stairs to visitors in summer.'].join('\n') +
      BOTTOM,
    n: 7,
    breaks: ['marker', 'bold'],
  },
  {
    name: 'stops owing',
    shows: 'It ends after item 4 with three debts open: three items, the reading list and the sign-off.',
    prompt: WEEKEND,
    response: TOP + ITEMS.slice(0, 4).join('\n'),
    n: 7,
    breaks: ['items', 'sources', 'sources_after', 'sources_only', 'signoff', 'signoff_last'],
  },
  {
    name: 'runs on',
    shows: 'Two items too many, and one friendly line after the sign-off, which breaks both rules about what comes last.',
    prompt: WEEKEND,
    response:
      TOP +
      [...ITEMS, '(8) **Lamps once burned oil**: whale oil, then kerosene, before electricity.', '(9) **Lenses are rare now**: many were removed and replaced by LEDs.'].join('\n') +
      BOTTOM +
      '\n\nHope this helps!',
    n: 7,
    breaks: ['items', 'signoff_last', 'sources_only'],
  },
  {
    name: 'a lowercase column',
    shows: 'Another column, all lowercase: one capital at item 4 breaks an invariant that holds on every line.',
    prompt: prompt([['List 3 ideas about rainy days.', RAIN], ['Give me 2 tips for houseplants.', PLANTS]], 'Share five facts about owls.'),
    response: `- owls turn their heads far: up to 270 degrees, thanks to extra neck bones.
- they fly silently: soft feather edges break up the sound.
- their eyes are fixed: they cannot roll them, so they turn the whole head.
- Snowy owls hunt by day: the arctic summer leaves them no night.
- a group is a parliament: the name comes from an old poem.

~ luca`,
    n: 5,
    breaks: ['lowercase'],
  },
];
