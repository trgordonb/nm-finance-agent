#!/usr/bin/env bash
# Stash the locally cached embedding model into the container build context.
# Run once before `wrangler deploy` (and again if the model ever changes).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="node_modules/@huggingface/transformers/.cache/Xenova/all-MiniLM-L6-v2"
DST="container/model/all-MiniLM-L6-v2"
if [ ! -d "$SRC" ]; then
  echo "model cache missing: $SRC" >&2
  echo "run the local mirror once (a chat turn) so transformers.js downloads it, then retry" >&2
  exit 1
fi
mkdir -p "$(dirname "$DST")"
rm -rf "$DST"
cp -r "$SRC" "$DST"
du -sh "$DST"
