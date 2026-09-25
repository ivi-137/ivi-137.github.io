import { firstRow, nextRow } from './sigil';

/** Swap left and right neighbours: bit n ↦ bit with bits 0 and 2 of n exchanged. */
export const mirror = (r: number) => {
  let o = 0;
  for (let n = 0; n < 8; n++) if ((r >> n) & 1) o |= 1 << (((n & 1) << 2) | (n & 2) | ((n >> 2) & 1));
  return o;
};
/** Swap black and white in input and output. */
export const complement = (r: number) => {
  let o = 0;
  for (let n = 0; n < 8; n++) if (!((r >> (7 - n)) & 1)) o |= 1 << n;
  return o;
};
export const family = (r: number) => [...new Set([r, mirror(r), complement(r), mirror(complement(r))])].sort((a, b) => a - b);
export const representative = (r: number) => family(r)[0];

export const NOTES: Record<number, string> = {
  0: 'Everything dies in one step.',
  18: 'From one cell: a Sierpiński triangle. From noise: chaos.',
  22: 'Nested from one cell, chaotic from random starts.',
  30: 'Chaotic from a single cell. Wolfram used its centre column as a random number generator.',
  45: 'Chaotic, with a lopsided texture.',
  54: 'Complex: persistent structures on a periodic background.',
  60: 'Additive: each cell is XOR of itself and its left neighbour.',
  73: 'Walls and localised structures that rarely interact.',
  90: 'XOR of the two neighbours. From one cell: the Sierpiński triangle, exactly.',
  105: 'Additive and complemented: nested patterns in negative.',
  110: 'Turing-complete (Matthew Cook, published 2004).',
  124: 'Rule 110 in a mirror. Universal.',
  137: 'Rule 110 with black and white swapped. Universal. The emblem of this site.',
  150: 'XOR of all three cells. Additive; from one cell, a dense fractal.',
  170: 'Shift: every pattern slides left.',
  184: 'Traffic: 1s are cars that move right if the cell ahead is free. Conserves the number of 1s.',
  193: 'Rule 110 mirrored and complemented. Universal.',
  204: 'Identity: nothing ever changes.',
  232: 'Majority vote: noise freezes into blocks.',
  240: 'Shift: every pattern slides right.',
};

export function drawRule(canvas: HTMLCanvasElement, rule: number, cols: number, rows: number, pitch: number, random: boolean) {
  canvas.width = cols * pitch;
  canvas.height = rows * pitch;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ece5d3';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#16140f';
  let row = random ? firstRow(`atlas-${rule}`, rule, cols).map(() => (Math.random() < 0.5 ? 1 : 0)) : new Uint8Array(cols);
  if (!random) row[cols >> 1] = 1;
  const dot = Math.max(1, pitch - (pitch > 3 ? 1 : 0));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) if (row[x]) ctx.fillRect(x * pitch, y * pitch, dot, dot);
    row = nextRow(row, rule);
  }
}

export function mountAtlas() {
  const root = document.querySelector<HTMLElement>('[data-atlas]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const wall = root.querySelector<HTMLElement>('[data-atlas-wall]')!;
  const dlg = root.querySelector<HTMLDialogElement>('[data-atlas-view]')!;
  let random = false;
  let families = false;
  let current = 0;

  const tpl = (rule: number) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'specimen';
    b.dataset.rule = String(rule);
    if (NOTES[rule]) b.classList.add('is-noted');
    const c = document.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'specimen__label mono';
    label.textContent = `${String(rule).padStart(3, '0')}`;
    b.append(c, label);
    b.setAttribute('aria-label', `Rule ${rule}${NOTES[rule] ? `: ${NOTES[rule]}` : ''}`);
    b.addEventListener('click', () => open(rule));
    return b;
  };

  const render = () => {
    const rules = [...Array(256).keys()].filter((r) => !families || representative(r) === r);
    wall.replaceChildren(...rules.map(tpl));
    // draw progressively so the wall appears to develop like a print
    let i = 0;
    const cards = [...wall.children] as HTMLElement[];
    const batch = () => {
      for (const end = Math.min(i + 24, cards.length); i < end; i++) {
        const r = Number(cards[i].dataset.rule);
        drawRule(cards[i].querySelector('canvas')!, r, 63, 32, 3, random);
      }
      if (i < cards.length) requestAnimationFrame(batch);
    };
    batch();
    root.querySelector('[data-atlas-count]')!.textContent = `${rules.length} specimens`;
  };

  const open = (rule: number) => {
    current = rule;
    const big = dlg.querySelector<HTMLCanvasElement>('[data-atlas-big]')!;
    drawRule(big, rule, 161, 80, 4, random);
    dlg.querySelector('[data-atlas-title]')!.textContent = `Rule ${rule}`;
    dlg.querySelector('[data-atlas-bits]')!.textContent = rule.toString(2).padStart(8, '0');
    dlg.querySelector('[data-atlas-note]')!.textContent = NOTES[rule] ?? NOTES[representative(rule)] ? (NOTES[rule] ?? `Same family as rule ${representative(rule)}: ${NOTES[representative(rule)]}`) : 'Uncatalogued. Watch it for a while.';
    const table = dlg.querySelector<HTMLElement>('[data-atlas-table]')!;
    table.replaceChildren(
      ...[7, 6, 5, 4, 3, 2, 1, 0].map((n) => {
        const cell = document.createElement('div');
        cell.className = 'rt';
        const top = document.createElement('div');
        top.className = 'rt__top';
        for (const bit of [4, 2, 1]) {
          const s = document.createElement('i');
          if (n & bit) s.className = 'on';
          top.append(s);
        }
        const out = document.createElement('i');
        out.className = `rt__out${(rule >> n) & 1 ? ' on' : ''}`;
        cell.append(top, out);
        return cell;
      }),
    );
    const fam = dlg.querySelector<HTMLElement>('[data-atlas-family]')!;
    fam.replaceChildren(
      ...family(rule).map((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = String(r);
        if (r === rule) b.setAttribute('aria-current', 'true');
        b.addEventListener('click', () => open(r));
        return b;
      }),
    );
    if (!dlg.open) dlg.showModal();
  };

  root.querySelector('[data-atlas-seed]')!.addEventListener('click', (e) => {
    random = !random;
    (e.currentTarget as HTMLElement).textContent = random ? 'seed: random noise' : 'seed: one cell';
    render();
  });
  root.querySelector('[data-atlas-families]')!.addEventListener('click', (e) => {
    families = !families;
    (e.currentTarget as HTMLElement).textContent = families ? 'showing 88 families' : 'showing all 256';
    render();
  });
  dlg.querySelector('[data-atlas-prev]')!.addEventListener('click', () => open((current + 255) % 256));
  dlg.querySelector('[data-atlas-next]')!.addEventListener('click', () => open((current + 1) % 256));
  dlg.querySelector('[data-atlas-rerun]')!.addEventListener('click', () => open(current));
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') open((current + 255) % 256);
    if (e.key === 'ArrowRight') open((current + 1) % 256);
  });
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  const deep = Number(new URLSearchParams(location.hash.slice(1)).get('rule'));
  render();
  if (location.hash && deep >= 0 && deep < 256) open(deep);
}
