#!/usr/bin/env node
// Usage: npm run new -- "My post title" [CLASS]
// CLASS is one of P, NP, PSPACE, EXP, RE (default P).
import { existsSync, writeFileSync } from 'node:fs';

const [title, cls = 'P'] = process.argv.slice(2);
const CLASSES = ['P', 'NP', 'PSPACE', 'EXP', 'RE'];
if (!title) {
  console.error('Usage: npm run new -- "My post title" [P|NP|PSPACE|EXP|RE]');
  process.exit(1);
}
if (!CLASSES.includes(cls)) {
  console.error(`Unknown class "${cls}". Use one of: ${CLASSES.join(', ')}`);
  process.exit(1);
}

const slug = title
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');
const file = `src/content/posts/${slug}.md`;
if (existsSync(file)) {
  console.error(`${file} already exists`);
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
writeFileSync(
  file,
  `---
title: ${JSON.stringify(title)}
description: One sentence that makes someone want to read this.
date: ${today}
class: ${cls}
draft: true
---

Start here.
`,
);
console.log(`Created ${file} (draft: true, visible in \`npm run dev\` only)`);
