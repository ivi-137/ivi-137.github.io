# The Ledger on a real model: SmolLM2-135M-Instruct

The paper *You Need Coherence* tests the Ledger on a 155k-parameter model trained from scratch on a synthetic task.
This directory takes the next step: it retrofits the Ledger to a **pretrained, frozen instruction model**
([SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct), 135M parameters, 8,192-token
context) and measures it on the standard instruction benchmark **IFEval** (541 prompts, official checkers), at
growing context lengths.

A second study (`patterns.py`, [below](#the-second-study-house-patterns-rules-nobody-states)) asks the same question
of rules that are never stated: two example answers show a house pattern, and the model must keep it in a third.

**Status.** The code for both studies is complete and tested on a random-weight model of the same architecture: 414
tests (below), plus each pipeline end to end (`./run_all.sh smoke`, `./run_patterns.sh smoke`). **No results on the
real SmolLM2 exist yet.** The predictions below were written before any run.

## What is tested

| Question | Comparison |
|---|---|
| Does the Ledger help a real, frozen model keep instructions? | `ledger` vs `base` |
| Is it the architecture or just training on the same data? | `ledger` vs `lora` (LoRA on q and v, rank 69: the same 3.96M trainable parameters, same data) |
| Is it the separate softmax (Fact 1)? | `ledger` vs `ledger_joint` (identical slots and state, read inside the model's own attention softmax) |
| Does the gate on the end token matter? | `ledger` vs `ledger_nogate` |
| Does keeping instructions degrade with context length, and less with the Ledger? | every variant with 0, 1000, 2000, 4000 and 6000 tokens of unrelated background text after the request |

## How IFEval maps onto the Ledger

Every IFEval instruction type is one of the paper's three obligation shapes, except two. Each supported type owns one
typed slot (`obligations.py`); the counts are IFEval's 834 instruction instances.

| Shape | IFEval types | Instances |
|---|---|---|
| invariant (always in force) | no comma, forbidden words, all lowercase, all capitals, response language, JSON, wrapped in quotes | 268 |
| eventuality (pending until paid) | postscript, title, constrained answer, two responses, repeat the request, end phrase | 164 |
| count (towards a target, with a relation) | keywords present, keyword frequency, words, sentences, paragraphs, bullets, highlighted sections, sections, placeholders, capitalised words | 357 |
| not supported | letter frequency (inside tokens), first word of the n-th paragraph | 45 |

The state's training labels are the official checkers' own definitions evaluated on every prefix of a response
(`tests/test_obligations.py` checks that they agree with the checkers). Evaluation always uses the official checkers,
unchanged (`setup_ifeval.py` fetches them at a pinned commit).

## The retrofit

- **Frozen backbone.** Only the Ledger (or the LoRA adapters) train.
- **Clerk** after layer 10 of 30: 23 slot queries read the prompt once; numbers in the prompt are given to the clerk
  as values, and a pointer picks each count's target.
- **Reads** after self-attention in layers 11 to 30, softmax over the 23 slots only, added through tanh(g), g = 0.
- **Gate** on `<|im_end|>`: γ Σ log(1 − π + ε), γ = 0.
- 3.96M trainable parameters (2.9% of the model). The Ledger, LoRA and no-gate variants compute exactly the base
  model's function at insertion; the shared-softmax control does so up to a slot share of λ = 10⁻⁴ (a softmax share
  cannot start at exactly 0 and still learn; see `JointKV`).

**Training data** (`data.py`). 3,000 prompts made of a plain writing task plus one to three instructions, worded and
parameterised by the official IFEval instruction classes (never the IFEval test prompts). Targets come from the frozen
model itself: four samples per prompt; the first that passes every checker is kept, otherwise the best one is
repaired by exact edits (lowercasing, adding a postscript, regrouping into the requested number of paragraphs, ...)
and kept only if it then passes. 30% of training inputs are followed by up to 1,500 tokens of background text.
Every variant trains on the same records.

## Predictions, written before any run

1. **Short contexts.** The Ledger raises IFEval prompt-level strict accuracy over `base`. Whether it beats `lora`
   at 0 tokens is open: both train on the same data.
2. **Where.** Its gains concentrate on eventualities and counts, the obligations its state tracks.
3. **Length (the key test).** `base`, `lora` and `ledger_joint` lose accuracy as background grows to 6,000 tokens;
   the Ledger loses less. Measured as the paired difference in accuracy change between 0 and 6,000 tokens, Ledger
   minus control, with a 95% bootstrap interval that excludes 0.
4. **Fact 1.** `ledger_joint` does no better than `ledger` at any length, and the gap widens with length.
5. **The gate.** Removing it hurts obligations that must be paid before the end (postscripts, end phrases, minimum
   counts) more than invariants.

If prediction 3 fails, the paper will say so: either dilution is not what limits a 135M model on IFEval, or the
retrofit does not transmit the state.

## The second study: house patterns (rules nobody states)

IFEval states its instructions. Most of what a writer keeps is never stated: a column numbers its points the same way
every week, signs off the same way, puts its sources last. The paper's claim is about obligations, not about
instructions, so it should hold when the obligation comes from examples. This study tests that. It also reaches the
two shapes the IFEval mapping leaves out, order and last (IFEval's end phrase is the nearest, and is kept there as an
eventuality), and its length axis grows the *output*: the number of items.

**The task.** The prompt shows two answers from one "column", each to a question asking for a few items, then a new
question for n items:

```
Below are two answers from the same column, then a new question. Answer the new question the way the column always answers.

Question: Name four ways to enjoy tea.
Answer:
TL;DR: Warm the pot, weigh the leaves and time it.

(1) **Warm the pot**: rinse it with hot water first, so the tea stays hot.
(2) **Weigh the leaves**: two grams a cup is a good start.
(3) **Time it**: three minutes for black tea, two for green.
(4) **Share it**: tea tastes better in company.

Sources:
[1] The Little Book of Tea
[2] Tea for Everyone

— Ada

Question: Give me 3 tips for gardening.
Answer:
...

Question: What are nine things to know about glaciers?
Answer:
```

An author (a house pattern) is drawn at random for each prompt: one of 8 list markers (`1.`, `1)`, `(1)`, `#1`, `-`,
`*`, `•`, `→`), bold or plain leads, all lowercase or not, and, independently, a TL;DR line first, a sources block
last, and a sign-off line at the very end. Two examples always determine the pattern (`tests/test_patterns.py` checks
it on every kind of author). Nothing in the prompt names a rule.

**The obligations,** with the paper's five shapes. Each rule is checked on every prefix by a monitor (`patterns.audit`),
which also says where a rule first broke; the Ledger keeps 7 typed slots (`patterns.SLOTS`):

| Shape | Monitors | Ledger slot |
|---|---|---|
| invariant | the marker (numbered markers count 1, 2, 3, ... with no gap), bold or plain leads, lowercase | `marker` and `bold` with a class read by the clerk (8 and 2 classes); `lowercase` |
| eventuality | the TL;DR line, the sources block, the sign-off line | one slot each, paid when the line is complete |
| order | the TL;DR comes before the first item; no item after the sources header | none of their own: they read the eventualities' state |
| last | nothing after the sign-off; only source lines after the sources header | as above |
| count | exactly n items, n read from the new question (written as a digit or a word) | `items`, with the pointer reading n from the question, not from the examples' counts |

An answer is *coherent* when every monitor passes. Training labels are the monitors' own verdicts on every prefix, as
in the IFEval study (`test_state_labels_agree_with_the_monitors_on_every_prefix`).

**Data** (`pattern_data.py`). The frozen model answers plain questions ("What are 9 things to know about owls?") on 86
training topics; each answer is parsed into an intro and a list. A record takes an author, two example answers on other
topics (2 to 6 items), and a new question; its target is the model's own answer to that question, cut to n items
(2 to 10) and rendered in the house pattern: the words are the model's, only the form is imposed. 30% of training
inputs have up to 1,000 tokens of background notes between the examples and the question. Test prompts use 20
held-out topics and held-out sign-offs, n in {3, 6, 9, 12} (12 is longer than any training answer), 75 per n. Every
variant trains on the same records; the Ledger has 3.95M trainable parameters with these slots and LoRA has rank 69,
as in the IFEval study.

**Two lengths.** The output grows with n: the length exponent per item, κ, is minus the slope of log S(n), where S(n)
is the share of coherent answers at n items. The context grows with background notes between the examples and the
question (0, 2,000 and 6,000 tokens), so the evidence for the pattern recedes while the question stays close.

### Predictions, written before any run

1. **The length exponent (the key test).** At context 0, κ is smaller for the Ledger than for `lora`: the paired
   bootstrap interval of κ(ledger) − κ(lora) lies below 0. The same holds against `base`.
2. **Where the invariants break.** For every variant, invariant breaks concentrate on the first item: the hazard per
   opportunity is highest at item 1, where the pattern must be read from the examples, and low afterwards, when the
   model can copy its own items. The Ledger's gain on invariants is mostly at item 1.
3. **Debts and stopping.** The share of answers that end with a debt unpaid (no sign-off, no sources, too few items)
   grows with n for `base` and `lora`, and less for the Ledger. In `full`, removing the gate (`ledger_nogate`) loses
   part of that advantage, and more on the count and the sign-off than on the invariants.
4. **The count beyond training.** At n = 12 the Ledger gives exactly n items more often than `lora`, whose errors are
   mostly too few items (stopping early) or the examples' count.
5. **Context.** With 6,000 tokens between the examples and the question every variant keeps less; the Ledger loses
   less than `lora` (the paired bootstrap interval of the difference in change lies above 0).
6. **Fact 1.** `ledger_joint` does no better than `ledger`, at any n or context.

If prediction 1 fails, the paper will say so: the architecture's claim would then not reach rules learned from examples.

### Running it

```bash
./run_patterns.sh smoke                                  # plumbing (with tests/tiny.py: see the script's header)
./run_patterns.sh pilot                                  # one seed, 80 test prompts, contexts 0 and 2000
BATCH=64 ./run_patterns.sh full                          # the study: three seeds, every variant, 300 test prompts
DISTRACTORS=work/full/data/distractors.jsonl BATCH=64 ./run_patterns.sh full   # reuse the IFEval study's background text
```

On Windows, `run_patterns.ps1` (`pilot`, `full`, `smoke`) does the same. In Colab, cell 4 of `colab.ipynb` runs it
(`pilot`, then `colab`: two seeds, `base`, `lora`, `ledger` and `ledger_joint`, contexts 0 and 6,000); on Kaggle, set
`TASK = 'patterns'`. Outputs go to `work/patterns-<preset>/`; `results/summary.md` holds the tables: coherent share by
variant and shape, by n with κ, κ(ledger) − κ(control), hazards by item position, the count and unpaid debts, exact
McNemar tests, and the change with context.

## Running it (NVIDIA GPU, Mac, or CPU)

```bash
git clone https://github.com/ivi-137/ivi-137.github.io
cd ivi-137.github.io/research/ledger-smollm
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python setup_ifeval.py                                    # official IFEval checkers and prompts
python -m pytest -q tests                                 # 414 tests, about 15 s
./run_all.sh pilot                                        # one seed, 100 prompts, contexts 0 and 1000
BATCH=64 ./run_all.sh full                                # the study
```

- **NVIDIA on Linux:** `pip install torch` already includes CUDA. Check with
  `python -c "import torch; print(torch.cuda.is_available())"`. On Windows, see below.
- The scripts pick CUDA, then Apple's MPS, then the CPU (`DEVICE=cuda` forces one). The model downloads from
  Hugging Face on first use (270 MB).
- `BATCH` sets how many prompts are generated together (default 16). 64 suits a GPU with 8 GB or more; memory at long
  contexts is capped separately.
- On a GPU the frozen model runs in bfloat16 (`--dtype auto`), halving its memory; the Ledger and the adapters keep
  float32 parameters and compute their state in float32. Training batches are capped at 3,072 tokens and evaluation
  batches at 32,768, which fits a 4 GB laptop GPU with about 2.5 GB free: close other programs that use the GPU
  (games, browsers with hardware acceleration, chat apps) before a long run.
- Everything is resumable: rerunning skips finished steps, down to each context length of an evaluation. Outputs go
  to `work/<preset>/`.

### Google Colab

Open [`colab.ipynb` in Colab](https://colab.research.google.com/github/ivi-137/ivi-137.github.io/blob/main/research/ledger-smollm/colab.ipynb),
choose *Runtime → Change runtime type → T4 GPU*, and run its cells in order. It installs everything, runs the
tests, saves every result to Google Drive (so a disconnected session resumes where it stopped: run cell 1, then the
cell you were on), runs the pilot, then the `colab` preset, and downloads a zip of the results (cell 5). Cell 4 runs
the house-pattern study.

The notebook's `colab` run uses 2,000 training prompts × 4 samples (8,000 generations; `TRAIN_PROMPTS` in cell 3, or
`PROMPTS` for `run_all.sh`), where the preset itself uses 3,000 × 4, and keeps two epochs and the comparisons that
decide the claims: `base`, `lora`, `ledger` and `ledger_joint`, two seeds, all 541 IFEval prompts at 0 and 6,000
tokens of background (the endpoints of prediction 3). It leaves out the no-gate ablation, the third seed and the
intermediate lengths, which `full` adds. On a T4 (no native bfloat16) the frozen model runs in float32; on an L4 or
A100, in bfloat16. `EVAL_TOKENS` sets the size of evaluation batches; the notebook picks it from the GPU's memory and
halves it if a step runs out of memory.

### Kaggle

[`kaggle.ipynb`](kaggle.ipynb) is one cell: import it (*File → Import Notebook*, from this repository's GitHub link)
or paste the cell into a new notebook. In the settings panel choose *Accelerator: GPU T4 x2* and *Internet: on*. Run
it once with `STUDY = 'pilot'`; then set `STUDY = 'kaggle'` (the same study as `colab`) and use *Save Version → Save &
Run All (Commit)*, which keeps running with the browser closed and saves the results as the version's output. With two
GPUs, one builds the data while the other scores the frozen model, then each trains and scores its share of the seeds.
The run stops itself and packs what is done before its time budget (`TIME_BUDGET_H`, 8.5 hours); to continue, add
the notebook's previous version as an input (*Add Input → Your Work*) and run it again: finished steps are copied and
skipped. Files are written whole and then renamed, so a stopped run never leaves a partial result behind.

### Windows (PowerShell, NVIDIA GPU)

Open PowerShell (not as administrator) and run one line at a time. `run_all.ps1` does what `run_all.sh` does and uses
`.venv\Scripts\python.exe` by itself, so nothing has to be activated.

```powershell
cd $HOME
git clone https://github.com/ivi-137/ivi-137.github.io
cd ivi-137.github.io\research\ledger-smollm
py -3.12 -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
# PyTorch with CUDA: the command from https://pytorch.org/get-started/locally/ (Stable, Windows, Pip, Python, the
# highest CUDA not above the "CUDA Version" that nvidia-smi prints), run through the venv, for example:
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu130
.venv\Scripts\python -m pip install -r requirements.txt
.venv\Scripts\python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
.venv\Scripts\python setup_ifeval.py
.venv\Scripts\python -m pytest -q tests
powershell -ExecutionPolicy Bypass -File .\run_all.ps1 pilot
powershell -ExecutionPolicy Bypass -File .\run_all.ps1 full -Batch 64
```

Missing tools: `winget install --id Git.Git -e` and `winget install --id Python.Python.3.12 -e`, then reopen PowerShell.
Install PyTorch with CUDA *before* `requirements.txt`, or pip installs the CPU build first.

**Time.** Measured in the development sandbox (4 CPU cores, a random model of SmolLM2-135M's exact shape): generation
about 190 tokens/s in batches of 16, training about 440 tokens/s, reading a 4,000-token prompt 3.6 s. From these:

| | 4 CPU cores | one NVIDIA GPU (estimate, typically 20-50× faster) |
|---|---|---|
| `pilot` | under an hour | a few minutes |
| `full` | 3 to 4 days | 2 to 6 hours |

Most of the full study is evaluation (13 models × 541 prompts × 5 context lengths).

## Sending the results back

Everything needed for the paper is in `work/full/results/summary.json` and `summary.md`, plus `work/full/data/stats.json`
and each `work/full/runs/*/run.json`. Commit those (the per-prompt `*.jsonl` files too, if size allows) on a new branch
and push, or paste `summary.md`.

## Files

| File | Role |
|---|---|
| `obligations.py` | IFEval types as typed slots; per-token labels from the checkers' definitions |
| `ledger.py` | the Ledger, the shared-softmax and LoRA controls, training loss, prefill and decoding |
| `chat.py` | chat encoding, numbers in prompts, batched decoding with the Ledger's state |
| `batching.py` | training examples and batches |
| `data.py` | prompts, targets (samples and exact repairs), background passages |
| `train.py`, `evaluate.py`, `analyze.py` | training, official IFEval at several lengths, statistics (Wilson, exact McNemar, paired bootstrap) |
| `run_all.sh`, `run_all.ps1` | the whole study (`smoke`, `pilot`, `full`; `colab` and `kaggle` in bash), for bash and for Windows PowerShell |
| `patterns.py` | the house-pattern study: authors, rendering, monitors for all five shapes, slots and per-token labels, hazards |
| `pattern_data.py`, `pattern_eval.py`, `pattern_analyze.py` | its data (the model's own answers in a house pattern), evaluation at several contexts, statistics (κ and its paired difference, hazards by item position, McNemar, bootstrap) |
| `run_patterns.sh`, `run_patterns.ps1` | the house-pattern study, with the same presets |
| `book_fixtures.py` | parity fixtures for the clerk's book in the blog post (a TypeScript port of the monitors and the clerk), checked by `scripts/check-book.mts` |
| `shapes.py`, `specs.py`, `stats.py` | the shapes and number reading shared by both studies; which obligation set a Ledger keeps; Wilson and McNemar |
| `colab.ipynb` | both studies on a Colab GPU, with results kept on Google Drive and downloaded as a zip |
| `kaggle.ipynb` | either study on Kaggle's two T4 GPUs in parallel, with a time budget and resuming from a previous version's output |
| `tests/` | label agreement with the checkers and with the pattern monitors; every pattern break caught by its monitor; two examples determine the rules; the analysis recovers known exponents; identity at insertion (float32 and bfloat16); open gates change the function; decoding equals a full pass; batched equals single generation; gradients reach only the Ledger; monotone state; blocked and recomputed attention equal whole, gradients included |
