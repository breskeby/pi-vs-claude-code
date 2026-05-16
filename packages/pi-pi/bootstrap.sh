#!/usr/bin/env bash
# bootstrap.sh — install pi + the pi-pi meta-agent extension in one shot
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/breskeby/pi-vs-claude-code/main/packages/pi-pi/bootstrap.sh | bash

set -euo pipefail

REPO="https://github.com/breskeby/pi-vs-claude-code.git"
SUBDIR="packages/pi-pi"
CLONE_DIR="${HOME}/.pi/pi-pi-pkg"

# ── 1. Install pi ─────────────────────────────────────────────────────────
if command -v pi &>/dev/null; then
  echo "✓ pi already installed"
else
  echo "→ Installing pi..."
  npm install -g @earendil-works/pi-coding-agent
  echo "✓ pi installed"
fi

# ── 2. Sparse-clone (or update) only packages/pi-pi ──────────────────────
echo "→ Fetching pi-pi package..."
if [[ -d "$CLONE_DIR/.git" ]]; then
  echo "  (updating existing clone)"
  git -C "$CLONE_DIR" pull -q
else
  git clone --depth 1 --filter=blob:none --sparse "$REPO" "$CLONE_DIR"
  git -C "$CLONE_DIR" sparse-checkout set "$SUBDIR"
fi
echo "✓ Fetched"

# ── 3. Copy pi-pi expert agents to ~/.pi/agent/agents/pi-pi/ ─────────────
echo "→ Installing pi-pi expert agents..."
AGENT_DIR="${HOME}/.pi/agent/agents/pi-pi"
mkdir -p "$AGENT_DIR"
cp "$CLONE_DIR/$SUBDIR/.pi/agents/pi-pi/"* "$AGENT_DIR/"
echo "✓ Expert agents installed to ${AGENT_DIR}"

# ── 4. Register the extension in global pi settings ──────────────────────
echo "→ Registering extension..."
pi install "$CLONE_DIR/$SUBDIR"
echo "✓ Extension registered"

echo ""
echo "All done. Run: pi"
echo "  /experts        — list available research experts"
echo "  /experts-grid N — set dashboard column count"
