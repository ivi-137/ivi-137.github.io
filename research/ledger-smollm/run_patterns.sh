#!/usr/bin/env bash
# The house-pattern study (patterns.py), resumable (finished steps are skipped).
#
#   ./run_patterns.sh pilot   one seed, the Ledger, LoRA and the shared-softmax control, 20 test prompts per n,
#                             contexts 0 and 2000: checks everything end to end
#   ./run_patterns.sh full    three seeds, every variant, 75 test prompts per n (300), contexts 0, 2000 and 6000
#   ./run_patterns.sh colab   sized for one Colab GPU: two seeds, the Ledger, LoRA and the shared-softmax control,
#                             300 test prompts at contexts 0 and 6000
#   ./run_patterns.sh kaggle  the same as colab (the Kaggle notebook can split it over two GPUs with STEPS and SEEDS)
#   ./run_patterns.sh smoke   plumbing check in seconds (with tests/tiny.py's stand-in: TRAIN_ARGS="--clerk-layer 1 --width 32")
#
# Environment as for run_all.sh: MODEL, DEVICE, OUT (default work/patterns-<preset>), PYTHON, TRAIN_ARGS, BATCH,
# EVAL_TOKENS, STEPS ("data train base eval analyze"), SEEDS, PROMPTS, PLAN=1, and DISTRACTORS (reuse the IFEval study's
# background passages instead of generating new ones).
set -euo pipefail
cd "$(dirname "$0")"
PRESET=${1:-pilot}
MODEL=${MODEL:-HuggingFaceTB/SmolLM2-135M-Instruct}
PY=${PYTHON:-python}
TRAIN_ARGS=${TRAIN_ARGS:-}
BATCH=${BATCH:-16}
DEVICE=${DEVICE:-auto}
OUT=${OUT:-work/patterns-$PRESET}
EVAL_TOKENS=${EVAL_TOKENS:-32768}
STEPS=" ${STEPS:-data train base eval analyze} "
SEEDS_OVERRIDE=${SEEDS:-}
PROMPTS_OVERRIDE=${PROMPTS:-}
DISTRACTORS=${DISTRACTORS:-}
want() { [[ "$STEPS" == *" $1 "* ]]; }
case "$PRESET" in
  pilot) PROMPTS=400;  PER_TOPIC=2; SAMPLES=1; PASSAGES=20;  TOPICS=0;  TEST=20; EPOCHS=1; SEEDS="0";     LENGTHS="0 2000";      MAXNEW=768;  VARIANTS="lora ledger ledger_joint" ;;
  full)  PROMPTS=3000; PER_TOPIC=4; SAMPLES=2; PASSAGES=200; TOPICS=0;  TEST=75; EPOCHS=2; SEEDS="0 1 2"; LENGTHS="0 2000 6000"; MAXNEW=1024; VARIANTS="lora ledger ledger_joint ledger_nogate" ;;
  colab|kaggle) PROMPTS=3000; PER_TOPIC=4; SAMPLES=2; PASSAGES=200; TOPICS=0; TEST=75; EPOCHS=2; SEEDS="0 1"; LENGTHS="0 6000"; MAXNEW=1024; VARIANTS="lora ledger ledger_joint" ;;
  smoke) PROMPTS=40;   PER_TOPIC=2; SAMPLES=1; PASSAGES=4;   TOPICS=8;  TEST=2;  EPOCHS=1; SEEDS="0";     LENGTHS="0 64";        MAXNEW=24;   VARIANTS="lora ledger ledger_joint ledger_nogate" ;;
  *) echo "usage: $0 pilot|full|colab|kaggle|smoke"; exit 1 ;;
esac
if [ -n "$SEEDS_OVERRIDE" ]; then SEEDS=$SEEDS_OVERRIDE; fi
if [ -n "$PROMPTS_OVERRIDE" ]; then PROMPTS=$PROMPTS_OVERRIDE; fi
if [ "${PLAN:-0}" = 1 ]; then printf '%s\n' "$SEEDS" "$VARIANTS" "$LENGTHS"; exit 0; fi
GEN=$([ "$PRESET" = smoke ] && echo 48 || echo 640)
STAND_INS=$([ "$PRESET" = smoke ] && echo --stand-ins || true)  # a random-weight stand-in writes no lists

want data && { [ -f "$OUT/data/train.jsonl" ] || $PY pattern_data.py --model "$MODEL" --device "$DEVICE" --out "$OUT/data" \
  --prompts $PROMPTS --per-topic $PER_TOPIC --samples $SAMPLES --passages $PASSAGES --topics $TOPICS --test-per-n $TEST \
  --max-new-tokens $GEN --batch-size $BATCH $STAND_INS ${DISTRACTORS:+--distractors "$DISTRACTORS"}; }
want train && for seed in $SEEDS; do
  for v in $VARIANTS; do
    [ -f "$OUT/runs/$v-s$seed/weights.pt" ] || $PY train.py --model "$MODEL" --device "$DEVICE" --variant $v --seed $seed --spec patterns \
      --data "$OUT/data/train.jsonl" --out "$OUT/runs" --epochs $EPOCHS $TRAIN_ARGS
  done
done
last=${LENGTHS##* }
want base && { [ -f "$OUT/results/base-L$last.jsonl" ] || $PY pattern_eval.py --model "$MODEL" --device "$DEVICE" --variant base \
  --test "$OUT/data/test.jsonl" --distractors "$OUT/data/distractors.jsonl" --lengths $LENGTHS --max-new-tokens $MAXNEW \
  --batch-size $BATCH --max-batch-tokens $EVAL_TOKENS --out "$OUT/results"; }
want eval && for seed in $SEEDS; do
  for v in $VARIANTS; do
    [ -f "$OUT/results/$v-s$seed-L$last.jsonl" ] || $PY pattern_eval.py --model "$MODEL" --device "$DEVICE" --run "$OUT/runs/$v-s$seed" \
      --test "$OUT/data/test.jsonl" --distractors "$OUT/data/distractors.jsonl" --lengths $LENGTHS --max-new-tokens $MAXNEW \
      --batch-size $BATCH --max-batch-tokens $EVAL_TOKENS --out "$OUT/results"
  done
done
if want analyze; then
  $PY pattern_analyze.py --results "$OUT/results"
  echo "done: $OUT/results/summary.md"
fi
