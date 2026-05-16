#!/usr/bin/env bash
# bootstrap.sh — install pi + the cross-agent extension in one shot
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/breskeby/pi-vs-claude-code/main/packages/cross-agent/bootstrap.sh | bash

set -euo pipefail

REPO="https://github.com/breskeby/pi-vs-claude-code.git"
SUBDIR="packages/cross-agent"
CLONE_DIR="${HOME}/.pi/cross-agent-pkg"

# ── 1. Install pi ─────────────────────────────────────────────────────────
if command -v pi &>/dev/null; then
  echo "✓ pi already installed"
else
  echo "→ Installing pi..."
  npm install -g @earendil-works/pi-coding-agent
  echo "✓ pi installed"
fi

# ── 2. Sparse-clone (or update) only packages/cross-agent ───────────────
echo "→ Fetching cross-agent package..."
if [[ -d "$CLONE_DIR/.git" ]]; then
  echo "  (updating existing clone)"
  git -C "$CLONE_DIR" pull -q
else
  git clone --depth 1 --filter=blob:none --sparse "$REPO" "$CLONE_DIR"
  git -C "$CLONE_DIR" sparse-checkout set "$SUBDIR"
fi
echo "✓ Fetched"

# ── 3. Register the extension in global pi settings ──────────────────────
echo "→ Registering extension..."
pi install "$CLONE_DIR/$SUBDIR"
echo "✓ Extension registered"

echo ""
echo "All done. Run: pi"
