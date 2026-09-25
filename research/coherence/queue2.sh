#!/bin/sh
# Jobs on one core, in order. Entries: variant:seed (train, then evaluate),
# eval:variant:seed (evaluate only), wait:PID (wait for a running process to exit).
#   ./queue2.sh 0 wait:1234 eval:base:1 ledger_frame:0 ...
core=$1; shift
PY=${PY:-python}
for job in "$@"; do
  case "$job" in
    wait:*) pid=${job#wait:}; while kill -0 "$pid" 2>/dev/null; do sleep 10; done ;;
    eval:*) vs=${job#eval:}; v=${vs%:*}; s=${vs#*:}
      taskset -c "$core" $PY evaluate.py "runs/$v-s$s.pkl" >> "logs/$v-s$s.log" 2>&1 || echo "FAIL eval $v $s"
      echo "DONE $v $s $(tail -n 1 logs/$v-s$s.log | cut -c1-160)" ;;
    *) v=${job%:*}; s=${job#*:}
      taskset -c "$core" $PY train.py --variant "$v" --seed "$s" --steps 1500 > "logs/$v-s$s.log" 2>&1 || { echo "FAIL train $v $s"; continue; }
      taskset -c "$core" $PY evaluate.py "runs/$v-s$s.pkl" >> "logs/$v-s$s.log" 2>&1 || echo "FAIL eval $v $s"
      echo "DONE $v $s $(tail -n 1 logs/$v-s$s.log | cut -c1-160)" ;;
  esac
done
echo "QUEUE $core FINISHED"
