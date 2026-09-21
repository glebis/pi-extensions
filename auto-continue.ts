/**
 * Auto-Continue
 *
 * Detects when an LLM response stops prematurely — i.e. it was truncated by the
 * output token limit before the model finished its turn — and automatically
 * continues it.
 *
 * How it works
 * ------------
 * pi-ai reports a `stopReason` on every assistant message. A response cut off by
 * the output limit carries `stopReason: "length"` (raw provider values like
 * `max_tokens` / `MAX_TOKENS` are normalized by pi-ai for known APIs; a defensive
 * raw-value fallback covers custom providers).
 *
 * Notes on pi's built-in behavior:
 * - A truncated message that *contains tool calls* is already handled by the core
 *   agent loop: it fails those tool calls and continues, letting the model re-issue
 *   them (agent-loop.js `failToolCallsFromTruncatedMessage`).
 * - A truncated message with *no tool calls* (prose/code cut mid-stream) simply ends
 *   the run — nothing resumes it. That is the gap this extension closes.
 *
 * On `agent_end`, if the run's final assistant message is truncated, the extension
 * queues an auto-continue prompt as a follow-up custom message. AgentSession
 * picks queued messages up after `agent_end` (`_handlePostAgentRun` →
 * `agent.continue()`), so the model resumes exactly where it stopped, in the same
 * session, without the user typing anything.
 *
 * Safety rails
 * ------------
 * - Skips when the user (or another extension) already queued messages.
 * - Skips when the context window is nearly full (≥ 90%); auto-compaction owns
 *   recovery in that regime.
 * - Caps consecutive auto-continuations (default 5) to avoid burning tokens on
 *   a model that can never fit its answer.
 * - Never triggers for `aborted`/`error` stops; those have their own recovery.
 *
 * Configuration
 * -------------
 * /autocontinue            show status
 * /autocontinue on|off     enable/disable (persisted)
 * /autocontinue max N      set the consecutive-continuation cap (persisted)
 *
 * State is stored in `~/.pi/agent/auto-continue.json`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CUSTOM_TYPE = "auto-continue";
const DEFAULT_MAX_CONTINUATIONS = 5;
/** Above this context usage, leave recovery to auto-compaction. */
const CONTEXT_SAFETY_PERCENT = 90;

const CONTINUATION_PROMPT = [
	"[auto-continue] Your previous response hit the output token limit and was cut off before you finished. Resume from exactly where it stopped:",
	"1. Do not repeat, restate, or re-summarize anything you already produced — continue seamlessly from the exact point of interruption.",
	"2. If you were cut off mid-sentence, mid-code-block, or mid-tool-call, finish that piece first; re-issue any incomplete tool call with complete arguments.",
	"3. Then complete the original request.",
	"If a lot of output remains, work in smaller chunks across multiple steps (e.g. write files incrementally with tools) instead of emitting everything in one response.",
].join("\n");

// Stop reasons that mean the model finished its turn normally.
const CLEAN_STOP_REASONS = new Set<StopReason>(["stop", "toolUse", "deferred"]);

interface AutoContinueConfig {
	enabled: boolean;
	maxContinuations: number;
}

interface ContinuationDetails {
	chain: number;
	maxContinuations: number;
	model?: string;
	outputTokens?: number;
	timestamp: number;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function configPath(): string {
	return join(getAgentDir(), "auto-continue.json");
}

function loadConfig(): AutoContinueConfig {
	try {
		const file = configPath();
		if (existsSync(file)) {
			const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<AutoContinueConfig>;
			return {
				enabled: raw.enabled !== false,
				maxContinuations: clampInt(Number(raw.maxContinuations), 1, 20, DEFAULT_MAX_CONTINUATIONS),
			};
		}
	} catch {
		// Corrupt/unreadable config → fall back to defaults.
	}
	return { enabled: true, maxContinuations: DEFAULT_MAX_CONTINUATIONS };
}

function saveConfig(config: AutoContinueConfig): void {
	try {
		writeFileSync(configPath(), JSON.stringify(config, null, 2) + "\n");
	} catch {
		// Best-effort persistence; runtime behavior is unaffected.
	}
}

/** Scan backwards through a run's new messages for the most recent assistant message. */
function lastAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string } | undefined;
		if (message?.role === "assistant") return message as AssistantMessage;
	}
	return undefined;
}

/**
 * Whether this assistant message was cut off before the model finished.
 * Primary signal: pi-ai's normalized `stopReason === "length"`.
 * Fallback: unrecognized adapters that pass the provider's raw reason through.
 */
