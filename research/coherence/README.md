# You need coherence: the experiment

Code, logs and results behind the post `src/content/posts/you-need-coherence.mdx`.

| file | what it does |
|---|---|
| `toy.py` | The task (an author's house style, example posts, a request in the default style), the monitors that audit a written post, and the style group: frame reading by counting and the canonical frame |
| `model.py` | A small decoder-only transformer (pre-LN, RoPE, tied embeddings), the Ledger, gauge fixing, eviction of the examples, and the placement variants |
| `train.py` | Trains one variant: `python train.py --variant ledger --seed 0 --steps 1500` |
| `evaluate.py` | Samples posts (the same prompts for every run, temperature 1) and audits them; measures attention on the example posts |
| `records.py` | Loads every evaluated run and re-audits its stored outputs with the current monitors; per-token cost model |
| `aggregate.py` | Writes `results/summary.json` (and `results/screen/summary.json` with `--screen`), which the post reads at build time |
| `analyze.py` | Per-opportunity hazards with Wilson intervals, the font hazard by paragraph, exact McNemar tests against the baseline (`results/hazards.json`) |
| `check_symmetry.py` | Checks that the style group acts by a homomorphism, that every monitor is equivariant, and that the frame is read exactly |
| `export.py`, `parity.py` | Float16 weights for the page (`public/coherence/`) and reference logits for `scripts/check-coherence-net.mts` |
| `queue.sh`, `queue2.sh` | Run lists of `variant:seed` jobs on chosen cores |

Setup: `python -m venv venv && venv/bin/pip install "jax[cpu]" optax numpy` (JAX 0.10, optax 0.2). Everything ran on four CPU cores.

**Full protocol** (1,500 steps, 300 prompts): `base` (seeds 0, 1), `base_aux` (0), `ledger` (0, 1), `ledger_joint` (0), `ledger_frame` (1), `ledger_frame_evict` (0).
**Placement screen** (400 steps, 100 prompts, seed 0, `--tag=-screen`, results in `results/screen/`): `base`, `ledger_joint`, `ledger_pre`, `ledger`, `ledger_top`, `ledger_film`, `ledger_logit`.
Variants defined but not run within the budget: `base_frame`, `ledger_nogate`, `ledger_nosup`.

Trained parameters (`runs/*.pkl`) are not committed; `logs/` has every training curve and `results/` every audited sample.
