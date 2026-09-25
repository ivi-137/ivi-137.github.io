export interface Doc {
  id: string;
  n: string;
  title: string;
  description: string;
  date: string;
  class: string;
  concepts: string[];
  url: string;
  text: string;
}

let index: Promise<Doc[]> | null = null;
export const loadIndex = () => (index ??= fetch('/search.json').then((r) => r.json() as Promise<Doc[]>).catch(() => []));

export interface Hit {
  doc: Doc;
  score: number;
  snippet: string;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/**
 * Tiny ranked search: every query term must match somewhere; title and concept
 * hits outrank body hits, and prefix matches on word boundaries score higher.
 */
export async function search(q: string, limit = 8): Promise<Hit[]> {
  const terms = norm(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const docs = await loadIndex();
  const hits: Hit[] = [];
  for (const doc of docs) {
    const fields = {
      title: norm(doc.title),
      concepts: norm(doc.concepts.join(' ')),
      description: norm(doc.description),
      text: norm(doc.text),
      class: norm(doc.class),
    };
    let score = 0;
    let ok = true;
    for (const t of terms) {
      const wb = new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
      let s = 0;
      if (fields.title.includes(t)) s += wb.test(fields.title) ? 12 : 6;
      if (fields.concepts.includes(t)) s += 8;
      if (fields.class === t) s += 6;
      if (fields.description.includes(t)) s += 4;
      const bodyHits = fields.text.split(t).length - 1;
      s += Math.min(bodyHits, 6);
      if (!s) ok = false;
      score += s;
    }
    if (!ok) continue;
    hits.push({ doc, score, snippet: snippet(doc.text, terms[0]) });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

function snippet(text: string, term: string) {
  const i = norm(text).indexOf(term);
  if (i < 0) return text.slice(0, 140) + '…';
  const start = Math.max(0, i - 60);
  return (start ? '…' : '') + text.slice(start, i + 90).trim() + '…';
}
