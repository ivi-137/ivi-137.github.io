# The Ledger on a real model: SmolLM2-135M-Instruct

The paper *You Need Coherence* tests the Ledger on a 155k-parameter model trained from scratch on a synthetic task.
This directory takes the next step: it retrofits the Ledger to a **pretrained, frozen instruction model**
([SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct), 135M parameters, 8,192-token
context) and measures it on the standard instruction benchmark **IFEval** (541 prompts, official checkers), at
growing context lengths.

**Status.** The code is complete and tested on a random-weight model of the same architecture: 259 tests (below),
plus the whole pipeline end to end (`./run_all.sh smoke`). **No results on the real SmolLM2 exist yet.** The
predictions below were written before any run.

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

## Running it (NVIDIA GPU, Mac, or CPU)

```bash
git clone https://github.com/ivi-137/ivi-137.github.io
cd ivi-137.github.io/research/ledger-smollm
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python setup_ifeval.py                                    # official IFEval checkers and prompts
python -m pytest -q tests                                 # 259 tests, about 10 s
./run_all.sh pilot                                        # one seed, 100 prompts, contexts 0 and 1000
BATCH=64 ./run_all.sh full                                # the study
```

- **NVIDIA on Linux:** `pip install torch` already includes CUDA. Check with
  `python -c "import torch; print(torch.cuda.is_available())"`. On Windows, see below.
- The scripts pick CUDA, then Apple's MPS, then the CPU (`DEVICE=cuda` forces one). The model downloads from
  Hugging Face on first use (270 MB).
- `BATCH` sets how many prompts are generated together (default 16). 64 suits a GPU with 8 GB or more; memory at long
  contexts is capped separately.
- Everything is resumable: rerunning skips finished steps. Outputs go to `work/<preset>/`.

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
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu128
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
| `run_all.sh`, `run_all.ps1` | the whole study (`smoke`, `pilot`, `full`), for bash and for Windows PowerShell |
| `tests/` | label agreement with the checkers; identity at insertion; open gates change the function; decoding equals a full pass; batched equals single generation; gradients reach only the Ledger; monotone state; blocked attention equals whole |
