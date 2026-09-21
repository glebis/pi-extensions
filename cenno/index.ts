/**
 * cenno — agents ask, you answer (pi extension)
 *
 * Registers `ask_user` and `ask_sequence` tools backed by the cenno macOS app
 * (https://github.com/glebis/cenno). Questions appear as minimal floating
 * panels over whatever the user is doing — without stealing keyboard focus —
 * and answers come back as structured data ({answer, via, elapsed_s}, or
 * {answered:false} on timeout). Prompt guidelines make cenno the default way
 * for the agent to ask questions instead of ending its turn with plain text.
 *
 * Behavior:
 *   - Cold start: launches `cenno --tray` and waits for its MCP socket.
 *   - One short-lived `cenno --mcp-stdio` bridge process per call, always
 *     torn down (no orphaned bridge processes).
 *   - Esc in pi cancels the pending panel via the agent abort signal.
 *   - A timeout is passed through as {answered:false} — never a decision.
 *   - Omitted fields (flow, timeout_s) defer to cenno's ~/.cenno defaults.
 *   - CENNO_BIN overrides the binary path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { cennoBinaryAvailable, cennoToolCall } from "./cenno-client";

const FLOWS = ["mood", "question", "ema", "reminder", "ambient"] as const;
const INPUT_KINDS = ["text", "voice", "voice_text", "choice", "scale", "confirm", "none"] as const;
const URGENCIES = ["low", "normal", "high"] as const;

const FlowSchema = StringEnum(FLOWS);
const InputKindSchema = StringEnum(INPUT_KINDS);

const AskRequestSchema = Type.Object({
	title: Type.String({
		description:
			"The question shown to the user. Keep it short — put detail in body_md. One decision per panel.",
	}),
	body_md: Type.Optional(Type.String({ description: "Markdown body shown under the title." })),
	input: Type.Optional(
		Type.Object(
			{ kind: Type.Optional(InputKindSchema) },
			{
				description:
					"Widget: text | voice_text | choice | scale | confirm | none. Default text. 'choice' needs `choices`; 'confirm' answers yes/no; 'scale' is a fixed 1–7 rating; 'none' shows info and auto-dismisses.",
			},
		),
	),
	choices: Type.Optional(
		Type.Array(Type.String(), { description: "2–5 short options; required when kind=choice." }),
	),
	flow: Type.Optional(FlowSchema),
	progress: Type.Optional(
		Type.Object(
			{ step: Type.Number(), total: Type.Number() },
			{ description: "Dot pagination for multi-step flows, e.g. {step: 2, total: 5}." },
		),
	),
	timeout_s: Type.Optional(
		Type.Number({
			description: "Seconds to wait. Omit to use cenno's configured default (currently 90).",
		}),
	),
	muted: Type.Optional(Type.Boolean({ description: "Open the panel silently (no voice-out)." })),
	say: Type.Optional(
		Type.String({ description: "Short spoken summary for voice-out instead of reading the full prompt." }),
	),
	urgency: Type.Optional(StringEnum(URGENCIES)),
	device_hint: Type.Optional(
		Type.String({ description: 'Optional cross-device routing hint: "phone" | "ipad" | "watch".' }),
	),
	a2ui: Type.Optional(
		Type.Unknown({
			description:
				"Advanced: A2UI v0.9 payload (array of 3 messages, catalog cenno:catalog/v1) for custom widgets — 1–5 scales, sliders, image choices. Prefer built-in input kinds when they fit.",
		}),
	),
});

interface AskDetails {
	title: string;
	kind: string;
	answered: boolean;
	answer?: string;
	via?: string;
	elapsed_s?: number;
	cancelled?: boolean;
}

interface SequenceDetails {
	count: number;
	answers: string[];
	answeredCount: number;
}

function kindOf(params: any): string {
	return params?.input?.kind ?? "text";
}

/** Models often send `choices` without input.kind (which defaults to text) — normalize to choice. */
function normalizeArgs(params: any): any {
	const args = { ...params };
	const hasChoices = Array.isArray(args.choices) && args.choices.length > 0;
	const kind = args?.input?.kind;
	if (hasChoices && (!kind || kind === "text")) {
		args.input = { ...(args.input ?? {}), kind: "choice" };
	}
	return args;
}

