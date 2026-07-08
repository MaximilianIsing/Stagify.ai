#!/usr/bin/env sh
# Unified Render build (wired in via render.yaml's buildCommand):
#   1. install dependencies
#   2. run the test suite — the DEPLOY GATE
#   3. fetch the Litestream binary into ./bin for the runtime backup replication
#
# `set -e` means any failing step aborts the build. In particular a failing
# `npm test` stops here and BLOCKS the deploy — the previously-live version keeps
# serving. The litestream download is pinned for reproducibility.
set -e

echo "[build] installing dependencies…"
npm install

echo "[build] running tests (deploy gate)…"
npm test

# --- Litestream binary — used at runtime to replicate the SQLite DB to R2 ---
VERSION="v0.3.13"
URL="https://github.com/benbjohnson/litestream/releases/download/${VERSION}/litestream-${VERSION}-linux-amd64.tar.gz"
mkdir -p ./bin
echo "[build] downloading litestream ${VERSION}…"
curl -fsSL "$URL" | tar -xz -C ./bin litestream
chmod +x ./bin/litestream
./bin/litestream version
echo "[build] done."
