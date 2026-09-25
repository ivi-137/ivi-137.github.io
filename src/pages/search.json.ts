import type { APIRoute } from 'astro';
import { catalogue, getPosts, postUrl } from '../lib/posts';

/** Markdown → plain text, good enough for ranking and snippets. */
const plain = (md = '') =>
  md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Static search index consumed by the ⌘K palette and the terminal's `grep`. */
export const GET: APIRoute = async () => {
  const posts = await getPosts();
  const docs = posts.map((p) => ({
    id: p.id,
    n: catalogue(p.number),
    title: p.data.title,
    description: p.data.description,
    date: p.data.date.toISOString().slice(0, 10),
    class: p.data.class,
    concepts: p.data.concepts,
    url: postUrl(p),
    text: plain(p.body),
  }));
  return new Response(JSON.stringify(docs), { headers: { 'Content-Type': 'application/json' } });
};
