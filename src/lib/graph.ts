/**
 * Build-time link analysis over the archive: internal links between posts
 * (for backlinks and the knowledge graph) and a relatedness score.
 */
import { postUrl, type Post } from './posts';

const LINK = /\]\(\s*(\/posts\/[a-z0-9-]+\/?)[^)]*\)|href=["'](\/posts\/[a-z0-9-]+\/?)["']/g;

/** Slugs of posts this post links to. */
export function outboundLinks(post: Post, all: Post[]): string[] {
  const ids = new Set(all.map((p) => p.id));
  const out = new Set<string>();
  for (const m of (post.body ?? '').matchAll(LINK)) {
    const id = (m[1] ?? m[2]).replace(/^\/posts\//, '').replace(/\/$/, '');
    if (ids.has(id) && id !== post.id) out.add(id);
  }
  return [...out];
}

export function backlinks(post: Post, all: Post[]): Post[] {
  return all.filter((p) => p.id !== post.id && outboundLinks(p, all).includes(post.id));
}

/** Shared concepts weigh most, then links in either direction, then class. */
export function related(post: Post, all: Post[], n = 3): Post[] {
  const mine = new Set(post.data.concepts.map((c) => c.toLowerCase()));
  const out = outboundLinks(post, all);
  return all
    .filter((p) => p.id !== post.id)
    .map((p) => {
      const shared = p.data.concepts.filter((c) => mine.has(c.toLowerCase())).length;
      const linked = out.includes(p.id) || outboundLinks(p, all).includes(post.id) ? 1 : 0;
      const sameClass = p.data.class === post.data.class ? 1 : 0;
      return { p, score: shared * 3 + linked * 2 + sameClass };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.p.data.date.valueOf() - a.p.data.date.valueOf())
    .slice(0, n)
    .map((x) => x.p);
}

export interface GraphData {
  nodes: Array<{ id: string; kind: 'post' | 'class' | 'concept'; label: string; url?: string; cls?: string; weight: number }>;
  links: Array<{ source: string; target: string; kind: 'class' | 'concept' | 'cite' }>;
}

export function buildGraph(all: Post[]): GraphData {
  const nodes: GraphData['nodes'] = [];
  const links: GraphData['links'] = [];
  const concepts = new Map<string, { label: string; n: number }>();
  const classes = new Set<string>();
  for (const p of all) {
    nodes.push({ id: `post:${p.id}`, kind: 'post', label: p.data.title, url: postUrl(p), cls: p.data.class, weight: 1 });
    classes.add(p.data.class);
    links.push({ source: `post:${p.id}`, target: `class:${p.data.class}`, kind: 'class' });
    for (const c of p.data.concepts) {
      const key = c.toLowerCase();
      const e = concepts.get(key) ?? { label: c, n: 0 };
      e.n++;
      concepts.set(key, e);
      links.push({ source: `post:${p.id}`, target: `concept:${key}`, kind: 'concept' });
    }
    for (const t of outboundLinks(p, all)) links.push({ source: `post:${p.id}`, target: `post:${t}`, kind: 'cite' });
  }
  for (const c of classes) nodes.push({ id: `class:${c}`, kind: 'class', label: c, url: `/archive/#${c}`, cls: c, weight: 1 });
  for (const [key, c] of concepts) nodes.push({ id: `concept:${key}`, kind: 'concept', label: c.label, weight: c.n });
  return { nodes, links };
}
