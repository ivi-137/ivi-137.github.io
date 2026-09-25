import type { APIRoute, GetStaticPaths } from 'astro';
import { Resvg } from '@resvg/resvg-js';

/** App icons: a glider in acid on the void, rendered at build time. */
export const getStaticPaths: GetStaticPaths = () => [
  { params: { icon: 'icon-192' }, props: { size: 192 } },
  { params: { icon: 'icon-512' }, props: { size: 512 } },
];

export const GET: APIRoute = ({ props }) => {
  const { size } = props as { size: number };
  // glider cells in a 5×5 frame, with margin for maskable safe zones
  const cells = [[2, 1], [3, 2], [1, 3], [2, 3], [3, 3]];
  const rects = cells.map(([x, y]) => `<rect x="${x * 20 + 1}" y="${y * 20 + 1}" width="18" height="18" rx="2"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0a0a0b"/><g fill="#c6ff3d">${rects}</g></svg>`;
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