function isTruncated(message: AssistantMessage): boolean {
	if (message.stopReason === "length") return true;
	const raw = (message as { rawStopReason?: string }).rawStopReason;
	if (typeof raw === "string" && !CLEAN_STOP_REASONS.has(message.stopReason)) {
		return /max[_-]?(output[_-]?)?token|truncat|length/i.test(raw);
	}
	return false;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** True when the truncated response ends in a way that strongly suggests an unfinished structure. */
function looksMidStructure(message: AssistantMessage): boolean {
	const text = assistantText(message);
	if (!text) return false;
	// Unclosed code fence: an odd number of ``` markers means a block was left open.
	const fenceCount = (text.match(/```/g) ?? []).length;
	if (fenceCount % 2 === 1) return true;
	// Cut off inside an unclosed C-style block or JSX-ish tag — crude, informational only.
	return false;
}

export default async function autoContinueExtension(pi: ExtensionAPI) {
	const config = loadConfig();
	/** Consecutive auto-continuations in the current chain. Reset when a run ends cleanly. */
	let chainCount = 0;

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) void ctx.ui.notify(`auto-continue: ${message}`, level);
	};

	pi.on("session_start", async () => {
		chainCount = 0;
	});

	pi.on("agent_end", async (event, ctx) => {
		const last = lastAssistantMessage(event.messages);
		if (!last) return;

		// User aborted or a provider error occurred: pi's own retry/abort paths own
		// recovery, and intervention would fight them. Reset the chain.
		if (last.stopReason === "aborted" || last.stopReason === "error") {
			chainCount = 0;
			return;
		}

		if (!isTruncated(last)) {
			// Clean end of turn → a fresh chain for the next truncation.
			chainCount = 0;
			return;
		}

		if (!config.enabled) return;

		// If the user (or another extension) queued something during the run, pi will
		// continue anyway — don't stack a second continuation on top.
		if (ctx.hasPendingMessages()) return;

		// Nearly-full context: continuing will just overflow into auto-compaction.
		// Let compaction + retry handle it instead of appending more text.
		const usage = ctx.getContextUsage();
		if (usage?.percent != null && usage.percent >= CONTEXT_SAFETY_PERCENT) {
			notify(
				ctx,
				`response truncated at the output limit, but context is ${Math.round(usage.percent)}% full — run /compact, then ask to continue`,
				"warning",
			);
			return;
		}

		chainCount += 1;
		if (chainCount > config.maxContinuations) {
			notify(
				ctx,
				`giving up after ${config.maxContinuations} consecutive continuations — the response may be too long for the output limit; split the task or raise the limit`,
				"warning",
			);
			chainCount = 0;
			return;
		}

		await pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: CONTINUATION_PROMPT,
				display: true,
				details: {
					chain: chainCount,
					maxContinuations: config.maxContinuations,
					model: last.model,
					outputTokens: last.usage?.output,
					timestamp: Date.now(),
				} satisfies ContinuationDetails,
			},
			// Queued while the run settles; AgentSession drains it and starts a continuation run.
			// If we somehow fire while idle, triggerTurn starts the run directly.
			{ deliverAs: "followUp", triggerTurn: true },
		);

		notify(
			ctx,
			`response truncated at the output limit${looksMidStructure(last) ? " (mid-structure)" : ""} — continuing (${chainCount}/${config.maxContinuations})`,
		);
	});

	// Compact TUI card instead of a fake user bubble. The message still reaches
	// the LLM verbatim as a user-role message.
	pi.registerMessageRenderer<ContinuationDetails>(CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const details = message.details;
		const chain = details?.chain ?? 1;
		const max = details?.maxContinuations ?? 0;
		let text = `${theme.fg("warning", "⟳ auto-continue")} ${theme.fg("dim", `output limit hit — resuming (${chain}${max ? `/${max}` : ""})`)}`;
		if (details?.outputTokens != null) {
			text += ` ${theme.fg("dim", `· ${details.outputTokens.toLocaleString()} output tokens used`)}`;
		}
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.registerCommand("autocontinue", {
		description:
			"Auto-continue truncated LLM responses: /autocontinue [on|off|max N|status]",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (!arg || arg === "status") {
				notify(
					ctx,
					`${config.enabled ? "enabled" : "disabled"} · cap ${config.maxContinuations} consecutive · config: ${configPath()}`,
				);
				return;
			}

			if (arg === "on" || arg === "off") {
				config.enabled = arg === "on";
				chainCount = 0;
				saveConfig(config);
				notify(ctx, `${config.enabled ? "enabled" : "disabled"} (persisted to ${configPath()})`);
				return;
			}

			const maxMatch = arg.match(/^max\s+(\d+)$/);
			if (maxMatch) {
				config.maxContinuations = clampInt(Number(maxMatch[1]), 1, 20, DEFAULT_MAX_CONTINUATIONS);
				saveConfig(config);
				notify(ctx, `cap set to ${config.maxContinuations} consecutive continuations`);
				return;
			}

			notify(ctx, "usage: /autocontinue [on|off|max N|status]", "warning");
		},
	});
}