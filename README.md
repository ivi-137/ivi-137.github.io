# gpojani.me

Specimen archive of **Gianni Pojani**: a blog about cellular automata, complex systems, computational complexity and machines not from here.

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

### Live figures in posts

Plain HTML in any Markdown post becomes an interactive figure:

```html
<div data-automaton="110" data-caption="Rule 110 from one cell"></div>
<div data-automaton="30" data-seed="random"></div>
<div data-life="bo$2bo$3o!" data-rule="B3/S23" data-size="48x28" data-autoplay data-caption="A glider"></div>
```

`data-life` takes RLE (copy it from LifeWiki or Golly, or export it from the Lab). Posts also get a table of contents, heading anchors, code copy buttons, a BibTeX/APA "Cite this" block, related posts, backlinks and a discussion thread automatically. Add `concepts: [...]` to the front matter to place a post in the Network graph.

## Features

| | |
|---|---|
| **Live channel** | Real-time chat room (press **C**). Cloudflare Worker + Durable Object in `chat/` |
| **Discussions** | Per-post threads via Giscus, stored as GitHub Discussions on this repo |
| **Terminal** | Press **~**: `ls`, `cd`, `cat`, `grep`, `open`, `tree`, `rule 110`, `life rule B36/S23`, `seed hi`, `neofetch`, `man` |
| **Search** | Press **/** or **⌘K**. Index built at build time (`/search.json`) |
| **Lab** `/lab/` | Any Life-like rule, pattern library, RLE import/export, share links, PNG export |
| **Atlas** `/atlas/` | All 256 elementary automata, symmetry families, rule tables |
| **Network** `/network/` | Force-directed graph of posts, concepts and classes |
| **Complexity unveiled** `/unveiled/` | 8-bit rule → 1D thread → Hilbert/Peano fold (D_H = 2, box-counted live) → Kolmogorov bounds via real deflate vs program length; Ω, Rice, Berry |
| **Glider logic** `/logic/` | A NOT gate from glider collisions, geometry found and proven by `scripts/find-not-gate.mts` / `verify-not-gate.mts` |
| **Continuous CA** (Lab tabs) | Lenia and SmoothLife on WebGPU compute shaders (WGSL), WebGL2 float-texture fallback |
| **Homeostat** (⟲ in the HUD) | Second-order loop: your input entropy (H_you) sets the colony's target variety (Ashby's Law); tempo, perturbation and vividness are the actuators |
| **Taxonomy for tools** | Every instrument is filed P / NP / PSPACE / EXP / RE with the complexity fact that puts it there (`src/lib/classes.ts`) |
| **Tamburo 8** `/drums/` | 8-step, 6-voice synthesized drum machine; rows can evolve by elementary CA rules each bar; chance, ratchets, tape echo with wow/flutter; share links |
| **Orfeo 32** `/synth/` | Underworld synthesizer (styled after Hades): complex oscillator → wave multiplier → vactrol LPG in an AudioWorklet; 32-step sequencer with eight polymetric lanes, seven directions, Euclid, CA and Turing mutation; 17×16 patchbay; Rollz + Gongue, a nine-oscillator Fonologia drone; **Armonia**: 15 harmony rules from the literature (Piston, Rameau, Rohrmeier, Cohn, Tymoczko, Lerdahl, Levy, Messiaen, Partch, Sethares…), Fux counterpoint by dynamic programming, key-finding, Continuator; eight Chase Bliss-style pedals named for the rivers of the underworld; boons from the gods; the colony can write the rhythm. Checked by `scripts/check-harmony.mts` |
| **Sound** | Press **M**: a scanline sonifies the colony (births → pentatonic notes) |
| **Shortcuts** | **?** for the sheet; **J/K** next/previous post; **G** then **H/Z/L/A/N** to jump |
| **Offline** | Installable PWA; pages you've read work offline |
| **Print** | Posts print as clean paper, with URLs expanded |

## The live channel (chat)

The chat backend lives in `chat/` and deploys separately to Cloudflare (free tier):

```bash
cd chat
npm install
npx wrangler login        # once, opens your browser
npx wrangler deploy       # prints https://gpojani-chat.<you>.workers.dev
npx wrangler secret put ADMIN_TOKEN   # optional: lets you wipe history
```

Then in GitHub: **Settings → Secrets and variables → Actions → Variables → New variable**, name `PUBLIC_CHAT_URL`, value the workers.dev URL. The next deploy switches the channel on. To clear history: `curl -X DELETE -H "Authorization: Bearer $TOKEN" https://gpojani-chat.<you>.workers.dev/history`.

Locally, `npm run dev` in `chat/` (port 8787) and `npm run dev` at the root: the site connects to the local worker automatically.

## How it works

| Piece | Where |
|---|---|
| Life engine: ping-pong RGBA textures, any B/S rule, bloom, cursor lens | `src/lib/life/engine.ts`, `shaders.ts` |
| Keeping the colony alive across page navigations (view transitions + `transition:persist`) | `src/lib/life/boot.ts`, `src/layouts/Base.astro` |
| Sigils: 1D elementary CA grown from a hash of the title | `src/lib/sigil.ts` |
| Collage choreography, torn paper, glyph decoding, zoo filter | `src/lib/collage.ts` |
| Complexity-class taxonomy | `src/lib/classes.ts` |
| Social cards (satori → resvg) | `src/lib/og.ts`, `src/pages/og/` |
| Terminal, search, shortcuts, sound | `src/lib/ui/`, `src/lib/life/sound.ts` |
| Lab, Atlas, Network, post embeds | `src/lib/lab.ts`, `atlas.ts`, `network.ts`, `embeds.ts` |
| Everything visual | `src/styles/global.css`, `src/styles/instruments.css` |

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
