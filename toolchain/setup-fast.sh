#!/usr/bin/env bash
# setup-fast.sh — rebuild the harness working environment after a sandbox
# reset, in ONE command. Cold path (from the persisted toolchain/): ~2-3 min,
# dominated by tarball extraction. Warm path (env already in /work): instant.
#
# WHY THIS LAYOUT (hard-won sandbox facts):
#   - /home/user is snapshotted (~128 MB / 10k-file best-effort cap) and
#     EXCLUDES node_modules and .git/config → a repo there can never survive;
#     a 13k-file repo there also bloats every turn-end snapshot (slow turns).
#   - /tmp is a 993 MB tmpfs (RAM-backed) → a repo + deps there fills it
#     (ENOSPC) and eats the RAM that tests need (OOM-137s).
#   - / is a real disk with ~19 GB free → /work is the only sane home for
#     the repo + deps. It persists while the sandbox lives; GitHub (pushed
#     every build) is the durable source of truth.
#   - pnpm cannot install the full 2700-package lockfile in 2 GB RAM (OOMs
#     at resolution). The minimal npm set (~30 pkgs, harness suites +
#     typecheck verified green) is packaged in toolchain/node_modules-min.tar.xz.
#
# Layout after this script:
#   /work/node-v22.23.2-linux-x64/    node toolchain
#   /work/minstall/                   minimal deps (real files)
#   /work/omniroute/                  working clone (shallow, fork/parallel-execution)
#   /work/omniroute/node_modules/     symlinks → /work/minstall/node_modules
#       + tsconfig.fastcheck.json + .fastcheck-stubs/ (typecheck wrapper:
#         stubs playwright + @huggingface/transformers so tsc needs no 50 MB trees)
#
# Usage:  bash /home/user/omniroute-fork/toolchain/setup-fast.sh [quick-test]
#         quick-test → also runs the harness-b4 suite to verify the env.
set -uo pipefail

TOOL_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_VER=v22.23.2
NODE_DIR="/work/node-$NODE_VER-linux-x64"
ROOT=/work/omniroute
BRANCH=fork/parallel-execution

# ── 1. node ─────────────────────────────────────────────────────────────────
if [ ! -x "$NODE_DIR/bin/node" ]; then
  TARBALL="$TOOL_DIR/node-$NODE_VER-linux-x64.tar.xz"
  if [ ! -f "$TARBALL" ]; then
    echo "[setup] downloading node $NODE_VER (caching into toolchain/)"
    curl -fsSL -o "$TARBALL" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz"
  fi
  echo "[setup] extracting node"
  tar -xJf "$TARBALL" -C /work
fi
export PATH="$NODE_DIR/bin:$PATH"

# ── 2. repo (shallow; PAT not needed to clone — pushes use the inline
#        credential helper as always) ────────────────────────────────────────
if [ ! -d "$ROOT/.git" ]; then
  echo "[setup] cloning $BRANCH (shallow)"
  git clone --depth 1 -b "$BRANCH" https://github.com/Ansh-Kar/OmniRoute.git "$ROOT"
fi
cd "$ROOT"

# ── 3. deps: extract the minimal set once, then (re)link into the repo ─────
if [ ! -x /work/minstall/node_modules/.bin/tsc ]; then
  echo "[setup] extracting minimal deps tarball (~30-60s)"
  mkdir -p /work/minstall
  tar -xJf "$TOOL_DIR/node_modules-min.tar.xz" -C /work/minstall
fi

echo "[setup] linking node_modules → /work/minstall"
mkdir -p node_modules/@omniroute
ln -sfn /work/minstall/node_modules/* node_modules/ 2>/dev/null
ln -sfn /work/minstall/node_modules/.bin node_modules/.bin
ln -sfn "$ROOT/open-sse" node_modules/@omniroute/open-sse

# ── 4. fastcheck kit (typecheck wrapper; local-only, never committed) ───────
cp -f "$TOOL_DIR/fastcheck-kit/tsconfig.fastcheck.json" "$ROOT/tsconfig.fastcheck.json"
mkdir -p "$ROOT/.fastcheck-stubs"
cp -f "$TOOL_DIR/fastcheck-kit/.fastcheck-stubs/"*.d.ts "$ROOT/.fastcheck-stubs/"
printf "/tsconfig.fastcheck.json\n/.fastcheck-stubs/\n" >> "$ROOT/.git/info/exclude"

echo "[setup] node $(node --version) | repo $(git log --oneline -1 | head -c 60)"
echo "FAST_SETUP_DONE"

# ── 5. optional env verification ────────────────────────────────────────────
if [ "${1:-}" = "quick-test" ]; then
  echo "[setup] running harness-b4 suite as env check"
  DISABLE_SQLITE_AUTO_BACKUP=true node --import tsx/esm \
    --import ./open-sse/utils/setupPolyfill.ts --import ./tests/_setup/isolateDataDir.ts \
    --test --test-concurrency=4 --test-force-exit tests/unit/services/harness-b4.test.ts \
    2>&1 | grep -E "^# (tests|pass|fail)"
fi
