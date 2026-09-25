#!/bin/sh
# Train and evaluate a list of variant:seed jobs on the given cores, one after another.
#   ./queue.sh 0,1 base_aux:0 ledger_joint:1 ...
cores=$1; shift
PY=${PY:-python}
for job in "$@"; do
  v=${job%:*}; s=${job#*:}
  taskset -c "$cores" $PY train.py --variant "$v" --seed "$s" --steps 1500 > "logs/$v-s$s.log" 2>&1 || { echo "FAIL train $v $s"; continue; }
  taskset -c "$cores" $PY evaluate.py "runs/$v-s$s.pkl" >> "logs/$v-s$s.log" 2>&1 || echo "FAIL eval $v $s"
  echo "DONE $v $s $(tail -n 1 logs/$v-s$s.log | cut -c1-160)"
done
