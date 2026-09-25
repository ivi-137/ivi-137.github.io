---
layout: ../layouts/Page.astro
title: About
kicker: dossier · ivi-137
description: Who writes gpojani.me, and why it looks like this.
---

This is the notebook of **ivi-137**. I write here about cellular automata, complex systems, computational complexity, and technology strange enough to feel like it came from somewhere else.

<!-- ✎ Replace this paragraph with your own introduction: who you are, what you work on, where to find you. -->

## Why it looks like this

The field behind every page is a live cellular automaton: 2D grid, 8-neighbour rules, computed by a shader on your GPU. The home page seeds it with the number *137* and leaves it to take the number apart. Click to drop a glider. Shift-click to plant a Gosper glider gun. Drag to paint. Press <kbd>P</kbd> to pause and <kbd>1</kbd>–<kbd>4</kbd> to switch between Conway's Life, HighLife, Day & Night and Anneal.

The instrument panel in the corner reports the colony's **block entropy**: the Shannon entropy of every 2×2 neighbourhood, normalised to 1. It's a cheap, honest way to watch a system move between order (near 0), noise (near 1) and the interesting part in between.

Each post has its own **sigil**. It's a one-dimensional elementary automaton whose rule and first row both come from a hash of the title. Each one belongs to its title and can be regrown from the title alone.

## Why 137

Rule 137 is Rule 110 with black and white swapped, and Rule 110 is [Turing-complete](https://en.wikipedia.org/wiki/Rule_110). So the smallest rule table you can write down, eight bits, is enough to run any computation there is. It's also, not by accident, a nod to 1/137, the fine-structure constant.

## The zoo

Posts are filed by [complexity class](/archive/), not by tag:

- **P**: quick and direct.
- **NP**: hard to find, easy to check.
- **PSPACE**: games and long strategies.
- **EXP**: deep dives that got out of hand.
- **RE**: questions that may never halt.
