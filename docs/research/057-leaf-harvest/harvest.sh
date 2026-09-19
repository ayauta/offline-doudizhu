#!/usr/bin/env bash
# Harvest calibration seeds 5001-5400 across 8 processes.
set -u
cd /home/andy/code/wx_doudizhu
source scripts/activate-toolchain.sh

OUT=/tmp/e1h/shards
rm -rf "$OUT"; mkdir -p "$OUT"
TOTAL=400
JOBS=8
PER=$((TOTAL / JOBS))

for i in $(seq 0 $((JOBS - 1))); do
  start=$((5001 + i * PER))
  (
    AI_BENCH_DEAL_START="$start" AI_BENCH_DEALS="$PER" AI_BENCH_SEED=0 \
    AI_BENCH_SECONDS=1200 \
    AI_BENCH_HARVEST_OUT="$OUT/shard-$(printf '%02d' "$i").json" \
    pnpm exec vitest run --config vitest.benchmark.config.ts \
      benchmarks/zz-leaf-harvest.test.ts > "$OUT/shard-$(printf '%02d' "$i").log" 2>&1
    echo "shard $i (deals $start..$((start + PER - 1))) exit=$?"
  ) &
done
wait
echo "HARVEST DONE"
ls -la "$OUT" | head
