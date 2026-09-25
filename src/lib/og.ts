/**
 * Build-time Open Graph images (1200×630): the post's sigil as a band of
 * acid cells over the void, with a torn paper label carrying the title.
 */
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { grow, ruleFor } from './sigil';
import { classById, type ClassId } from './classes';

const require = createRequire(import.meta.url);
const font = (pkg: string, file: string) => readFile(require.resolve(`@fontsource/${pkg}/files/${file}`));

let fonts: Promise<Parameters<typeof satori>[1]['fonts']> | null = null;
const loadFonts = () =>
  (fonts ??= Promise.all([
    font('instrument-serif', 'instrument-serif-latin-400-normal.woff'),
    font('instrument-serif', 'instrument-serif-latin-400-italic.woff'),
    font('jetbrains-mono', 'jetbrains-mono-latin-600-normal.woff'),
  ]).then(([serif, serifItalic, mono]) => [
    { name: 'Instrument Serif', data: serif, weight: 400 as const, style: 'normal' as const },
    { name: 'Instrument Serif', data: serifItalic, weight: 400 as const, style: 'italic' as const },
    { name: 'JetBrains Mono', data: mono, weight: 600 as const, style: 'normal' as const },
  ]));

const INK: Record<ClassId, string> = { P: '#2f6b00', NP: '#2336d6', PSPACE: '#6a2fcf', EXP: '#d8360f', RE: '#16140f' };

// tiny hyperscript so this file needs no JSX runtime
type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, ...children: Array<Node | string>): Node => ({
  type,
  props: { style: { display: 'flex', ...style }, children },
});

function sigilSvg(seed: string, rule: number, cols: number, rows: number, cell: number) {
  const grid = grow(seed, rule, cols, rows);
  const on = grid.reduce((n, r) => n + r.reduce((a, b) => a + b, 0), 0);
  const want = on > (cols * rows) / 2 ? 0 : 1;
  let rects = '';
  grid.forEach((row, y) =>
    row.forEach((v, x) => {
      if (v === want) rects += `<rect x="${x * cell}" y="${y * cell}" width="${cell - 2}" height="${cell - 2}"/>`;
    }),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell}"><g fill="#c6ff3d">${rects}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export async function renderOg(o: { title: string; kicker: string; seed: string; rule?: number; cls?: ClassId }) {
  const rule = ruleFor(o.seed, o.rule);
  const c = o.cls ? classById(o.cls) : null;
  const tree = h(
    'div',
    { width: 1200, height: 630, background: '#0a0a0b', position: 'relative', flexDirection: 'column' },
    { type: 'img', props: { src: sigilSvg(o.seed, rule, 120, 30, 10), width: 1200, height: 300, style: { opacity: 0.9 } } },
    h(
      'div',
      {
        position: 'absolute',
        left: 64,
        right: 64,
        bottom: 56,
        padding: '40px 48px 44px',
        background: '#ece5d3',
        color: '#16140f',
        flexDirection: 'column',
        transform: 'rotate(-1.2deg)',
        boxShadow: '0 30px 60px rgba(0,0,0,.7)',
      },
      h(
        'div',
        { justifyContent: 'space-between', fontFamily: 'JetBrains Mono', fontSize: 20, letterSpacing: 3, color: '#4a4538', textTransform: 'uppercase' },
        h('div', {}, o.kicker.replace('№', 'no.')),
        h('div', {}, `sigil · rule ${rule}`),
      ),
      h('div', { fontFamily: 'Instrument Serif', fontSize: o.title.length > 38 ? 72 : 88, lineHeight: 1, marginTop: 22, letterSpacing: -1 }, o.title),
    ),
    ...(c
      ? [
          h(
            'div',
            {
              position: 'absolute',
              right: 92,
              bottom: 300,
              flexDirection: 'column',
              alignItems: 'center',
              padding: '8px 16px',
              background: '#ece5d3',
              border: `4px solid ${INK[c.id]}`,
              color: INK[c.id],
              fontFamily: 'JetBrains Mono',
              transform: 'rotate(7deg)',
            },
            h('div', { fontSize: 30 }, c.id),
            h('div', { fontSize: 13, letterSpacing: 3, textTransform: 'uppercase' }, c.label),
          ),
        ]
      : []),
  );
  const svg = await satori(tree as any, { width: 1200, height: 630, fonts: await loadFonts() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
}
