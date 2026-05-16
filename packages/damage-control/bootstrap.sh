#!/usr/bin/env bash
# bootstrap.sh — install pi + the damage-control extension in one shot
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/breskeby/pi-vs-claude-code/main/packages/damage-control/bootstrap.sh | bash

set -euo pipefail

REPO="https://github.com/breskeby/pi-vs-claude-code.git"
SUBDIR="packages/damage-control"
CLONE_DIR="${HOME}/.pi/damage-control-pkg"

# ── 1. Install pi ─────────────────────────────────────────────────────────
if command -v pi &>/dev/null; then
  echo "✓ pi already installed"
else
  echo "→ Installing pi..."
  npm install -g @earendil-works/pi-coding-agent
  echo "✓ pi installed"
fi

# ── 2. Sparse-clone (or update) only packages/damage-control ─────────────
echo "→ Fetching damage-control package..."
if [[ -d "$CLONE_DIR/.git" ]]; then
  echo "  (updating existing clone)"
  git -C "$CLONE_DIR" pull -q
else
  git clone --depth 1 --filter=blob:none --sparse "$REPO" "$CLONE_DIR"
  git -C "$CLONE_DIR" sparse-checkout set "$SUBDIR"
fi
echo "✓ Fetched"

# ── 3. Copy rules config to ~/.pi/ ───────────────────────────────────────
echo "→ Installing damage-control rules..."
PI_DIR="${HOME}/.pi"
mkdir -p "$PI_DIR"
# Only copy if no existing rules file — don't overwrite user customizations
if [[ ! -f "$PI_DIR/damage-control-rules.yaml" ]]; then
  cp "$CLONE_DIR/$SUBDIR/.pi/damage-control-rules.yaml" "$PI_DIR/"
  echo "✓ Rules installed to ${PI_DIR}/damage-control-rules.yaml"
else
  echo "  (rules file already exists at ${PI_DIR}/damage-control-rules.yaml — skipping)"
fi

# ── 4. Register the extension in global pi settings ──────────────────────
echo "→ Registering extension..."
pi install "$CLONE_DIR/$SUBDIR"
echo "✓ Extension registered"

echo ""
echo "All done. Run: pi"
echo "  Rules file: ~/.pi/damage-control-rules.yaml"
echo "  Edit it to customize blocked commands and path restrictions."
