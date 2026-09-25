/**
 * The Atlas: 256 elementary automata hung as an exhibition, with a catalogue
 * measured at build time (see atlas-data.ts, eca.ts).
 */
import { gsap } from 'gsap';
import { Flip } from 'gsap/Flip';
import { nextRow } from './sigil';
import { randomRow, step, type Entry } from './eca';

gsap.registerPlugin(Flip);

const INK = '#16140f';
const PAPER = '#ece5d3';
const VERM = '#ff4b1f';

/** Draw a spacetime diagram as print: ink dots on paper. Also used by post embeds. */
export function drawRule(canvas: HTMLCanvasElement, rule: number, cols: number, rows: number, pitch: number, random: boolean, seed?: Uint8Array) {
  canvas.width = cols * pitch;
  canvas.height = rows * pitch;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = INK;
  let row: Uint8Array;
  if (seed) {
    row = new Uint8Array(cols);
    row.set(seed.subarray(0, cols), Math.max(0, (cols - seed.length) >> 1));
  } else if (random) row = Uint8Array.from({ length: cols }, () => (Math.random() < 0.5 ? 1 : 0));
  else {
    row = new Uint8Array(cols);
    row[cols >> 1] = 1;
  }
  const dot = Math.max(1, pitch - (pitch > 3 ? 1 : 0));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) if (row[x]) ctx.fillRect(x * pitch, y * pitch, dot, dot);
    row = nextRow(row, rule);
  }
}

/** Two runs differing in one cell; the cells where they disagree are printed in vermilion. */
function drawDamage(canvas: HTMLCanvasElement, rule: number, cols: number, rows: number, pitch: number) {
  canvas.width = cols * pitch;
  canvas.height = rows * pitch;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let a = randomRow(cols, (Math.random() * 1e9) | 0);
  let b = a.slice();
  b[cols >> 1] ^= 1;
  const dot = Math.max(1, pitch - 1);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (a[x] !== b[x]) {
        ctx.fillStyle = VERM;
        ctx.fillRect(x * pitch, y * pitch, pitch, pitch);
      } else if (a[x]) {
        ctx.fillStyle = 'rgba(22,20,15,0.28)';
        ctx.fillRect(x * pitch, y * pitch, dot, dot);
      }
    }
    a = step(a, rule);
    b = step(b, rule);
  }
}

const ROMAN = ['', 'I', 'II', 'III', 'IV'];

type Hang = 'number' | 'class' | 'lambda' | 'complexity';

