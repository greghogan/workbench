#!/bin/sh
set -eu
variant=$1
trial=/tmp/workbench-llvm-cache-7WpcIYf8
if [ "$variant" = reduced ]; then
  docker run --rm --network=host --user 1000:1000 \
    --mount "type=bind,src=$trial,dst=/workspace" \
    --tmpfs /workspace/full:rw,size=1m,mode=755 \
    --tmpfs /workspace/reduced:rw,size=1m,mode=755 \
    --tmpfs /workspace/restored-full:rw,size=1m,mode=755 \
    workbench-llvm-cache-verification:20261009 \
    python3 /workspace/verify.py reduced
else
  docker run --rm --network=host --user 1000:1000 \
    --mount "type=bind,src=$trial,dst=/workspace" \
    workbench-llvm-cache-verification:20261009 \
    python3 /workspace/verify.py full
fi
