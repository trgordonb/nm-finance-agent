#!/usr/bin/env bash
# Prune a node_modules tree down to what the container mirror actually needs.
#
# MUST run in the same Docker layer as `npm ci` (see container/Dockerfile):
# pruning in a later RUN leaves the removed bytes inside the lower layer's
# blob — they disappear from the merged filesystem but are still uploaded.
#
# Validated against a hardlink clone with the container smoke test; re-run it
# locally after touching the list:
#   CL=~/.cache/mirror-prune-test
#   rm -rf "$CL" && mkdir -p "$CL" && cp -al node_modules "$CL/node_modules"
#   bash container/prune-node-modules.sh "$CL/node_modules"
#
# Usage: prune-node-modules.sh [path/to/node_modules]   (default: node_modules)
set -euo pipefail
NM="${1:-node_modules}"
[ -d "$NM" ] || { echo "no such node_modules: $NM" >&2; exit 1; }

# onnxruntime-node ships every platform + GPU providers; the mirror is
# linux/amd64 CPU only. 548MB -> ~47MB.
rm -rf "$NM"/onnxruntime-node/bin/napi-v6/darwin \
       "$NM"/onnxruntime-node/bin/napi-v6/win32 \
       "$NM"/onnxruntime-node/bin/napi-v6/linux/arm64
rm -f  "$NM"/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so \
       "$NM"/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_tensorrt.so

# Not on the mirror's import path: browser/wasm ORT, agentdb's sqlite/lab
# extras, ruvector's service-level deps, repo server deps.
# KEEP sharp/@img: transformers.node.mjs imports sharp at load even for
# text-only use — without it agentdb silently falls back to MOCK embeddings.
rm -rf "$NM"/onnxruntime-web \
       "$NM"/@opentelemetry \
       "$NM"/better-sqlite3 \
       "$NM"/sql.js \
       "$NM"/express \
       "$NM"/@modelcontextprotocol \
       "$NM"/@metaharness \
       "$NM"/metaharness \
       "$NM"/zod \
       "$NM"/rxjs \
       "$NM"/js-yaml \
       "$NM"/dotenv \
       "$NM"/ajv \
       "$NM"/jsonwebtoken \
       "$NM"/chalk \
       "$NM"/commander \
       "$NM"/ora \
       "$NM"/ruvector-attention-wasm \
       "$NM"/ruvector-graph-transformer-wasm

# ruvector: keep @ruvector/core (+ its linux-x64-gnu binary); the VectorDB
# path never loads the attention/gnn/router/llm/tiny-dancer/rvf extras.
rm -rf "$NM"/@ruvector/attention \
       "$NM"/@ruvector/attention-linux-x64-gnu \
       "$NM"/@ruvector/gnn \
       "$NM"/@ruvector/gnn-linux-x64-gnu \
       "$NM"/@ruvector/router \
       "$NM"/@ruvector/router-linux-x64-gnu \
       "$NM"/@ruvector/ruvllm \
       "$NM"/@ruvector/ruvllm-linux-x64-gnu \
       "$NM"/@ruvector/sona \
       "$NM"/@ruvector/sona-linux-x64-gnu \
       "$NM"/@ruvector/tiny-dancer \
       "$NM"/@ruvector/tiny-dancer-linux-x64-gnu \
       "$NM"/@ruvector/graph-node \
       "$NM"/@ruvector/graph-node-linux-x64-gnu \
       "$NM"/@ruvector/graph-transformer \
       "$NM"/@ruvector/graph-transformer-linux-x64-gnu \
       "$NM"/@ruvector/rvf \
       "$NM"/@ruvector/rvf-node \
       "$NM"/@ruvector/rvf-node-linux-x64-gnu \
       "$NM"/@ruvector/rvf-solver \
       "$NM"/@ruvector/rvf-wasm

echo "pruned $NM -> $(du -sh "$NM" 2>/dev/null | cut -f1)"
