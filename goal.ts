/**
 * /goal — a bounded autonomy loop for pi
 *
 * Set an objective; the agent keeps working it turn after turn until a judge sees
 * it done, and stops itself when it should. Adapted from pibot's /goal (same
 * contract, same bounds, same strictness rules) to a place with no side-call LLM
 * API, so the default judge is the model's own machine-readable status line.
 *
 * Usage
 * -----
 *   /goal <objective>            set and start
 *   /goal draft <objective>      let the model propose the completion contract first
 *   /goal                        status (also shown in the footer while active)
 *   /goal outcome|verify|constraints <text>   write the contract by hand
 *   /goal sub <criterion>        extra criteria the judge must weigh
 *   /goal max <n>                turn budget (default 8, max 20)
 *   /goal judge auto|jev|sentinel   who decides (auto = Jev when a key exists)
 *   /goal pause|resume|done|clear
 *
 * The loop
 * --------
 * On agent_end, if the goal is active the extension reads the model's
 * `GOAL-STATUS: DONE|CONTINUE|WAIT — <reason>` line (or asks Jev), then queues the
 * next step as a follow-up message with `triggerTurn`, which is how pi continues a
 * session without the human typing. Bounds: the turn budget, three unreadable turns
 * auto-pause, a nearly-full context belongs to compaction, queued human input
 * steers (no continuation is stacked on it), and a goal only drives the session
 * that set it.
 *
 * State: `~/.pi/agent/goal.json`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyVerdict,
	buildJevState,
	clampTurns,
	hasContract,
	JEV_ENDPOINT,
	jevQuestions,
	jevStateFits,
	jevVerdict,
	newGoal,
	parseContract,
	parseStatus,
	renderContinuation,
	renderDraftPrompt,
	renderStatus,
	shouldContinue,
	type GoalContract,
	type GoalState,
	type GoalVerdict,
} from "./goal-core";

const CUSTOM_TYPE = "goal";
const MAX_DRAFT_ATTEMPTS = 2;
const JEV_TIMEOUT_MS = 4_000;

type JudgeMode = "auto" | "jev" | "sentinel";
type PersistedState = GoalState & { judgeMode?: JudgeMode; draftAttempts?: number };

function statePath(): string {
	return join(getAgentDir(), "goal.json");
}

function loadState(): PersistedState | undefined {
	try {
		const file = statePath();
		if (!existsSync(file)) return undefined;
		const raw = JSON.parse(readFileSync(file, "utf-8")) as PersistedState;
		if (!raw?.objective) return undefined;
		return raw;
	} catch {
		return undefined; // a corrupt state file must not break the session
	}
}

function saveState(state: PersistedState | undefined): void {
	try {
		if (!state) {
			writeFileSync(statePath(), JSON.stringify({}, null, 2) + "\n");
			return;
		}
		writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n");
	} catch {
		// best effort: the goal lives in memory for this session either way
	}
}

/** pi does not document a session accessor, so tagging is best-effort by design. */
function sessionTag(ctx: ExtensionContext): string | undefined {
	const c = ctx as unknown as Record<string, unknown>;
	const tag = c.sessionFile ?? c.sessionPath ?? c.sessionId;
	return typeof tag === "string" && tag ? tag : undefined;
}

type LooseMessage = { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> };

function lastAssistant(messages: readonly unknown[] | undefined): LooseMessage | undefined {
	if (!messages) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as LooseMessage | undefined;
		if (m?.role === "assistant") return m;
	}
	return undefined;
}

