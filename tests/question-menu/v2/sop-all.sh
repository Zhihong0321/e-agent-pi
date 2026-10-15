#!/usr/bin/env bash
# Runs S1,S2,S3,S3b,S4 three times each, one at a time (documents are attributed to a run by time window).
# REP=<fixtures rep> RUN=<run id> override the defaults (15, sop-discount-2026-10-15).
REP="${REP:-15}"; RUN="${RUN:-sop-discount-2026-10-15}"
cd "$(dirname "$0")/../../.."
mkdir -p "tests/question-menu/v2/evidence/$RUN"
for n in 1 2 3; do for c in S1 S2 S3 S3b S4; do
  echo "== $c $n $(date +%T)"
  node tests/question-menu/v2/sop-run.mjs --rep $REP --run-id $RUN --case $c --n $n > tests/question-menu/v2/evidence/$RUN/console-$c-$n.txt 2>&1 || echo "driver failed $c $n"
  tail -c 600 tests/question-menu/v2/evidence/$RUN/console-$c-$n.txt | tr '\n' ' ' | cut -c1-400; echo
done; done
echo ALL-DONE
