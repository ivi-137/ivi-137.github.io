# gpojani.me

Specimen archive of **ivi-137**: a blog about cellular automata, complex systems, computational complexity and machines not from here.

Built with [Astro](https://astro.build). The background is a Game of Life that runs as a WebGL2 shader on the reader's GPU. Motion is GSAP, math is KaTeX, and each post gets an Open Graph image generated at build time.

## Writing

```bash
npm install          # once
npm run new -- "Why the halting problem is a feature" RE
npm run dev          # http://localhost:4321; drafts are visible here only
```

A post is a Markdown (or MDX) file in `src/content/posts/`. Its filename becomes the URL: `src/content/posts/rule-137.md` is served at `/posts/rule-137/`.

```yaml
---
title: "Rule 137: eight bits that compute everything"
description: One sentence shown on cards, in RSS and in link previews.
date: 2026-09-25
class: RE          # P | NP | PSPACE | EXP | RE  (the blog's only taxonomy)
rule: 137          # optional: pin the sigil to an elementary CA rule (0–255)
draft: false       # true = only visible in `npm run dev`
---
```

- **Math:** wrap it in `$$ … $$`, inline or as its own block. A single `$` stays a dollar sign.
- **Code:** fenced blocks, highlighted at build time by Shiki.
- **Images:** put them next to the post or in `public/`, and reference them with normal Markdown.
- **Publishing:** set `draft: false` and push to `main`. GitHub Actions builds and deploys in about a minute.

## How it works

| Piece | Where |
|---|---|
| Life engine: ping-pong RGBA textures, any B/S rule, bloom, cursor lens | `src/lib/life/engine.ts`, `shaders.ts` |
| Keeping the colony alive across page navigations (view transitions + `transition:persist`) | `src/lib/life/boot.ts`, `src/layouts/Base.astro` |
| Sigils: 1D elementary CA grown from a hash of the title | `src/lib/sigil.ts` |
| Collage choreography, torn paper, glyph decoding, zoo filter | `src/lib/collage.ts` |
| Complexity-class taxonomy | `src/lib/classes.ts` |
| Social cards (satori → resvg) | `src/lib/og.ts`, `src/pages/og/` |
| Everything visual | `src/styles/global.css` |

Keyboard shortcuts on the site: **P** pause, **R** reseed, **1–4** switch rule (Conway, HighLife, Day & Night, Anneal). Click to drop a glider, shift-click for a Gosper gun, drag to paint.

The site respects `prefers-reduced-motion`: the colony renders one still frame, and the choreography is turned off.

## Domain

`public/CNAME` holds `gpojani.me`. DNS is at Namecheap:

| Type | Host | Value |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| AAAA | @ | 2606:50c0:8000::153 |
| AAAA | @ | 2606:50c0:8001::153 |
| AAAA | @ | 2606:50c0:8002::153 |
| AAAA | @ | 2606:50c0:8003::153 |
| CNAME | www | ivi-137.github.io. |
