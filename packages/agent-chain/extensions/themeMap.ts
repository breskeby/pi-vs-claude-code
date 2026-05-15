/**
 * themeMap.ts — minimal stub for the standalone agent-chain distribution.
 *
 * The full themeMap (in the parent repo) wires per-extension default themes
 * and terminal titles. This bootstrap package intentionally ships *only* the
 * agent-chain extension, agents, and chain config — no themes — so this stub
 * exposes the same surface as a no-op. Drop in the full themeMap.ts later if
 * you want themed defaults.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export function applyExtensionTheme(_fileUrl: string, _ctx: ExtensionContext): boolean {
	return false;
}

export function applyExtensionTitle(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	setTimeout(() => ctx.ui.setTitle("π - agent-chain"), 150);
}

export function applyExtensionDefaults(fileUrl: string, ctx: ExtensionContext): void {
	applyExtensionTheme(fileUrl, ctx);
	applyExtensionTitle(ctx);
}