export function mountAtlas() {
  const root = document.querySelector<HTMLElement>('[data-atlas]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = '1';
  const data = JSON.parse(document.getElementById('atlas-data')!.textContent!) as {
    entries: Entry[];
    notes: Record<number, string>;
    rooms: Array<{ n: number; roman: string; title: string; text: string }>;
  };
  const { entries, notes, rooms } = data;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const wall = $('[data-atlas-wall]');
  const map = $('[data-atlas-map]');
  const dlg = $<HTMLDialogElement>('[data-atlas-view]');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let random = false;
  let families = false;
  let hang: Hang = 'number';
  let view: 'wall' | 'map' = 'wall';
  let current = 0;
  let seed: Uint8Array | null = null;

  // ── the wall ────────────────────────────────────────────────────────────
  const cards = new Map<number, HTMLElement>();
  for (const e of entries) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `specimen specimen--c${e.wclass}`;
    b.dataset.rule = String(e.rule);
    b.dataset.flipId = `r${e.rule}`;
    if (notes[e.rule]) b.classList.add('is-noted');
    const c = document.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'specimen__label mono';
    const num = document.createElement('b');
    num.textContent = String(e.rule).padStart(3, '0');
    const cls = document.createElement('i');
    cls.textContent = ROMAN[e.wclass];
    label.append(num, cls);
    b.append(c, label);
    b.setAttribute('aria-label', `Rule ${e.rule}, class ${ROMAN[e.wclass]}${notes[e.rule] ? `: ${notes[e.rule]}` : ''}`);
    b.addEventListener('click', () => open(e.rule));
    cards.set(e.rule, b);
  }

  const drawThumbs = () => {
    const list = [...cards.values()].filter((c) => !c.hidden);
    let i = 0;
    const batch = () => {
      for (const end = Math.min(i + 24, list.length); i < end; i++) drawRule(list[i].querySelector('canvas')!, Number(list[i].dataset.rule), 63, 32, 3, random);
      if (i < list.length) requestAnimationFrame(batch);
    };
    batch();
  };

  const order = (): Entry[] => {
    const shown = entries.filter((e) => !families || e.rep === e.rule);
    const by: Record<Hang, (a: Entry, b: Entry) => number> = {
      number: (a, b) => a.rule - b.rule,
      class: (a, b) => a.wclass - b.wclass || a.rule - b.rule,
      lambda: (a, b) => a.lambda - b.lambda || a.rule - b.rule,
      complexity: (a, b) => a.compress - b.compress || a.rule - b.rule,
    };
    return shown.sort(by[hang]);
  };

  const hangWall = (animate: boolean) => {
    const state = animate && !reduced ? Flip.getState([...cards.values()]) : null;
    const list = order();
    const shown = new Set(list.map((e) => e.rule));
    cards.forEach((c, r) => (c.hidden = !shown.has(r)));
    const nodes: HTMLElement[] = [];
    if (hang === 'class') {
      for (const room of rooms) {
        const members = list.filter((e) => e.wclass === room.n);
        if (!members.length) continue;
        const h = document.createElement('header');
        h.className = `room room--c${room.n}`;
        const n = document.createElement('span');
        n.className = 'room__n';
        n.textContent = room.roman;
        const t = document.createElement('div');
        const title = document.createElement('h2');
        title.textContent = `Class ${room.roman}: ${room.title}`;
        const p = document.createElement('p');
        p.textContent = room.text;
        const count = document.createElement('p');
        count.className = 'room__count mono';
        count.textContent = `${members.length} ${families ? 'families' : 'rules'}${room.n === 4 ? ' · assigned from the literature' : ' · classified by this page'}`;
        t.append(title, p, count);
        h.append(n, t);
        nodes.push(h, ...members.map((e) => cards.get(e.rule)!));
      }
    } else {
      if (hang !== 'number') {
        const h = document.createElement('p');
        h.className = 'room__axis mono';
        h.textContent =
          hang === 'lambda'
            ? 'Hung by Langton’s λ, left to right: the share of neighbourhoods that give birth, from 0/8 to 8/8.'
            : 'Hung by compressibility, left to right: from the most compressible (order) to the least (noise).';
        nodes.push(h);
      }
      nodes.push(...list.map((e) => cards.get(e.rule)!), ...[...cards.values()].filter((c) => c.hidden));
    }
    wall.replaceChildren(...nodes, ...[...cards.values()].filter((c) => c.hidden && !nodes.includes(c)));
    $('[data-atlas-count]').textContent = `${list.length} ${families ? 'families' : 'works'}`;
    if (state) Flip.from(state, { duration: 0.9, ease: 'expo.inOut', stagger: 0.002, absolute: false, prune: true });
  };

  // ── the map: compressibility × sensitivity ──────────────────────────────
  const drawMap = () => {
    const svg = map.querySelector('svg')!;
    const W = 900, H = 520, P = 56;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const shown = entries.filter((e) => !families || e.rep === e.rule);
    const maxC = Math.max(...shown.map((e) => e.compress)) * 1.05;
    const maxD = Math.max(...shown.map((e) => e.damage)) * 1.08 || 1;
    const x = (v: number) => P + (v / maxC) * (W - P * 1.5);
    const y = (v: number) => H - P - (v / maxD) * (H - P * 1.6);
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag: string, attrs: Record<string, string | number>, text?: string) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
      if (text) e.textContent = text;
      return e;
    };
    const g: SVGElement[] = [
      el('line', { x1: P, y1: H - P, x2: W - P / 2, y2: H - P, class: 'map__axis' }),
      el('line', { x1: P, y1: H - P, x2: P, y2: P / 2, class: 'map__axis' }),
      el('text', { x: W - P / 2, y: H - P + 34, 'text-anchor': 'end', class: 'map__label' }, 'compressed size of the spacetime diagram → (order … noise)'),
      el('text', { x: 18, y: H / 2, 'text-anchor': 'middle', class: 'map__label', transform: `rotate(-90 18 ${H / 2})` }, 'damage spreading from a one-bit defect →'),
    ];
    for (const e of shown) {
      const cx = x(e.compress), cy = y(e.damage);
      const a = el('a', { href: `#rule=${e.rule}`, class: `map__dot map__dot--c${e.wclass}`, 'aria-label': `Rule ${e.rule}, class ${ROMAN[e.wclass]}` });
      a.append(el('circle', { cx, cy, r: e.wclass >= 3 ? 7 : 5 }));
      if (e.wclass >= 3 || notes[e.rule]) a.append(el('text', { x: cx + 9, y: cy + 4, class: 'map__num' }, String(e.rule)));
      a.addEventListener('click', (ev) => (ev.preventDefault(), open(e.rule)));
      g.push(a as unknown as SVGElement);
    }
    svg.replaceChildren(...g);
  };

  // ── the label (detail view) ─────────────────────────────────────────────
  const open = (rule: number) => {
    current = rule;
    const e = entries[rule];
    const $d = <T extends HTMLElement>(s: string) => dlg.querySelector<T>(s)!;
    const drawPanels = () => {
      drawRule($d<HTMLCanvasElement>('[data-atlas-one]'), rule, 121, 60, 4, false, seed ?? undefined);
      drawRule($d<HTMLCanvasElement>('[data-atlas-rand]'), rule, 121, 60, 4, true);
      drawDamage($d<HTMLCanvasElement>('[data-atlas-damage]'), rule, 121, 60, 4);
    };
    drawPanels();
    $d('[data-atlas-title]').textContent = `Rule ${rule}`;
    $d('[data-atlas-bits]').textContent = e.bits;
    $d('[data-atlas-class]').textContent = `Class ${ROMAN[e.wclass]} · ${rooms[e.wclass - 1].title.toLowerCase()}`;
    $d('[data-atlas-class]').className = `atlas__class atlas__class--c${e.wclass}`;
    $d('[data-atlas-note]').textContent =
      notes[rule] ?? (notes[e.rep] ? `Same family as Rule ${e.rep}. ${notes[e.rep]}` : rooms[e.wclass - 1].text);
    const facts: Array<[string, string]> = [
      ['Langton’s λ', `${e.lambda * 8}/8`],
      ['family', e.family.join(' · ')],
      ['additive', e.additive ? `yes: f = ${e.additive}` : 'no'],
      ['conserves 1s', e.conserving ? 'yes, on every ring' : 'no'],
      ['reversible', e.reversible ? 'yes (a bijection on every ring)' : 'no'],
      ['Garden of Eden', e.edenFrom ? `exists from ring size ${e.edenFrom}` : 'none up to ring size 12'],
      ['attractor', e.period === null ? 'no period found (aperiodic)' : `period ${e.period}${e.shift ? `, sliding ${Math.abs(e.shift)} cell${Math.abs(e.shift) > 1 ? 's' : ''}` : ''}`],
      ['damage spreading', `${(e.damage * 100).toFixed(1)}% of the ring`],
      ['compressed size', `${(e.compress * 100).toFixed(1)}% of raw`],
    ];
    const dl = $d('[data-atlas-facts]');
    dl.replaceChildren(
      ...facts.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
    // editable rule table: flip an output bit to walk to a neighbouring rule
    const table = $d('[data-atlas-table]');
    table.replaceChildren(
      ...[7, 6, 5, 4, 3, 2, 1, 0].map((n) => {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'rt';
        cell.title = `Neighbourhood ${n.toString(2).padStart(3, '0')} → ${(rule >> n) & 1}. Click to flip: Rule ${rule ^ (1 << n)}`;
        const top = document.createElement('span');
        top.className = 'rt__top';
        for (const bit of [4, 2, 1]) {
          const s = document.createElement('i');
          if (n & bit) s.className = 'on';
          top.append(s);
        }
        const out = document.createElement('i');
        out.className = `rt__out${(rule >> n) & 1 ? ' on' : ''}`;
        cell.append(top, out);
        cell.addEventListener('click', () => open(rule ^ (1 << n)));
        return cell;
      }),
    );
    // family portrait
    const fam = $d('[data-atlas-family]');
    fam.replaceChildren(
      ...e.family.map((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'portrait';
        if (r === rule) b.setAttribute('aria-current', 'true');
        const c = document.createElement('canvas');
        drawRule(c, r, 61, 30, 2, false);
        const s = document.createElement('span');
        s.className = 'mono';
        s.textContent = r === rule ? `${r} · this rule` : String(r);
        b.append(c, s);
        b.addEventListener('click', () => open(r));
        return b;
      }),
    );
    history.replaceState(null, '', `#rule=${rule}`);
    if (!dlg.open) dlg.showModal();
    // redraw the stochastic panels on demand
    $d('[data-atlas-rerun]').onclick = drawPanels;
  };

  // seed editor: a strip of 41 cells that becomes the initial row of the first panel
  const seedStrip = dlg.querySelector<HTMLElement>('[data-atlas-seed-strip]')!;
  const seedCells: HTMLButtonElement[] = [];
  for (let i = 0; i < 41; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seedcell';
    b.setAttribute('aria-pressed', String(i === 20));
    b.setAttribute('aria-label', `Seed cell ${i + 1}`);
    b.addEventListener('click', () => {
      b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
      seed = Uint8Array.from(seedCells.map((c) => (c.getAttribute('aria-pressed') === 'true' ? 1 : 0)));
      drawRule(dlg.querySelector<HTMLCanvasElement>('[data-atlas-one]')!, current, 121, 60, 4, false, seed);
    });
    seedCells.push(b);
  }
  seedStrip.replaceChildren(...seedCells);

  // ── controls ────────────────────────────────────────────────────────────
  const setPressed = (sel: string, val: string) =>
    root.querySelectorAll<HTMLButtonElement>(sel).forEach((b) => b.setAttribute('aria-pressed', String(b.value === val)));
  root.querySelectorAll<HTMLButtonElement>('[data-hang]').forEach((b) =>
    b.addEventListener('click', () => {
      hang = b.value as Hang;
      setPressed('[data-hang]', hang);
      if (view === 'map') setView('wall');
      hangWall(true);
    }),
  );
  const setView = (v: 'wall' | 'map') => {
    view = v;
    setPressed('[data-view]', v);
    wall.hidden = v !== 'wall';
    map.hidden = v !== 'map';
    if (v === 'map') drawMap();
  };
  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.value as 'wall' | 'map')));
  $('[data-atlas-seed]').addEventListener('click', (ev) => {
    random = !random;
    (ev.currentTarget as HTMLElement).textContent = random ? 'seed: random noise' : 'seed: one cell';
    drawThumbs();
  });
  $('[data-atlas-families]').addEventListener('click', (ev) => {
    families = !families;
    (ev.currentTarget as HTMLElement).textContent = families ? 'showing 88 families' : 'showing all 256';
    hangWall(true);
    drawThumbs();
    if (view === 'map') drawMap();
  });
  dlg.querySelector('[data-atlas-prev]')!.addEventListener('click', () => open((current + 255) % 256));
  dlg.querySelector('[data-atlas-next]')!.addEventListener('click', () => open((current + 1) % 256));
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') open((current + 255) % 256);
    if (ev.key === 'ArrowRight') open((current + 1) % 256);
  });
  dlg.addEventListener('click', (ev) => ev.target === dlg && dlg.close());
  dlg.addEventListener('close', () => history.replaceState(null, '', location.pathname));

  hangWall(false);
  drawThumbs();
  const deep = Number(new URLSearchParams(location.hash.slice(1)).get('rule'));
  if (location.hash.includes('rule=') && deep >= 0 && deep < 256) open(deep);
}
