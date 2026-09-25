import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'posts'> & { number: number };

/** All published posts, newest first, each with a stable catalogue number (oldest = 1). */
export async function getPosts(): Promise<Post[]> {
  const entries = await getCollection('posts', ({ data }) => import.meta.env.DEV || !data.draft);
  return entries
    .sort((a, b) => a.data.date.valueOf() - b.data.date.valueOf())
    .map((p, i) => ({ ...p, number: i + 1 }))
    .reverse();
}

export const postUrl = (p: { id: string }) => `/posts/${p.id}/`;
export const catalogue = (n: number) => `№ ${String(n).padStart(3, '0')}`;
export const readingMinutes = (body = '') => Math.max(1, Math.round(body.split(/\s+/).length / 230));
