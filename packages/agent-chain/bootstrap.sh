#!/usr/bin/env bash
# bootstrap.sh — install pi + the agent-chain extension in one shot
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/<user>/<repo>/main/packages/agent-chain/bootstrap.sh | bash
#   # or locally:
#   bash packages/agent-chain/bootstrap.sh

set -euo pipefail

PACKAGE_NAME="pi-agent-chain"   # change to your published npm name

# ── 1. Install pi ──────────────────────────────────────────────────────────
if command -v pi &>/dev/null; then
  echo "✓ pi already installed ($(pi --version 2>/dev/null || echo 'version unknown'))"
else
  echo "→ Installing pi..."
  npm install -g @earendil-works/pi-coding-agent
  echo "✓ pi installed"
fi

# ── 2. Install the agent-chain package ────────────────────────────────────
echo "→ Installing ${PACKAGE_NAME}..."
pi install "npm:${PACKAGE_NAME}"
echo "✓ ${PACKAGE_NAME} installed"

echo ""
echo "All done. Run: pi"
echo "  /chain       — select a chain"
echo "  /chain-list  — list available chains"
