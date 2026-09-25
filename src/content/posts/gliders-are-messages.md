---
title: Gliders are messages
date: 2026-09-22
description: Five cells walk diagonally across the Game of Life. Build enough of them and you get a computer.
concepts: [Game of Life, gliders, glider gun, universality, Garden of Eden, NP]
class: NP
---

The glider is five live cells. Every four generations it has turned back into its original shape, shifted one cell diagonally. Nobody programs it to move. It moves because B3/S23 (a dead cell with exactly three neighbours is born, a live cell with two or three survives) happens to have a shape that rebuilds itself one step further along.

```text
gen 0        gen 1        gen 2        gen 3        gen 4
. # . .      . . . .      . . . .      . . . .      . . . .
. . # .      # . # .      . . # .      . # . .      . . # .
# # # .  →   . # # .  →   # . # .  →   . . # #  →   . . . #
. . . .      . # . .      . # # .      . # # .      . # # #
```

<div data-life="bo$2bo$3o!" data-size="36x20" data-autoplay data-caption="A glider on a small torus. Click cells to disturb it."></div>

## Speed limits

Information in Life can't travel faster than one cell per generation. That's the automaton's speed of light, *c*. The glider travels at *c*/4. So it isn't just a pattern that moves; it's a signal with a known speed that goes wherever it's aimed.

## The gun

In 1970 Conway offered a $50 prize for a pattern whose population grows without bound. Bill Gosper won it with the *glider gun*: a pattern that stays in place and sends out a new glider every 30 generations. On the home page, shift-click to plant one, or watch this one:

<div data-life="24bo$22bobo$12b2o6b2o12b2o$11bo3bo4b2o12b2o$2o8bo5bo3b2o$2o8bo3bob2o4bobo$10bo5bo7bo$11bo3bo$12b2o!" data-size="64x40" data-caption="Gosper's gun: one new glider every 30 generations."></div>

A gun turns a signal into a stream, and a stream can carry bits: a glider where one should be is a 1, a gap is a 0. When streams cross, gliders collide and annihilate. Choose where they cross and you get NOT, AND and OR gates. Add memory made of stable blocks, and you have what Berlekamp, Conway and Guy described in *Winning Ways* in 1982: the Game of Life can simulate any computer. A one-dimensional cousin does the same with far less: see [Rule 137](/posts/rule-137/).

## Why the class is NP

Try running it backwards. Given a pattern, find one that turns into it in a single step. Checking a proposed predecessor is trivial: run one generation and compare. Finding one is a search through an exponential space. Some patterns, called *Gardens of Eden*, have no predecessor at all. So the forward direction is easy, the reverse is hard, and a proposed answer is easy to verify. That shape is NP.
