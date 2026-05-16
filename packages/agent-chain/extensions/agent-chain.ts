/**
 * Agent Chain — Sequential pipeline orchestrator
 *
 * Runs opinionated, repeatable agent workflows. Chains are defined in
 * .pi/agents/agent-chain.yaml — each chain is a sequence of agent steps
 * with prompt templates. The user's original prompt flows into step 1,
 * the output becomes $INPUT for step 2's prompt template, and so on.
 * $ORIGINAL is always the user's original prompt.
 *
 * The primary Pi agent has NO codebase tools — it can ONLY kick off the
 * pipeline via the `run_chain` tool. On boot you select a chain; the
 * agent decides when to run it based on the user's prompt.
 *
 * Agents maintain session context within a Pi session — re-running the
 * chain lets each agent resume where it left off.
 *
 * Agent definition format (.pi/agents/<name>.md):
 *   ---
 *   name: my-agent
 *   description: What this agent does
 *   tools: read,bash,edit,write,grep,find,ls
 *   prompt-mode: append   # append (default) | replace
 *   model: openrouter/google/gemini-3-flash-preview  # optional override
 *   ---
 *   <system prompt body>
 *
 *   prompt-mode: append  — appends body to pi's default coding assistant prompt
 *   prompt-mode: replace — uses body as the sole system prompt (full control)
 *
 * Chain YAML step format (.pi/agents/agent-chain.yaml):
 *   chain-name:
 *     description: "What this chain does"
 *     steps:
 *       - agent: my-agent
 *         model: openrouter/google/gemini-3-flash-preview  # optional override
 *         prompt: "Do $INPUT"
 *
 * Model resolution order (per step): step model → agent model → ctx.model → default
 *
 * Commands:
 *   /chain             — switch active chain
 *   /chain-list        — list all available chains
 *   /chain-inspect     — drill into step details and token usage
 *
 * Usage: pi -e extensions/agent-chain.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth, matchesKey, Key } from "@mariozechner/pi-tui";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

// Global pi agent dir (honors PI_CODING_AGENT_DIR override).
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

// Package root — used as a bundled fallback for chains/agents so that
// `pi -e git:<this-repo>` works out of the box without any local config.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

import { applyExtensionDefaults } from "./themeMap.ts";

// ── Types ────────────────────────────────────────

interface ChainStep {
	agent: string;
	prompt: string;
	model?: string;
}

interface ChainDef {
	name: string;
	description: string;
	steps: ChainStep[];
}

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	promptMode: "append" | "replace";
	systemPrompt: string;
	model?: string;
}

interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface StepState {
	agent: string;
	status: "pending" | "running" | "done" | "error";
	elapsed: number;
	lastWork: string;
	tokens?: TokenUsage;
	output?: string;
	resolvedPrompt?: string;
	model?: string;
}

// ── Display Name Helper ──────────────────────────

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// ── Number format helper ─────────────────────────

function fmtNum(n: number): string {
	return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

// ── Chain YAML Parser ────────────────────────────

function parseChainYaml(raw: string): ChainDef[] {
	const chains: ChainDef[] = [];
	let current: ChainDef | null = null;
	let currentStep: ChainStep | null = null;

	for (const line of raw.split("\n")) {
		// Chain name: top-level key
		const chainMatch = line.match(/^(\S[^:]*):$/);
		if (chainMatch) {
			if (current && currentStep) {
				current.steps.push(currentStep);
				currentStep = null;
			}
			current = { name: chainMatch[1].trim(), description: "", steps: [] };
			chains.push(current);
			continue;
		}

		// Chain description
		const descMatch = line.match(/^\s+description:\s+(.+)$/);
		if (descMatch && current && !currentStep) {
			let desc = descMatch[1].trim();
			if ((desc.startsWith('"') && desc.endsWith('"')) ||
				(desc.startsWith("'") && desc.endsWith("'"))) {
				desc = desc.slice(1, -1);
			}
			current.description = desc;
			continue;
		}

		// "steps:" label — skip
		if (line.match(/^\s+steps:\s*$/) && current) {
			continue;
		}

		// Step agent line
		const agentMatch = line.match(/^\s+-\s+agent:\s+(.+)$/);
		if (agentMatch && current) {
			if (currentStep) {
				current.steps.push(currentStep);
			}
			currentStep = { agent: agentMatch[1].trim(), prompt: "" };
			continue;
		}

		// Step model line (optional, per-step override)
		const stepModelMatch = line.match(/^\s+model:\s+(.+)$/);
		if (stepModelMatch && currentStep) {
			currentStep.model = stepModelMatch[1].trim();
			continue;
		}

		// Step prompt line
		const promptMatch = line.match(/^\s+prompt:\s+(.+)$/);
		if (promptMatch && currentStep) {
			let prompt = promptMatch[1].trim();
			if ((prompt.startsWith('"') && prompt.endsWith('"')) ||
				(prompt.startsWith("'") && prompt.endsWith("'"))) {
				prompt = prompt.slice(1, -1);
			}
			prompt = prompt.replace(/\\n/g, "\n");
			currentStep.prompt = prompt;
			continue;
		}
	}

	if (current && currentStep) {
		current.steps.push(currentStep);
	}

	return chains;
}

// ── Frontmatter Parser ───────────────────────────

function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		const rawMode = (frontmatter["prompt-mode"] || "append").toLowerCase();
		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			promptMode: rawMode === "replace" ? "replace" : "append",
			systemPrompt: match[2].trim(),
			model: frontmatter.model || undefined,
		};
	} catch {
		return null;
	}
}

function scanAgentDirs(cwd: string): Map<string, AgentDef> {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
		join(PI_AGENT_DIR, "agents"),
		// Bundled fallback for `pi -e git:...` installs
		join(PACKAGE_ROOT, ".pi", "agents"),
	];

	const agents = new Map<string, AgentDef>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !agents.has(def.name.toLowerCase())) {
					agents.set(def.name.toLowerCase(), def);
				}
			}
		} catch {}
	}

	return agents;
}

// ── Audit Trail Writer ───────────────────────────

function writeAuditTrace(
	sessionDir: string,
	chainName: string,
	task: string,
	totalElapsed: number,
	success: boolean,
	steps: ChainStep[],
	states: StepState[],
	format: string = "md",
): void {
	try {
		const traceFile = join(sessionDir, `chain-run-${Date.now()}.md`);

		// Aggregate totals across all steps
		let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0, totalCost = 0;
		for (const s of states) {
			if (s.tokens) {
				totalInput     += s.tokens.input;
				totalOutput    += s.tokens.output;
				totalCacheRead += s.tokens.cacheRead;
				totalCacheWrite+= s.tokens.cacheWrite;
				totalCost      += s.tokens.cost;
			}
		}
		const anyTokens = states.some(s => !!s.tokens);

		const lines: string[] = [
			`# Chain Run: ${chainName}`,
			``,
			`| Field   | Value |`,
			`|---------|-------|`,
			`| **Task**    | ${task.replace(/\n/g, " ").slice(0, 120)}${task.length > 120 ? "…" : ""} |`,
			`| **Status**  | ${success ? "✅ success" : "❌ error"} |`,
			`| **Elapsed** | ${Math.round(totalElapsed / 1000)}s |`,
		];

		if (anyTokens) {
			lines.push(
				``,
				`## Token Usage Summary`,
				``,
				`| Agent | Model | Input | Output | Cache Read | Cache Write | Cost |`,
				`|-------|-------|------:|-------:|-----------:|------------:|-----:|`,
			);
			for (let i = 0; i < states.length; i++) {
				const s = states[i];
				const modelCol = s.model || "—";
				if (s.tokens) {
					lines.push(
						`| ${displayName(s.agent)} | \`${modelCol}\` | ${s.tokens.input.toLocaleString()} | ${s.tokens.output.toLocaleString()} | ${s.tokens.cacheRead.toLocaleString()} | ${s.tokens.cacheWrite.toLocaleString()} | $${s.tokens.cost.toFixed(5)} |`
					);
				} else {
					lines.push(
						`| ${displayName(s.agent)} | \`${modelCol}\` | — | — | — | — | — |`
					);
				}
			}
			lines.push(
				`| **Total** | | **${totalInput.toLocaleString()}** | **${totalOutput.toLocaleString()}** | **${totalCacheRead.toLocaleString()}** | **${totalCacheWrite.toLocaleString()}** | **$${totalCost.toFixed(5)}** |`,
			);
		}

		lines.push(``, `## Steps`);

		for (let i = 0; i < states.length; i++) {
			const s = states[i];
			const step = steps[i];
			lines.push(
				``,
				`### Step ${i + 1}: ${displayName(s.agent)}`,
				``,
				`| Field | Value |`,
				`|-------|-------|`,
				`| **Status**  | ${s.status} |`,
				`| **Model**   | \`${s.model || "—"}\` |`,
				`| **Elapsed** | ${Math.round(s.elapsed / 1000)}s |`,
			);
			if (s.tokens) {
				const t = s.tokens;
				lines.push(
					`| **Input tokens**       | ${t.input.toLocaleString()} |`,
					`| **Output tokens**      | ${t.output.toLocaleString()} |`,
					`| **Cache read tokens**  | ${t.cacheRead.toLocaleString()} |`,
					`| **Cache write tokens** | ${t.cacheWrite.toLocaleString()} |`,
					`| **Total tokens**       | ${t.totalTokens.toLocaleString()} |`,
					`| **Cost**               | $${t.cost.toFixed(5)} |`,
				);
			}
			lines.push(
				``,
				`**Input prompt:**`,
				``,
				`\`\`\``,
				`${s.resolvedPrompt || step.prompt}`,
				`\`\`\``,
				``,
				`**Output:**`,
				``,
				`\`\`\``,
				`${s.output || "(none)"}`,
				`\`\`\``,
			);
		}

		const ts = Date.now();
		const base = join(sessionDir, `chain-run-${ts}`);

		if (format === "md" || format === "both") {
			writeFileSync(`${base}.md`, lines.join("\n"));
		}

		if (format === "json" || format === "both") {
			const json = {
				chain: chainName,
				task,
				status: success ? "success" : "error",
				elapsedMs: totalElapsed,
				timestamp: new Date(ts).toISOString(),
				tokens: anyTokens ? {
					input: totalInput,
					output: totalOutput,
					cacheRead: totalCacheRead,
					cacheWrite: totalCacheWrite,
					cost: totalCost,
				} : null,
				steps: states.map((s, i) => ({
					index: i + 1,
					agent: s.agent,
					model: s.model ?? null,
					status: s.status,
					elapsedMs: s.elapsed,
					tokens: s.tokens ? {
						input: s.tokens.input,
						output: s.tokens.output,
						cacheRead: s.tokens.cacheRead,
						cacheWrite: s.tokens.cacheWrite,
						totalTokens: s.tokens.totalTokens,
						cost: s.tokens.cost,
					} : null,
					prompt: s.resolvedPrompt ?? steps[i]?.prompt ?? null,
					output: s.output ?? null,
				})),
			};
			writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
		}
	} catch {
		// Audit failure must not surface to user
	}
}

// ── Extension ────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerFlag("chain-trace-format", {
		description: "Format for chain run trace files written to .pi/agent-sessions/. Accepted values: md, json, both (default: md)",
		type: "string",
		default: "md",
	});

	pi.registerFlag("chain", {
		description: "Enable agent-chain pipeline orchestrator",
		type: "boolean",
		default: true,
	});

	let allAgents: Map<string, AgentDef> = new Map();
	let chains: ChainDef[] = [];
	let activeChain: ChainDef | null = null;
	let widgetCtx: any;
	let sessionDir = "";
	const agentSessions: Map<string, string | null> = new Map();

	// Per-step state for the active chain
	let stepStates: StepState[] = [];
	let pendingReset = false;

	function loadChains(cwd: string) {
		sessionDir = join(cwd, ".pi", "agent-sessions");
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		allAgents = scanAgentDirs(cwd);

		agentSessions.clear();
		for (const [key] of allAgents) {
			const sessionFile = join(sessionDir, `chain-${key}.json`);
			agentSessions.set(key, existsSync(sessionFile) ? sessionFile : null);
		}

		const chainCandidates = [
			join(cwd, ".pi", "agents", "agent-chain.yaml"),
			join(PI_AGENT_DIR, "agents", "agent-chain.yaml"),
			// Bundled fallback for `pi -e git:...` installs
			join(PACKAGE_ROOT, ".pi", "agents", "agent-chain.yaml"),
		];
		const chainPath = chainCandidates.find((p) => existsSync(p));
		if (chainPath) {
			try {
				chains = parseChainYaml(readFileSync(chainPath, "utf-8"));
			} catch {
				chains = [];
			}
		} else {
			chains = [];
		}
	}

	function activateChain(chain: ChainDef) {
		activeChain = chain;
		stepStates = chain.steps.map(s => ({
			agent: s.agent,
			status: "pending" as const,
			elapsed: 0,
			lastWork: "",
		}));
		// Skip widget re-registration if reset is pending — let before_agent_start handle it
		if (!pendingReset) {
			updateWidget();
		}
	}

	// ── Card Rendering ──────────────────────────

	function renderCard(state: StepState, colWidth: number, theme: any): string[] {
		const w = colWidth - 2;
		const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max - 3) + "..." : s;

		const statusColor = state.status === "pending" ? "dim"
			: state.status === "running" ? "accent"
			: state.status === "done" ? "success" : "error";
		const statusIcon = state.status === "pending" ? "○"
			: state.status === "running" ? "●"
			: state.status === "done" ? "✓" : "✗";

		const name = displayName(state.agent);
		const nameStr = theme.fg("accent", theme.bold(truncate(name, w)));
		const nameVisible = Math.min(name.length, w);

		const statusStr = `${statusIcon} ${state.status}`;
		const timeStr = state.status !== "pending" ? ` ${Math.round(state.elapsed / 1000)}s` : "";
		const statusLine = theme.fg(statusColor, statusStr + timeStr);
		const statusVisible = statusStr.length + timeStr.length;

		const workRaw = state.lastWork || "";
		const workText = workRaw ? truncate(workRaw, Math.min(50, w - 1)) : "";
		const workLine = workText ? theme.fg("muted", workText) : theme.fg("dim", "—");
		const workVisible = workText ? workText.length : 1;

		// Token line — shown if available, placeholder "—" otherwise (keeps card height constant)
		let tokenText = "—";
		let tokenVisible = 1;
		if (state.tokens) {
			tokenText = `↑${fmtNum(state.tokens.input)} ↓${fmtNum(state.tokens.output)} 💰$${state.tokens.cost.toFixed(3)}`;
			tokenVisible = tokenText.length;
			tokenText = theme.fg("muted", tokenText);
		} else {
			tokenText = theme.fg("dim", tokenText);
		}

		const top = "┌" + "─".repeat(w) + "┐";
		const bot = "└" + "─".repeat(w) + "┘";
		const border = (content: string, visLen: number) =>
			theme.fg("dim", "│") + content + " ".repeat(Math.max(0, w - visLen)) + theme.fg("dim", "│");

		return [
			theme.fg("dim", top),
			border(" " + nameStr, 1 + nameVisible),
			border(" " + statusLine, 1 + statusVisible),
			border(" " + workLine, 1 + workVisible),
			border(" " + tokenText, 1 + tokenVisible),
			theme.fg("dim", bot),
		];
	}

	function updateWidget() {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("agent-chain", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (!activeChain || stepStates.length === 0) {
						text.setText(theme.fg("dim", "No chain active. Use /chain to select one."));
						return text.render(width);
					}

					const arrowWidth = 5; // " ──▶ "
					const cols = stepStates.length;
					const totalArrowWidth = arrowWidth * (cols - 1);
					const colWidth = Math.max(12, Math.floor((width - totalArrowWidth) / cols));
					const cardHeight = 6; // 6-line card (top + name + status + work + tokens + bot)
					const arrowRow = Math.floor(cardHeight / 2); // middle row

					const cards = stepStates.map(s => renderCard(s, colWidth, theme));
					const outputLines: string[] = [];

					for (let line = 0; line < cardHeight; line++) {
						let row = cards[0][line];
						for (let c = 1; c < cols; c++) {
							if (line === arrowRow) {
								row += theme.fg("dim", " ──▶ ");
							} else {
								row += " ".repeat(arrowWidth);
							}
							row += cards[c][line];
						}
						outputLines.push(row);
					}

					text.setText(outputLines.join("\n"));
					return text.render(width);
				},
				invalidate() {
					text.invalidate();
				},
			};
		});
	}

	// ── Run Agent (subprocess) ──────────────────

	function runAgent(
		agentDef: AgentDef,
		task: string,
		stepIndex: number,
		ctx: any,
		stepDef: ChainStep,
	): Promise<{ output: string; exitCode: number; elapsed: number; tokens?: TokenUsage }> {
		// Model resolution: step model → agent model → ctx.model → default
		const ctxModel = ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "openrouter/google/gemini-3-flash-preview";
		const model = stepDef.model || agentDef.model || ctxModel;

		const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
		const agentSessionFile = join(sessionDir, `chain-${agentKey}.json`);
		const hasSession = agentSessions.get(agentKey);

		const args = [
			"--mode", "json",
			"-p",
			"--no-extensions",
			"--model", model,
			"--tools", agentDef.tools,
			"--thinking", "off",
			agentDef.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt",
		agentDef.systemPrompt,
			"--session", agentSessionFile,
		];

		if (hasSession) {
			args.push("-c");
		}

		args.push(task);

		const textChunks: string[] = [];
		const startTime = Date.now();
		const state = stepStates[stepIndex];
		state.model = model;
		let lastTokens: TokenUsage | undefined;

		return new Promise((resolve) => {
			const proc = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			});

			const timer = setInterval(() => {
				state.elapsed = Date.now() - startTime;
				updateWidget();
			}, 1000);

			let buffer = "";

			function processEvent(event: any) {
				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (delta?.type === "text_delta") {
						textChunks.push(delta.delta || "");
						const full = textChunks.join("");
						const last = full.split("\n").filter((l: string) => l.trim()).pop() || "";
						state.lastWork = last;
						updateWidget();
					}
				} else if (event.type === "message" && event.message?.usage) {
					const u = event.message.usage;
					lastTokens = {
						input: u.input ?? 0,
						output: u.output ?? 0,
						cacheRead: u.cacheRead ?? 0,
						cacheWrite: u.cacheWrite ?? 0,
						cost: u.cost?.total ?? 0,
					};
					state.tokens = lastTokens;
					updateWidget();
				}
			}

			proc.stdout!.setEncoding("utf-8");
			proc.stdout!.on("data", (chunk: string) => {
				buffer += chunk;
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						processEvent(JSON.parse(line));
					} catch {}
				}
			});

			proc.stderr!.setEncoding("utf-8");
			proc.stderr!.on("data", () => {});

			proc.on("close", (code) => {
				if (buffer.trim()) {
					try {
						processEvent(JSON.parse(buffer));
					} catch {}
				}

				clearInterval(timer);
				const elapsed = Date.now() - startTime;
				state.elapsed = elapsed;
				const output = textChunks.join("");
				state.lastWork = output.split("\n").filter((l: string) => l.trim()).pop() || "";

				if (code === 0) {
					agentSessions.set(agentKey, agentSessionFile);
				}

				resolve({ output, exitCode: code ?? 1, elapsed, tokens: lastTokens });
			});

			proc.on("error", (err) => {
				clearInterval(timer);
				resolve({
					output: `Error spawning agent: ${err.message}`,
					exitCode: 1,
					elapsed: Date.now() - startTime,
					tokens: lastTokens,
				});
			});
		});
	}

	// ── Run Chain (sequential pipeline) ─────────

	async function runChain(
		task: string,
		ctx: any,
	): Promise<{ output: string; success: boolean; elapsed: number }> {
		const traceFormat = String(pi.getFlag("chain-trace-format") ?? "md");
		if (!activeChain) {
			return { output: "No chain active", success: false, elapsed: 0 };
		}

		const chainStart = Date.now();
		let success = false;

		// Reset all steps to pending
		stepStates = activeChain.steps.map(s => ({
			agent: s.agent,
			status: "pending" as const,
			elapsed: 0,
			lastWork: "",
		}));
		updateWidget();

		let input = task;
		const originalPrompt = task;
		let finalOutput = "";

		try {
			for (let i = 0; i < activeChain.steps.length; i++) {
				const step = activeChain.steps[i];
				stepStates[i].status = "running";
				updateWidget();

				const resolvedPrompt = step.prompt
					.replace(/\$INPUT/g, input)
					.replace(/\$ORIGINAL/g, originalPrompt);

				// Store resolved prompt for audit trail
				stepStates[i].resolvedPrompt = resolvedPrompt;

				const agentDef = allAgents.get(step.agent.toLowerCase());
				if (!agentDef) {
					stepStates[i].status = "error";
					stepStates[i].lastWork = `Agent "${step.agent}" not found`;
					updateWidget();

					const totalElapsed = Date.now() - chainStart;
					writeAuditTrace(sessionDir, activeChain.name, task, totalElapsed, false, activeChain.steps, stepStates, traceFormat);

					return {
						output: `Error at step ${i + 1}: Agent "${step.agent}" not found. Available: ${Array.from(allAgents.keys()).join(", ")}`,
						success: false,
						elapsed: totalElapsed,
					};
				}

				const result = await runAgent(agentDef, resolvedPrompt, i, ctx, step);

				// Persist output in step state for audit and drill-down
				stepStates[i].output = result.output;
				if (result.tokens) {
					stepStates[i].tokens = result.tokens;
				}
				// model is already set on state inside runAgent, but ensure it's reflected
				if (!stepStates[i].model) {
					const ctxModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "openrouter/google/gemini-3-flash-preview";
					stepStates[i].model = step.model || allAgents.get(step.agent.toLowerCase())?.model || ctxModel;
				}

				if (result.exitCode !== 0) {
					stepStates[i].status = "error";
					updateWidget();

					const totalElapsed = Date.now() - chainStart;
					writeAuditTrace(sessionDir, activeChain.name, task, totalElapsed, false, activeChain.steps, stepStates, traceFormat);

					return {
						output: `Error at step ${i + 1} (${step.agent}): ${result.output}`,
						success: false,
						elapsed: totalElapsed,
					};
				}

				stepStates[i].status = "done";
				updateWidget();

				input = result.output;
				finalOutput = input;
			}

			success = true;
			return { output: finalOutput, success: true, elapsed: Date.now() - chainStart };
		} finally {
			const totalElapsed = Date.now() - chainStart;
			if (activeChain) {
				writeAuditTrace(sessionDir, activeChain.name, task, totalElapsed, success, activeChain.steps, stepStates, traceFormat);
			}
		}
	}

	// ── Drill-down overlay ──────────────────────

	async function showChainInspect(ctx: any): Promise<void> {
		if (!activeChain || stepStates.length === 0) {
			ctx.ui.notify("No chain run yet — run the chain first", "info");
			return;
		}

		// Step selector overlay
		const selectedIndex = await ctx.ui.custom<number | null>(
			(_tui: any, theme: any, _keybindings: any, done: (v: number | null) => void) => {
				let cursor = 0;
				let cachedLines: string[] | undefined;
				let cachedWidth: number | undefined;

				return {
					render(width: number): string[] {
						if (cachedLines && cachedWidth === width) return cachedLines;
						cachedWidth = width;

						const lines: string[] = [
							truncateToWidth(theme.fg("accent", theme.bold(" Chain Steps — select to inspect")), width),
							truncateToWidth(theme.fg("dim", " ↑/↓ navigate · Enter select · Esc close"), width),
							truncateToWidth(theme.fg("dim", "─".repeat(width)), width),
						];

						for (let i = 0; i < stepStates.length; i++) {
							const s = stepStates[i];
							const isSelected = i === cursor;
							const prefix = isSelected ? "▶ " : "  ";
							const statusIcon = s.status === "pending" ? "○"
								: s.status === "running" ? "●"
								: s.status === "done" ? "✓" : "✗";
							const statusColor = s.status === "pending" ? "dim"
								: s.status === "running" ? "accent"
								: s.status === "done" ? "success" : "error";
							const tokenInfo = s.tokens
								? theme.fg("dim", ` ↑${fmtNum(s.tokens.input)} ↓${fmtNum(s.tokens.output)} $${s.tokens.cost.toFixed(3)}`)
								: "";
							const label = (isSelected ? theme.fg("accent", theme.bold(prefix)) : theme.fg("dim", prefix)) +
								theme.fg(statusColor, `${statusIcon} ${i + 1}. ${displayName(s.agent)}`) +
								tokenInfo;
							lines.push(truncateToWidth(label, width));
						}

						cachedLines = lines;
						return lines;
					},
					handleInput(data: string) {
						cachedLines = undefined;
						if (matchesKey(data, Key.up)) {
							cursor = Math.max(0, cursor - 1);
						} else if (matchesKey(data, Key.down)) {
							cursor = Math.min(stepStates.length - 1, cursor + 1);
						} else if (matchesKey(data, Key.enter)) {
							done(cursor);
						} else if (matchesKey(data, Key.escape)) {
							done(null);
						}
					},
					invalidate() {
						cachedLines = undefined;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { width: "60%", minWidth: 50, anchor: "center" as const },
			},
		);

		if (selectedIndex === null) return;

		const state = stepStates[selectedIndex];

		// Detail overlay for the selected step
		await ctx.ui.custom<void>(
			(_tui: any, theme: any, _keybindings: any, done: (v: void) => void) => {
				const lines: string[] = [];

				// Build detail lines
				lines.push(theme.bold(` Step ${selectedIndex + 1}: ${displayName(state.agent)}`));
				lines.push(theme.fg("dim", "─".repeat(60)));

				const statusIcon = state.status === "pending" ? "○"
					: state.status === "running" ? "●"
					: state.status === "done" ? "✓" : "✗";
				const statusColor = state.status === "pending" ? "dim"
					: state.status === "running" ? "accent"
					: state.status === "done" ? "success" : "error";
				lines.push(` Status: ${theme.fg(statusColor, `${statusIcon} ${state.status}`)}  Elapsed: ${Math.round(state.elapsed / 1000)}s`);

				if (state.tokens) {
					const t = state.tokens;
					lines.push(
						` Tokens: ${theme.fg("accent", `↑${fmtNum(t.input)} in`)} ` +
						`${theme.fg("muted", `↓${fmtNum(t.output)} out`)} ` +
						`cache-r:${fmtNum(t.cacheRead)} cache-w:${fmtNum(t.cacheWrite)} ` +
						`${theme.fg("success", `💰$${t.cost.toFixed(4)}`)}`
					);
				} else {
					lines.push(theme.fg("dim", " Tokens: —"));
				}

				lines.push(theme.fg("dim", "─".repeat(60)));
				lines.push(theme.fg("muted", " Prompt:"));
				const promptText = state.resolvedPrompt || "(not yet run)";
				for (const l of promptText.split("\n").slice(0, 10)) {
					lines.push(`   ${l}`);
				}

				lines.push(theme.fg("dim", "─".repeat(60)));
				lines.push(theme.fg("muted", " Output:"));
				const outputText = state.output || "(none)";
				const outputLines = outputText.split("\n");
				let scrollOffset = 0;
				const maxVisible = 20;

				// Pre-build all output lines, scroll handled in render
				const allOutputLines = outputLines.map(l => `   ${l}`);

				let cachedLines: string[] | undefined;
				let cachedWidth: number | undefined;

				return {
					render(width: number): string[] {
						if (cachedLines && cachedWidth === width) return cachedLines;
						cachedWidth = width;

						const result: string[] = [
							truncateToWidth(theme.fg("dim", " ↑/↓ scroll output · Esc close"), width),
						];

						for (const l of lines) {
							result.push(truncateToWidth(l, width));
						}

						// Scrollable output section
						const visibleOutput = allOutputLines.slice(scrollOffset, scrollOffset + maxVisible);
						for (const l of visibleOutput) {
							result.push(truncateToWidth(theme.fg("muted", l), width));
						}

						if (allOutputLines.length > maxVisible) {
							result.push(truncateToWidth(
								theme.fg("dim", ` [${scrollOffset + 1}–${Math.min(scrollOffset + maxVisible, allOutputLines.length)}/${allOutputLines.length} lines]`),
								width
							));
						}

						cachedLines = result;
						return result;
					},
					handleInput(data: string) {
						cachedLines = undefined;
						if (matchesKey(data, Key.up)) {
							scrollOffset = Math.max(0, scrollOffset - 1);
						} else if (matchesKey(data, Key.down)) {
							scrollOffset = Math.min(Math.max(0, allOutputLines.length - maxVisible), scrollOffset + 1);
						} else if (matchesKey(data, Key.escape)) {
							done(undefined);
						}
					},
					invalidate() {
						cachedLines = undefined;
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { width: "70%", minWidth: 60, maxHeight: "80%", anchor: "center" as const },
			},
		);
	}

	// ── run_chain Tool ──────────────────────────

	pi.registerTool({
		name: "run_chain",
		label: "Run Chain",
		description: "Execute the active agent chain pipeline. Each step runs sequentially — output from one step feeds into the next. Agents maintain session context across runs.",
		parameters: Type.Object({
			task: Type.String({ description: "The task/prompt for the chain to process" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			if (!pi.getFlag("chain")) {
				return {
					content: [{ type: "text", text: "Agent chain is disabled (--chain=false)" }],
					details: {},
				};
			}

			const { task } = params as { task: string };

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Starting chain: ${activeChain?.name}...` }],
					details: { chain: activeChain?.name, task, status: "running" },
				});
			}

			const result = await runChain(task, ctx);

			const truncated = result.output.length > 8000
				? result.output.slice(0, 8000) + "\n\n... [truncated]"
				: result.output;

			const status = result.success ? "done" : "error";
			const summary = `[chain:${activeChain?.name}] ${status} in ${Math.round(result.elapsed / 1000)}s`;

			return {
				content: [{ type: "text", text: `${summary}\n\n${truncated}` }],
				details: {
					chain: activeChain?.name,
					task,
					status,
					elapsed: result.elapsed,
					fullOutput: result.output,
				},
			};
		},

		renderCall(args, theme) {
			const task = (args as any).task || "";
			const preview = task.length > 60 ? task.slice(0, 57) + "..." : task;
			return new Text(
				theme.fg("toolTitle", theme.bold("run_chain ")) +
				theme.fg("accent", activeChain?.name || "?") +
				theme.fg("dim", " — ") +
				theme.fg("muted", preview),
				0, 0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "running") {
				return new Text(
					theme.fg("accent", `● ${details.chain || "chain"}`) +
					theme.fg("dim", " running..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const header = theme.fg(color, `${icon} ${details.chain}`) +
				theme.fg("dim", ` ${elapsed}s`);

			if (options.expanded && details.fullOutput) {
				const output = details.fullOutput.length > 4000
					? details.fullOutput.slice(0, 4000) + "\n... [truncated]"
					: details.fullOutput;
				return new Text(header + "\n" + theme.fg("muted", output), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});

	// ── Commands ─────────────────────────────────

	pi.registerCommand("chain", {
		description: "Switch active chain",
		handler: async (_args, ctx) => {
			if (!pi.getFlag("chain")) {
				ctx.ui.notify("Agent chain is disabled", "warning");
				return;
			}
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined in .pi/agents/agent-chain.yaml", "warning");
				return;
			}

			const options = chains.map(c => {
				const steps = c.steps.map(s => displayName(s.agent)).join(" → ");
				const desc = c.description ? ` — ${c.description}` : "";
				return `${c.name}${desc} (${steps})`;
			});

			const choice = await ctx.ui.select("Select Chain", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			activateChain(chains[idx]);
			const flow = chains[idx].steps.map(s => displayName(s.agent)).join(" → ");
			ctx.ui.setStatus("agent-chain", `Chain: ${chains[idx].name} (${chains[idx].steps.length} steps)`);
			ctx.ui.notify(
				`Chain: ${chains[idx].name}\n${chains[idx].description}\n${flow}`,
				"info",
			);
		},
	});

	pi.registerCommand("chain-list", {
		description: "List all available chains",
		handler: async (_args, ctx) => {
			if (!pi.getFlag("chain")) {
				ctx.ui.notify("Agent chain is disabled", "warning");
				return;
			}
			widgetCtx = ctx;
			if (chains.length === 0) {
				ctx.ui.notify("No chains defined in .pi/agents/agent-chain.yaml", "warning");
				return;
			}

			const list = chains.map(c => {
				const desc = c.description ? `  ${c.description}` : "";
				const steps = c.steps.map((s, i) =>
					`  ${i + 1}. ${displayName(s.agent)}`
				).join("\n");
				return `${c.name}:${desc ? "\n" + desc : ""}\n${steps}`;
			}).join("\n\n");

			ctx.ui.notify(list, "info");
		},
	});

	pi.registerCommand("chain-inspect", {
		description: "Drill into a chain step to see full output and token details",
		handler: async (_args, ctx) => {
			if (!pi.getFlag("chain")) {
				ctx.ui.notify("Agent chain is disabled", "warning");
				return;
			}
			widgetCtx = ctx;
			await showChainInspect(ctx);
		},
	});

	// ── System Prompt Override ───────────────────

	pi.on("before_agent_start", async (_event, _ctx) => {
		// Force widget reset on first turn after /new
		if (pendingReset && activeChain) {
			pendingReset = false;
			widgetCtx = _ctx;
			stepStates = activeChain.steps.map(s => ({
				agent: s.agent,
				status: "pending" as const,
				elapsed: 0,
				lastWork: "",
			}));
			updateWidget();
		}

		if (!activeChain) return {};

		const flow = activeChain.steps.map(s => displayName(s.agent)).join(" → ");
		const desc = activeChain.description ? `\n${activeChain.description}` : "";

		// Build pipeline steps summary
		const steps = activeChain.steps.map((s, i) => {
			const agentDef = allAgents.get(s.agent.toLowerCase());
			const agentDesc = agentDef?.description || "";
			return `${i + 1}. **${displayName(s.agent)}** — ${agentDesc}`;
		}).join("\n");

		// Build full agent catalog (like agent-team.ts)
		const seen = new Set<string>();
		const agentCatalog = activeChain.steps
			.filter(s => {
				const key = s.agent.toLowerCase();
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			})
			.map(s => {
				const agentDef = allAgents.get(s.agent.toLowerCase());
				if (!agentDef) return `### ${displayName(s.agent)}\nAgent not found.`;
				return `### ${displayName(agentDef.name)}\n${agentDef.description}\n**Tools:** ${agentDef.tools}\n**Role:** ${agentDef.systemPrompt}`;
			})
			.join("\n\n");

		return {
			systemPrompt: `You are an agent with a sequential pipeline called "${activeChain.name}" at your disposal.${desc}
You have full access to your own tools AND the run_chain tool to delegate to your team.

## Active Chain: ${activeChain.name}
Flow: ${flow}

${steps}

## Agent Details

${agentCatalog}

## When to Use run_chain
- Significant work: new features, refactors, multi-file changes, anything non-trivial
- Tasks that benefit from the full pipeline: planning, building, reviewing
- When you want structured, multi-agent collaboration on a problem

## When to Work Directly
- Simple one-off commands: reading a file, checking status, listing contents
- Quick lookups, small edits, answering questions about the codebase
- Anything you can handle in a single step without needing the pipeline

## How run_chain Works
- Pass a clear task description to run_chain
- Each step's output feeds into the next step as $INPUT
- Agents maintain session context — they remember previous work within this session
- You can run the chain multiple times with different tasks if needed
- After the chain completes, review the result and summarize for the user

## Guidelines
- Use your judgment — if it's quick, just do it; if it's real work, run the chain
- Keep chain tasks focused and clearly described
- You can mix direct work and chain runs in the same conversation`,
		};
	});

	// ── Session Start ───────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		// Dormant unless --chain flag is set
		if (!pi.getFlag("chain")) return;

		applyExtensionDefaults(import.meta.url, _ctx);
		// Clear widget with both old and new ctx — one of them will be valid
		if (widgetCtx) {
			widgetCtx.ui.setWidget("agent-chain", undefined);
		}
		_ctx.ui.setWidget("agent-chain", undefined);
		widgetCtx = _ctx;

		// Reset execution state — widget re-registration deferred to before_agent_start
		stepStates = [];
		activeChain = null;
		pendingReset = true;

		// Wipe chain session files — reset agent context on /new and launch
		const sessDir = join(_ctx.cwd, ".pi", "agent-sessions");
		if (existsSync(sessDir)) {
			for (const f of readdirSync(sessDir)) {
				if (f.startsWith("chain-") && f.endsWith(".json")) {
					try { unlinkSync(join(sessDir, f)); } catch {}
				}
			}
		}

		// Reload chains + clear agentSessions map (all agents start fresh)
		loadChains(_ctx.cwd);

		if (chains.length === 0) {
			_ctx.ui.notify("No chains found in .pi/agents/agent-chain.yaml", "warning");
			return;
		}

		// Default to first chain — use /chain to switch
		activateChain(chains[0]);

		// run_chain is registered as a tool — available alongside all default tools

		const flow = activeChain!.steps.map(s => displayName(s.agent)).join(" → ");
		_ctx.ui.setStatus("agent-chain", `Chain: ${activeChain!.name} (${activeChain!.steps.length} steps)`);
		_ctx.ui.notify(
			`Chain: ${activeChain!.name}\n${activeChain!.description}\n${flow}\n\n` +
			`/chain             Switch chain\n` +
			`/chain-list        List all chains\n` +
			`/chain-inspect     Drill into step details`,
			"info",
		);

		// Footer: model | chain name | context bar
		_ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const model = _ctx.model?.id || "no-model";
				const usage = _ctx.getContextUsage();
				const pct = usage ? usage.percent : 0;
				const filled = Math.round(pct / 10);
				const bar = "#".repeat(filled) + "-".repeat(10 - filled);

				const chainLabel = activeChain
					? theme.fg("accent", activeChain.name)
					: theme.fg("dim", "no chain");

				const left = theme.fg("dim", ` ${model}`) +
					theme.fg("muted", " · ") +
					chainLabel;
				const right = theme.fg("dim", `[${bar}] ${Math.round(pct)}% `);
				const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));

				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	});
}