function assistantText(message: LooseMessage | undefined): string {
	return (message?.content ?? [])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

/** Ask Jev, or return null so the caller falls back to the sentinel. */
async function judgeWithJev(state: GoalState, reply: string): Promise<{ verdict: GoalVerdict; reason: string } | null> {
	const key = process.env.AI_GATEWAY_API_KEY?.trim();
	if (!key) return null;
	const payload = buildJevState(state, reply);
	if (!jevStateFits(payload)) return null;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
	try {
		const response = await fetch(JEV_ENDPOINT, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "typesafe-ai/jev",
				state: payload,
				questions: jevQuestions(state),
				providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
			}),
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const body = (await response.json()) as { answers?: Parameters<typeof jevVerdict>[0] };
		return jevVerdict(body.answers);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

export default function goalExtension(pi: ExtensionAPI) {
	let state = loadState();
	let mode: JudgeMode = state?.judgeMode ?? "auto";

	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
		if (ctx.hasUI) void ctx.ui.notify(`goal: ${message}`, level);
	};

	const setFooter = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const active = state && (state.status === "active" || state.status === "drafting");
		void ctx.ui.setStatus("goal", active ? `🎯 ${state!.turnsUsed}/${state!.maxTurns}` : undefined);
	};

	const persist = (ctx?: ExtensionContext) => {
		saveState(state ? { ...state, judgeMode: mode } : undefined);
		if (ctx) setFooter(ctx);
	};

	const clear = (ctx: ExtensionContext) => {
		state = undefined;
		persist(ctx);
	};

	const queue = async (content: string, details: Record<string, unknown>) => {
		await pi.sendMessage(
			{ customType: CUSTOM_TYPE, content, display: true, details },
			// the human's own queued input always wins: pi drains it first, and
			// shouldContinue() refuses to stack a continuation while it waits
			{ deliverAs: "followUp", triggerTurn: true },
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		setFooter(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		const current = state;
		if (!current) return;
		const last = lastAssistant((event as { messages?: unknown[] }).messages);
		if (last?.stopReason === "aborted" || last?.stopReason === "error") return;
		const reply = assistantText(last);

		// ── drafting: the model proposes a contract, this turn does not count ──
		if (current.status === "drafting") {
			const contract = parseContract(reply);
			const attempts = (current.draftAttempts ?? 0) + 1;
			if (contract) {
				state = { ...current, contract, status: "active", draftAttempts: attempts } as PersistedState;
				if (!hasContract(state)) {
					notify(ctx, "the draft had no outcome or verification — set them with /goal outcome|verify", "warning");
				} else {
					notify(ctx, `contract set: ${contract.outcome ?? contract.verification}`);
				}
				persist(ctx);
				await queue(renderContinuation(state), { kind: "first-step", turn: 1 });
				return;
			}
			if (attempts >= MAX_DRAFT_ATTEMPTS) {
				state = { ...current, status: "active", draftAttempts: attempts } as PersistedState;
				persist(ctx);
				notify(ctx, "no GOAL-CONTRACT line after two tries — starting without a contract", "warning");
				await queue(renderContinuation(state), { kind: "first-step", turn: 1 });
				return;
			}
			state = { ...current, draftAttempts: attempts } as PersistedState;
			persist(ctx);
			await queue(renderDraftPrompt(current.objective), { kind: "draft", attempt: attempts + 1 });
			return;
		}

		const decision = shouldContinue(current, {
			sessionFile: sessionTag(ctx),
			hasPendingMessages: ctx.hasPendingMessages(),
			contextPercent: ctx.getContextUsage()?.percent ?? null,
		});
		if (!decision.continue) {
			if (decision.reason === "budget_exhausted") {
				notify(ctx, `budget spent (${current.maxTurns} turns) — /goal max <n> to extend, or /goal done`, "warning");
			} else if (decision.reason === "context_full") {
				notify(ctx, "context is nearly full — run /compact, then /goal resume", "warning");
			} else if (decision.reason !== "not_active" && decision.reason !== "pending_input") {
				notify(ctx, `loop held (${decision.reason})`, "warning");
			}
			return;
		}

		// ── judge: Jev when permitted, the model's own status line otherwise ──
		let judged: { verdict: GoalVerdict; reason: string } | null = null;
		let source = "sentinel";
		if (mode !== "sentinel") {
			const jev = await judgeWithJev(current, reply);
			if (jev) {
				judged = jev;
				source = "jev";
			}
		}
		if (!judged) judged = parseStatus(reply);

		const next = applyVerdict(current, judged) as PersistedState;
		state = { ...next, judgeMode: mode };
		persist(ctx);

		if (!judged) {
			notify(ctx, `turn ${next.turnsUsed}/${next.maxTurns}: no GOAL-STATUS line in the reply`, "warning");
			return;
		}
		if (next.status === "done") {
			notify(ctx, `🎯 goal complete — ${next.objective}${next.lastReason ? ` (${next.lastReason})` : ""}`);
			return;
		}
		if (next.status === "paused") {
			notify(ctx, `⏸ goal paused — ${next.lastReason ?? "no readable verdict"}. /goal resume to continue`, "warning");
			return;
		}
		if (next.turnsUsed >= next.maxTurns) {
			notify(ctx, `budget spent (${next.maxTurns} turns) — ${next.objective}`, "warning");
			return;
		}
		if (judged.verdict === "wait") {
			notify(ctx, `⏳ goal waiting — ${judged.reason}. /goal resume when that clears`);
			return;
		}
		notify(ctx, `turn ${next.turnsUsed}/${next.maxTurns} · ${source}: ${judged.verdict}${judged.reason ? ` — ${judged.reason}` : ""}`);
		await queue(renderContinuation(next), { kind: "step", turn: next.turnsUsed + 1, judge: source, verdict: judged.verdict });
	});

	// a compact card instead of a fake user bubble; the text still reaches the model verbatim
	pi.registerMessageRenderer<{ kind?: string; turn?: number; verdict?: string }>(CUSTOM_TYPE, (message, { outputPad }, theme) => {
		const kind = message.details?.kind;
		const label =
			kind === "draft" ? "drafting a contract" : kind === "first-step" ? "starting" : `step ${message.details?.turn ?? "?"}${message.details?.verdict ? ` · ${message.details.verdict}` : ""}`;
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg("accent", "🎯 goal")} ${theme.fg("dim", label)}`, 0, 0));
		return box;
	});

	pi.registerCommand("goal", {
		description: "Bounded goal loop: /goal <objective> · draft · status · max · judge · pause|resume|done|clear",
		getArgumentCompletions: (prefix) => {
			const verbs = ["draft", "status", "outcome", "verify", "constraints", "sub", "max", "judge", "pause", "resume", "done", "clear"];
			const hits = verbs.filter((v) => v.startsWith(prefix.trim()));
			return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const raw = args.trim();
			const [verb = "", ...rest] = raw.split(/\s+/);
			const tail = rest.join(" ").trim();
			const lower = verb.toLowerCase();

			if (!raw || lower === "status") {
				notify(ctx, `${renderStatus(state)} · judge=${mode}`);
				return;
			}
			if (lower === "clear") {
				clear(ctx);
				notify(ctx, "cleared");
				return;
			}
			if (lower === "pause" || lower === "resume" || lower === "done") {
				if (!state) return notify(ctx, "no goal set", "warning");
				state = { ...state, status: lower === "pause" ? "paused" : lower === "resume" ? "active" : "done" };
				persist(ctx);
				notify(ctx, `${lower === "done" ? "🎯 marked done" : lower === "pause" ? "⏸ paused" : "▶ active"} — ${state.objective}`);
				return;
			}
			if (lower === "sub") {
				if (!state) return notify(ctx, "no goal set", "warning");
				if (!tail) return notify(ctx, "usage: /goal sub <criterion>", "warning");
				state = { ...state, subgoals: [...state.subgoals, tail] };
				persist(ctx);
				notify(ctx, `criterion ${state.subgoals.length} added: ${tail}`);
				return;
			}
			if (lower === "max") {
				if (!state) return notify(ctx, "no goal set", "warning");
				state = { ...state, maxTurns: clampTurns(tail) };
				persist(ctx);
				notify(ctx, `budget set to ${state.maxTurns} turns`);
				return;
			}
			if (lower === "judge") {
				const wanted = tail.toLowerCase();
				if (wanted !== "auto" && wanted !== "jev" && wanted !== "sentinel") {
					return notify(ctx, `judge=${mode} (usage: /goal judge auto|jev|sentinel)`, "warning");
				}
				mode = wanted;
				persist(ctx);
				const key = process.env.AI_GATEWAY_API_KEY?.trim();
				notify(ctx, `judge=${mode}${mode === "jev" && !key ? " — but AI_GATEWAY_API_KEY is unset, so the sentinel will be used" : ""}${mode === "auto" ? ` (${key ? "jev" : "sentinel"} available)` : ""}`);
				return;
			}
			if (lower === "outcome" || lower === "verify" || lower === "verification" || lower === "constraints" || lower === "boundaries") {
				if (!state) return notify(ctx, "no goal set", "warning");
				if (!tail) return notify(ctx, `usage: /goal ${lower} <text>`, "warning");
				const key = lower === "verification" ? "verification" : lower;
				const contract: GoalContract = { ...state.contract, [key]: tail };
				state = { ...state, contract };
				persist(ctx);
				notify(ctx, `${key}: ${tail}`);
				return;
			}

			// setting a goal: "/goal draft <objective>" or "/goal <objective>"
			const drafting = lower === "draft";
			const objective = drafting ? tail : raw;
			if (!objective) return notify(ctx, "usage: /goal <objective> · /goal draft <objective> · /goal status", "warning");
			const carrying = state?.objective === objective ? state.contract : {};
			state = {
				...newGoal(objective, { sessionFile: sessionTag(ctx), contract: carrying }),
				status: drafting ? "drafting" : "active",
			} as PersistedState;
			persist(ctx);
			notify(ctx, `🎯 ${drafting ? "drafting a contract for" : "goal set"} — ${objective} · budget ${state.maxTurns} · judge=${mode}`);
			await queue(drafting ? renderDraftPrompt(objective) : renderContinuation(state), { kind: drafting ? "draft" : "first-step", turn: 1 });
		},
	});
}