function textOfContent(result: any): string {
	const first = result?.content?.[0];
	return first?.type === "text" ? first.text : "";
}

function detailsFromRaw(title: string, params: any, raw: string): { content: any[]; details: AskDetails } {
	let parsed: any = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		/* keep raw only */
	}
	const answer = parsed?.answer;
	return {
		content: [{ type: "text", text: raw }],
		details: {
			title,
			kind: kindOf(params),
			answered: answer !== undefined && answer !== null,
			answer: answer !== undefined && answer !== null ? String(answer) : undefined,
			via: parsed?.via,
			elapsed_s: typeof parsed?.elapsed_s === "number" ? parsed.elapsed_s : undefined,
		},
	};
}

function budgetFor(timeoutS?: number): number {
	return Math.min(((timeoutS as number | undefined) ?? 120) * 1000 + 45_000, 15 * 60_000);
}

export default function cennoExtensionEntry(pi: ExtensionAPI) {
	if (!cennoBinaryAvailable()) {
		pi.on("session_start", async (_event, ctx) => {
			ctx.ui.notify(
				"cenno extension: cenno binary not found — ask_user/ask_sequence not registered. Install cenno (brew install --cask glebis/tap/cenno) or set CENNO_BIN.",
				"warning",
			);
		});
		return;
	}

	pi.registerTool({
		name: "ask_user",
		label: "cenno · ask user",
		description:
			"Ask the user a question through a cenno floating panel (macOS). The panel appears over any app without stealing focus; the answer returns as structured JSON {answer, via, elapsed_s}, or {answered:false} on timeout. This is the default way to ask the user anything.",
		promptSnippet:
			"Ask the user a question via a cenno floating panel; returns structured {answer, via, elapsed_s}",
		promptGuidelines: [
			"Use ask_user by default whenever you need to ask the user anything — a decision, confirmation, preference, rating, or short free-text input — instead of ending your turn with a question in plain text: the cenno floating panel returns a structured answer even when the terminal is unfocused.",
			"Use ask_sequence when several related questions belong together in one panel. Keep one decision per question: kind 'choice' with 2–5 short options for picks, 'confirm' for yes/no before risky actions, 'scale' for ratings, 'text'/'voice_text' for free-form answers.",
			"Never treat an ask_user timeout (answered:false) as a yes or as any decision — skip, use a safe default, or abort. Ask only when the answer changes what you do next; a timeout may simply mean the user didn't see the panel.",
		],
		parameters: AskRequestSchema,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			try {
				const raw = await cennoToolCall("ask_user", normalizeArgs(params), {
					signal,
					timeoutMs: budgetFor(params.timeout_s),
				});
				return detailsFromRaw(params.title, params, raw);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (/abort|cancel/i.test(message) || signal?.aborted) {
					return {
						content: [{ type: "text", text: JSON.stringify({ answered: false, reason: "cancelled" }) }],
						details: { title: params.title, kind: kindOf(params), answered: false, cancelled: true },
					};
				}
				throw new Error(`cenno ask_user failed: ${message}`);
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("cenno ask ")) + theme.fg("muted", String(args?.title ?? ""));
			const extras: string[] = [];
			const kind = kindOf(args);
			if (kind !== "text") extras.push(`kind: ${kind}`);
			if (Array.isArray(args?.choices) && args.choices.length) extras.push(args.choices.join(" / "));
			if (args?.flow) extras.push(String(args.flow));
			if (args?.timeout_s) extras.push(`${args.timeout_s}s`);
			if (extras.length) text += `\n${theme.fg("dim", `  ${extras.join(" · ")}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const d = result.details as AskDetails | undefined;
			if (!d || typeof d.answered !== "boolean") {
				// thrown errors arrive without details — render the raw text
				return new Text(textOfContent(result), 0, 0);
			}
			if (d.cancelled) return new Text(theme.fg("dim", "cancelled"), 0, 0);
			if (d.answered) {
				const elapsed = d.elapsed_s !== undefined ? ` · ${d.elapsed_s.toFixed(1)}s` : "";
				return new Text(
					theme.fg("success", "✓ ") +
						theme.fg("accent", d.answer ?? "") +
						theme.fg("dim", `  (via ${d.via ?? "answer"}${elapsed})`),
					0,
					0,
				);
			}
			return new Text(theme.fg("warning", "⏱ no decision (timeout)"), 0, 0);
		},
	});

	pi.registerTool({
		name: "ask_sequence",
		label: "cenno · ask sequence",
		description:
			"Ask several related questions in ONE cenno panel; the panel stays up and advances instantly between questions. Returns {answers:[…]} aligned to the questions array; a per-question timeout ends the run early. Prefer this over looping ask_user when the questions belong together.",
		promptSnippet:
			"Ask several related questions in one cenno panel; answers come back as an ordered array",
		parameters: Type.Object({
			questions: Type.Array(AskRequestSchema, {
				minItems: 1,
				description: "ask_user-shaped questions, in order. Progress dots auto-fill.",
			}),
			flow: Type.Optional(FlowSchema),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const normalized = {
				...params,
				questions: params.questions.map((q: any) => normalizeArgs(q)),
			};
			const maxTimeout = Math.max(0, ...normalized.questions.map((q: any) => Number(q?.timeout_s) || 0));
			try {
				const raw = await cennoToolCall("ask_sequence", normalized, {
					signal,
					timeoutMs: budgetFor(maxTimeout > 0 ? maxTimeout : undefined),
				});
				let parsed: any = null;
				try {
					parsed = JSON.parse(raw);
				} catch {
					/* keep raw only */
				}
				const answers: string[] = (parsed?.answers ?? []).map((a: any) =>
					a?.answer !== undefined && a?.answer !== null ? String(a.answer) : "",
				);
				const details: SequenceDetails = {
					count: normalized.questions.length,
					answers,
					answeredCount: answers.filter((a) => a.length > 0).length,
				};
				return { content: [{ type: "text", text: raw }], details };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (/abort|cancel/i.test(message) || signal?.aborted) {
					return {
						content: [{ type: "text", text: JSON.stringify({ answered: false, reason: "cancelled" }) }],
						details: { count: params.questions.length, answers: [], answeredCount: 0 },
					};
				}
				throw new Error(`cenno ask_sequence failed: ${message}`);
			}
		},

		renderCall(args, theme, _context) {
			const qs = Array.isArray(args?.questions) ? args.questions : [];
			const head = theme.fg("toolTitle", theme.bold(`cenno sequence (${qs.length})`));
			const lines = qs.map((q: any) => theme.fg("dim", `  · ${String(q?.title ?? "")}`));
			return new Text([head, ...lines].join("\n"), 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const d = result.details as SequenceDetails | undefined;
			if (!d || !Array.isArray(d.answers)) return new Text(textOfContent(result), 0, 0);
			const head = theme.fg("success", `✓ ${d.answeredCount}/${d.count} answered`);
			const lines = d.answers.map((a, i) => theme.fg("dim", `  ${i + 1}. `) + theme.fg("accent", a));
			return new Text([head, ...lines].join("\n"), 0, 0);
		},
	});

	pi.registerCommand("cenno-test", {
		description: "Open a cenno test panel to verify the pi ↔ cenno round-trip",
		handler: async (args, ctx) => {
			const timeout = Math.min(Math.max(Number(args) || 20, 5), 120);
			if (!cennoBinaryAvailable()) {
				ctx.ui.notify("cenno binary not found — install cenno or set CENNO_BIN", "error");
				return;
			}
			ctx.ui.notify("cenno: opening test panel…", "info");
			try {
				const raw = await cennoToolCall(
					"ask_user",
					{
						title: "cenno ↔ pi round-trip test",
						body_md: "If you can read this panel, the pi `ask_user` extension works.",
						input: { kind: "choice" },
						choices: ["Works", "Nope"],
						timeout_s: timeout,
					},
					{ timeoutMs: (timeout + 30) * 1000 },
				);
				ctx.ui.notify(`cenno answered: ${raw}`, "info");
			} catch (err) {
				ctx.ui.notify(`cenno test failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}