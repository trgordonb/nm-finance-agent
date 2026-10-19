# Mirror sidecar (container edition) — Cloudflare Containers, linux/amd64.
#
# Build context MUST be the repo root (container/wrangler.jsonc sets
# build_context: "..") so package manifest + lockfile are available.
# Run ./container/pack-model.sh first — it stashes the locally cached
# Xenova/all-MiniLM-L6-v2 model into container/model/ for the COPY below.
#
# CPU-only by construction: the install tree is pruned from ~1.1GB to ~175MB
# (platform/GPU onnxruntime binaries, browser ORT, agentdb extras — see
# prune-node-modules.sh), the model is baked in, and the runtime is plain
# node + ESM (no tsx, no build step on boot). KEEP sharp/@img: transformers
# imports sharp at load, and its absence flips agentdb to mock embeddings.

FROM node:24-slim

WORKDIR /app

# Same dependency tree as the local harness, lockfile-pinned, then pruned to
# what the mirror imports. ONE RUN on purpose: pruning in a later layer would
# leave the removed bytes inside this layer's blob — invisible in the merged
# filesystem, but still uploaded (~1.1GB tree -> ~175MB install after prune).
COPY package.json package-lock.json ./
COPY container/prune-node-modules.sh container/prune-node-modules.sh
RUN npm ci --omit=dev --no-audit --no-fund && \
    bash container/prune-node-modules.sh node_modules && \
    rm -rf /root/.npm   # npm's tarball cache would otherwise stay in this layer (~190MB)

# Bake the embedding model exactly where transformers.js looks for it.
COPY container/model/all-MiniLM-L6-v2 node_modules/@huggingface/transformers/.cache/Xenova/all-MiniLM-L6-v2

COPY container/server.mjs container/server.mjs

# The ruvector/redb store lives on the writable disk; the Durable Object
# snapshots it (see worker.ts).
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production \
    PORT=8080 \
    AGENTDB_PATH=/data/agent-mirror.db

USER node
EXPOSE 8080
CMD ["node", "/app/container/server.mjs"]
