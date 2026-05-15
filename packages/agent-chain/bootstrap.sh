#!/usr/bin/env bash
# bootstrap.sh — install pi + the agent-chain extension in one shot
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/breskeby/pi-vs-claude-code/main/packages/agent-chain/bootstrap.sh | bash

set -euo pipefail

REPO="https://github.com/breskeby/pi-vs-claude-code.git"
SUBDIR="packages/agent-chain"
CLONE_DIR="$(mktemp -d)/pi-agent-chain"

# ── 1. Install pi ─────────────────────────────────────────────────────────
if command -v pi &>/dev/null; then
  echo "✓ pi already installed"
else
  echo "→ Installing pi..."
  npm install -g @earendil-works/pi-coding-agent
  echo "✓ pi installed"
fi

# ── 2. Sparse-clone only packages/agent-chain ────────────────────────────
echo "→ Fetching agent-chain package..."
git clone --depth 1 --filter=blob:none --sparse "$REPO" "$CLONE_DIR" -q
cd "$CLONE_DIR"
git sparse-checkout set "$SUBDIR"
echo "✓ Fetched"

# ── 3. Install the package into global pi settings ───────────────────────
echo "→ Installing agent-chain..."
pi install "$CLONE_DIR/$SUBDIR"
echo "✓ agent-chain installed"

echo ""
echo "All done. Run: pi"
echo "  /chain       — select a chain"
echo "  /chain-list  — list available chains"
