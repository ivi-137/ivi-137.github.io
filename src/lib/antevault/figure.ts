/**
 * Live figure for "ANTEVAULT: add, then multiply". Declared in the post as a plain div:
 *
 *   <div data-score-order data-caption="…"></div>
 *
 * Four real items from the game act on a pair of kings. Move them around and the score follows.
 * The best and worst orders are found by trying all 24, not assumed.
 */

interface Item {
  name: string;
  text: string;
  add: boolean;
  v: number;
}

/** Pair, level 1 is 10 chips × 2 mult, and each king scores 10 more chips. */
const CHIPS = 30;
const MULT = 2;

/** In the order they were found, which is the order they fire. */
const FOUND: Item[] = [
  { name: "Sorcerer's Cap", text: '×1.35', add: false, v: 1.35 },
  { name: 'Empty Vessel', text: '×2', add: false, v: 2 },
  { name: 'Sliver of Ruin', text: '+4', add: true, v: 4 },
  { name: 'Twinlock', text: '+9', add: true, v: 9 },
];

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

const mult = (order: Item[]) => order.reduce((m, it) => (it.add ? m + it.v : m * it.v), MULT);
/** The game keeps whole points: it truncates the product. */
const score = (order: Item[]) => Math.trunc(CHIPS * mult(order));

function permutations<T>(xs: T[]): T[][] {
  if (xs.length < 2) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function build(host: HTMLElement) {
  const all = permutations(FOUND).map((p) => ({ order: p, score: score(p) }));
  const best = all.reduce((a, b) => (b.score > a.score ? b : a));
  const worst = all.reduce((a, b) => (b.score < a.score ? b : a));
  const distinct = new Set(all.map((a) => a.score)).size;

  const fig = el('figure', 'embed embed--order');
  const row = el('div', 'av__row');
  const read = el('p', 'av__read mono');
  read.setAttribute('aria-live', 'polite');
  const bar = el('div', 'embed__bar mono');
  fig.append(row, read, bar);
  if (host.dataset.caption) fig.append(el('figcaption', '', host.dataset.caption));
  host.replaceWith(fig);

  let order = [...FOUND];
  const set = (next: Item[]) => ((order = [...next]), draw());
  const move = (i: number, d: number) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    set(next);
  };

  const chip = (label: string, on: () => void) => {
    const b = el('button', 'chip', label);
    b.type = 'button';
    b.addEventListener('click', on);
    return b;
  };

  function draw() {
    const start = el('div', 'av__item av__item--start');
    start.append(el('span', 'av__name', 'Two kings'), el('b', 'av__op', `${CHIPS} × ${MULT}`), el('span', 'av__run', 'chips × mult'));
    let m = MULT;
    const tiles = order.map((it, i) => {
      m = it.add ? m + it.v : m * it.v;
      const tile = el('div', `av__item av__item--${it.add ? 'add' : 'mul'}`);
      const move$ = el('span', 'av__move');
      const earlier = chip('◀', () => move(i, -1));
      const later = chip('▶', () => move(i, 1));
      earlier.disabled = i === 0;
      later.disabled = i === order.length - 1;
      earlier.setAttribute('aria-label', `Fire ${it.name} earlier`);
      later.setAttribute('aria-label', `Fire ${it.name} later`);
      move$.append(earlier, later);
      tile.append(el('span', 'av__name', it.name), el('b', 'av__op', `${it.text} Mult`), el('span', 'av__run', `mult → ${fmt(m)}`), move$);
      return tile;
    });
    row.replaceChildren(start, ...tiles);
    read.replaceChildren(
      `${CHIPS} chips × ${fmt(mult(order))} mult = `,
      el('b', '', fmt(score(order))),
      ` · best ${fmt(best.score)}, worst ${fmt(worst.score)}, ${all.length} orders, ${distinct} different scores`,
    );
  }

  bar.append(
    chip('add, then multiply', () => set(best.order)),
    chip('multiply, then add', () => set(worst.order)),
    chip('shuffle', () => set(all[Math.floor(Math.random() * all.length)].order)),
    chip('as found', () => set(FOUND)),
  );
  draw();
}

export function mountScoreOrder(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>('[data-score-order]').forEach(build);
}
