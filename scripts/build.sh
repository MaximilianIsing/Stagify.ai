#!/usr/bin/env sh
# Unified Render build (wired in via render.yaml's buildCommand):
#   1. install dependencies — exactly the locked tree, matching what CI verified
#   2. run the test suite — the DEPLOY GATE
#   3. audit prod dependencies for known-high advisories — the DEPLOY GATE
#   4. fetch the Litestream binary into ./bin for the runtime backup replication
#
# `set -e` means any failing step aborts the build. In particular a failing
# `npm test` or `npm audit` stops here and BLOCKS the deploy — the previously-live
# version keeps serving. The litestream download is pinned for reproducibility.
set -e

# `npm ci` not `npm install`: .github/workflows/ci.yml verifies the tree with
# `npm ci` (lockfile-exact), so `npm install` here could re-resolve semver ranges
# and deploy a different dependency tree than the one CI actually tested. `npm ci`
# also skips resolution entirely, so it's faster and lower-overhead. It fails if
# package.json and package-lock.json have drifted out of sync — that's the point,
# not a side effect.
echo "[build] installing dependencies…"
npm ci

echo "[build] running tests (deploy gate)…"
npm test

# This audit already runs in CI, but `autoDeploy: false` means deploys are a
# manual, separate step from CI — without this, a manual deploy could ship a
# known-high advisory that CI would have flagged on the branch.
echo "[build] auditing prod dependencies (deploy gate)…"
npm audit --omit=dev --audit-level=high

# --- Litestream binary — used at runtime to replicate the SQLite DB to R2 ---
VERSION="v0.3.13"
URL="https://github.com/benbjohnson/litestream/releases/download/${VERSION}/litestream-${VERSION}-linux-amd64.tar.gz"
mkdir -p ./bin
echo "[build] downloading litestream ${VERSION}…"
curl -fsSL "$URL" | tar -xz -C ./bin litestream
chmod +x ./bin/litestream
./bin/litestream version
echo "[build] done."
