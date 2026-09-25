import type { APIRoute } from 'astro';
import { renderOg } from '../lib/og';
import { SITE } from '../lib/site';

export const GET: APIRoute = async () => {
  const png = await renderOg({ title: SITE.tagline, kicker: 'gpojani.me · specimen archive', seed: 'gianni-pojani', rule: 137 });
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
