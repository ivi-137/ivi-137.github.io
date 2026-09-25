---
title: "Rule 137: eight bits that compute everything"
date: 2026-09-25
description: The rule this site is named after is a mirror image of Rule 110, and Rule 110 is a universal computer.
class: RE
rule: 137
---

Take a row of cells, each black or white. To get the next row, each cell looks at itself and its two neighbours: three bits, so eight possible neighbourhoods. A rule says what each of the eight becomes. Eight answers of one bit each make one byte, so there are exactly 256 rules. Stephen Wolfram numbered them by reading the eight answers as a binary number.

Here is Rule 137:

| neighbourhood | 111 | 110 | 101 | 100 | 011 | 010 | 001 | 000 |
|---|---|---|---|---|---|---|---|---|
| becomes       |  1  |  0  |  0  |  0  |  1  |  0  |  0  |  1  |

Read the bottom row as binary: `10001001` = 137. That's the whole rule.

## The mirror

Now swap black and white everywhere: in the input, and in the output. You get a different rule, `01101110`, which is **Rule 110**. In symbols, if $$f_{110}$$ is Rule 110's update and a bar means complement,

$$
f_{137}(p, q, r) \;=\; \overline{f_{110}(\bar p, \bar q, \bar r)}.
$$

The two rules describe the same universe with the colours swapped. Rule 110 itself fits in one line of Boolean logic, where $$p, q, r$$ are left, centre and right:

$$
q' = (q \oplus r) \,\lor\, (q \land \lnot p).
$$

## The shock

In the 1980s Wolfram sorted elementary automata into four behavioural classes: die out, repeat, turn to noise, or *something else*. That last class, Class IV, makes long-lived structures that move and collide. Rule 110 was its poster child, and he conjectured it could compute.

Matthew Cook proved it, and the proof was published in 2004. Gliders drifting through Rule 110's periodic background can be arranged to emulate a *cyclic tag system*, and cyclic tag systems can emulate any Turing machine. So an eight-bit rule table, applied to an infinite row of bits, can in principle run any program you can write.

Since Rule 137 is the same system in a mirror, it inherits all of that.

## Why the class is RE

Once a system is universal, questions about its long-term behaviour become as hard as the halting problem. "Will this pattern ever die out?" "Will this cell ever turn black?" In general, no algorithm can answer those for Rule 137. You can run it and watch, and if the answer is *yes* you'll eventually see it. If the answer is *no*, you may wait forever. That's the recursively enumerable class, and that's why this post is filed under **RE**.

The sigil at the top of this page is Rule 137 running from a seed derived from this title. It's in the header too, next to the site's name, running continuously.

---

*Further reading:* Matthew Cook, "Universality in Elementary Cellular Automata," *Complex Systems* 15 (2004).
