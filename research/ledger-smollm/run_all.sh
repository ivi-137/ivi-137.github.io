#!/usr/bin/env bash
# The whole study, resumable (finished steps are skipped).
#
#   ./run_all.sh pilot   one seed, 3 variants, 100 IFEval prompts, contexts 0 and 1000 tokens:
#                        checks everything end to end (under an hour on a laptop CPU, minutes on a Mac or GPU)
#   ./run_all.sh full    three seeds, every variant, all 541 prompts, contexts 0 to 6000 tokens
#
#   ./run_all.sh smoke   plumbing check on any model in seconds (with tests/tiny.py's stand-in: TRAIN_ARGS="--clerk-layer 1 --width 32")
#
# Environment: MODEL (default SmolLM2-135M-Instruct), DEVICE (auto|cpu|mps|cuda), OUT (default work/<preset>),
#              PYTHON (default python), TRAIN_ARGS (extra arguments for train.py),
#              BATCH (prompts generated together, default 16; 64 suits a GPU with 8 GB or more)
set -euo pipefail
cd "$(dirname "$0")"
PRESET=${1:-pilot}
MODEL=${MODEL:-HuggingFaceTB/SmolLM2-135M-Instruct}
PY=${PYTHON:-python}
TRAIN_ARGS=${TRAIN_ARGS:-}
BATCH=${BATCH:-16}
DEVICE=${DEVICE:-auto}
OUT=${OUT:-work/$PRESET}
case "$PRESET" in
  pilot) PROMPTS=300;  SAMPLES=2; PASSAGES=20;  GEN=256; EPOCHS=1; SEEDS="0";     LENGTHS="0 1000";                 LIMIT=100; MAXNEW=384;  VARIANTS="lora ledger ledger_joint" ;;
  full)  PROMPTS=3000; SAMPLES=4; PASSAGES=200; GEN=512; EPOCHS=2; SEEDS="0 1 2"; LENGTHS="0 1000 2000 4000 6000"; LIMIT=0;   MAXNEW=1024; VARIANTS="lora ledger ledger_joint ledger_nogate" ;;
  smoke) PROMPTS=40;   SAMPLES=2; PASSAGES=4;   GEN=32;  EPOCHS=1; SEEDS="0";     LENGTHS="0 64";                   LIMIT=6;   MAXNEW=16;   VARIANTS="lora ledger ledger_joint ledger_nogate" ;;
  *) echo "usage: $0 pilot|full|smoke"; exit 1 ;;
esac

[ -d vendor/instruction_following_eval ] || $PY setup_ifeval.py
[ -f "$OUT/data/train.jsonl" ] || $PY data.py --model "$MODEL" --device "$DEVICE" --out "$OUT/data" \
  --prompts $PROMPTS --samples $SAMPLES --passages $PASSAGES --max-new-tokens $GEN --batch-size $BATCH
for seed in $SEEDS; do
  for v in $VARIANTS; do
    [ -f "$OUT/runs/$v-s$seed/weights.pt" ] || $PY train.py --model "$MODEL" --device "$DEVICE" --variant $v --seed $seed \
      --data "$OUT/data/train.jsonl" --out "$OUT/runs" --epochs $EPOCHS $TRAIN_ARGS
  done
done
last=${LENGTHS##* }
[ -f "$OUT/results/base-L$last.jsonl" ] || $PY evaluate.py --model "$MODEL" --device "$DEVICE" --variant base \
  --lengths $LENGTHS --limit $LIMIT --max-new-tokens $MAXNEW --batch-size $BATCH --distractors "$OUT/data/distractors.jsonl" --out "$OUT/results"
for seed in $SEEDS; do
  for v in $VARIANTS; do
    [ -f "$OUT/results/$v-s$seed-L$last.jsonl" ] || $PY evaluate.py --model "$MODEL" --device "$DEVICE" --run "$OUT/runs/$v-s$seed" \
      --lengths $LENGTHS --limit $LIMIT --max-new-tokens $MAXNEW --batch-size $BATCH --distractors "$OUT/data/distractors.jsonl" --out "$OUT/results"
  done
done
$PY analyze.py --results "$OUT/results"
echo "done: $OUT/results/summary.md"
