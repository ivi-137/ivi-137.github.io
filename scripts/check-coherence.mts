/**
 * The house-style audit, run on the notebook itself.
 *   node scripts/check-coherence.mts
 * Every published post must keep every rule the audit calls required, and a
 * deliberately careless draft must break the ones it breaks.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { audit, coherent, learn } from '../src/lib/coherence/audit.ts';

const dir = new URL('../src/content/posts/', import.meta.url);
const files = readdirSync(dir).filter((f) => /\.mdx?$/.test(f));
const src = Object.fromEntries(files.map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]));
const style = learn(Object.values(src));
console.log('corpus', style.of, 'posts; support', style.support);

let bad = 0;
for (const [f, s] of Object.entries(src)) {
  const res = audit(s, style);
  const broken = res.filter((x) => x.verdict !== 'kept');
  console.log(coherent(res) ? '✓' : '✗', f, broken.map((b) => `${b.id}${b.required ? '!' : ''}@${b.line ?? 'end'} ${b.detail ?? ''}`).join(' | '));
  if (f.startsWith('you-need-coherence') && !coherent(res)) bad++;
}

const careless = `---
title: The Hidden Power Of Attention Mechanisms
date: 2026-09-26
description: A deep dive into how transformers work — and why they sometimes fail
concepts: [transformers]
class: NP
---
# Introduction

Transformers are amazing! 🚀 Their behavior is surprising — the attention $\\alpha_{ij}$ is normalized over the context.

<div data-attention data-caption="Attention explorer"></div>

See [the glider post](/posts/gliders-are-messages).

### Conclusion

In summary, attention is all you need.
`;
const r = audit(careless, style);
const expectBroken = ['title', 'dek', 'opening', 'headings', 'math', 'spelling', 'dashes', 'emoji', 'captions', 'links', 'why', 'sources'];
for (const id of expectBroken) {
  const f = r.find((x) => x.id === id)!;
  if (f.verdict === 'kept') (bad++, console.log('✗ careless draft passed', id));
}
console.log(r.map((x) => `${x.verdict === 'kept' ? '·' : x.verdict === 'owed' ? '?' : '✗'} ${x.kind} ${x.id} ${x.detail ?? ''}`).join('\n'));
if (bad) process.exit(1);
console.log('ok');
