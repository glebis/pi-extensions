/**
 * herdr — native herdr tools for pi (only inside a herdr pane).
 *
 * Registers typed tools so the agent can observe and orchestrate sibling
 * panes: overview of agents/workspaces, reading pane output, dispatching
 * sub-agent tasks via the herdr-task wrapper, and blocking waits with
 * Esc-cancellation. Also maintains the session manifest consumed by
 * `herdr-restore` for post-reboot session restoration.
 *
 * All registration is conditional on HERDR_ENV=1 — zero footprint outside herdr.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  insideHerdr,
  selfPane,
  selfWorkspace,
  runHerdr,
  findHerdrTask,
  writeManifestEntry,
  agentListFrom,
  paneListFrom,
  workspaceListFrom,
  type HerdrPane,
} from "./herdr-bridge";

const herdrAgent = StringEnum(["claude", "codex", "pi", "opencode"] as const, {
  description: "Agent CLI to launch in the new tab (default claude, like herdr-task)",
});

export default function (pi: ExtensionAPI) {
  if (!insideHerdr()) return; // inert unless running inside herdr

  // ── Tool: herdr_overview ────────────────────────────────────────────────
  pi.registerTool({
    name: "herdr_overview",
    label: "herdr Overview",
    description:
      "Snapshot of the running herdr instance: workspaces and detected agents with their " +
      "status (idle/working/blocked/done). Your own pane is marked. Read-only.",
    promptSnippet: "See what other agents/panes in herdr are doing",
    promptGuidelines: [
      "Use herdr_overview before assuming nothing else is running: it shows sibling agents, their panes and status.",
],
    parameters: Type.Object({
      workspace: Type.Optional(
        Type.String({ description: "Scope to one workspace id/label (default: all workspaces)" }),
      ),
      agents_only: Type.Optional(
        Type.Boolean({ description: "Only list detected agent panes (default true)" }),
      ),
    }),
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      const wsRes = await runHerdr(pi, ["workspace", "list"], { timeoutMs: 15_000, signal });
      const workspaces = workspaceListFrom(wsRes.json);
      let agents: HerdrPane[] = [];
      let paneCount = 0;
      try {
        const pRes = await runHerdr(pi, ["pane", "list"], { timeoutMs: 15_000, signal });
        agents = agentListFrom(pRes.json);
        paneCount = paneListFrom(pRes.json).length;
      } catch { /* pane list optional */ }

      const filter = (params.workspace ?? "").toLowerCase().replace(/^\*/, "");
      const scoped = agents.filter(
        (a) => !filter || a.workspace_id === filter || workspaceLabelOf(workspaces, a.workspace_id)?.toLowerCase().includes(filter),
      );
      const showShells = params.agents_only === false;
      const lines = scoped.map((a) => {
        const self = a.pane_id === selfPane() ? "  ← you" : "";
        const wsLabel = workspaceLabelOf(workspaces, a.workspace_id) ?? a.workspace_id;
        return [
          `${a.pane_id}  ${a.agent ?? "?"}  ${a.agent_status}`,
          `      ws=${wsLabel}  cwd=${a.cwd}${a.name ? `  name=${a.name}` : ""}${self}`,
        ].join("\n");
      });
      const header = `herdr: ${workspaces.length} workspaces, ${paneCount} panes, ${agents.length} detected agents`;
      const text = [header, "", ...(lines.length ? lines : ["(no detected agents)"])].join("\n");
      return {
        content: [{ type: "text", text: text.slice(0, 48_000) }],
        details: { workspaces, agents: scoped },
      };
    },

    renderCall(args, theme) {
      const ws = (args as { workspace?: string })?.workspace;
      const text = theme.fg("toolTitle", theme.bold("herdr_overview ")) +
        (ws ? theme.fg("muted", ws) : theme.fg("dim", "all workspaces"));
      return new Text(text, 0, 0);
    },
  });

  // ── Tool: herdr_read ────────────────────────────────────────────────────
  pi.registerTool({
    name: "herdr_read",
    label: "herdr Read",
    description:
      "Read what is on another herdr pane's screen (a neighbor agent, a server, test output). " +
      "Targets accept pane ids from herdr_overview or agent names.",
    parameters: Type.Object({
      target: Type.String({ description: "Pane id (e.g. 'w5:p4') or unique agent name" }),
      source: Type.Optional(
        StringEnum(["visible", "recent", "recent-unwrapped"] as const, {
          description: "visible = current viewport (default), recent = scrollback, recent-unwrapped = joined wraps",
        }),
      ),
      lines: Type.Optional(Type.Integer({ description: "How many lines (default 60)" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      const argv = [
        "agent", "read", params.target,
        "--source", params.source ?? "recent",
        "--lines", String(params.lines ?? 60),
      ];
      const res = await runHerdr(pi, argv, { timeoutMs: 15_000, signal });
      const text = (res.stdout ?? "").trim();
      return {
        content: [{ type: "text", text: text ? text.slice(0, 40_000) : "(empty pane)" }],
        details: { target: params.target },
      };
    },
  });

  // ── Tool: herdr_wait ────────────────────────────────────────────────────
  pi.registerTool({
    name: "herdr_wait",
    label: "herdr Wait",
    description:
      "Block until a herdr pane shows specific output or an agent reaches a status. " +
      "Esc cancels. Use after dispatching work or starting a server in a sibling pane.",
    parameters: Type.Object({
      target: Type.String({ description: "Pane id or agent name (from herdr_overview)" }),
      match: Type.Optional(Type.String({ description: "Wait until this text appears (output wait)" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat match as regex" })),
      status: Type.Optional(
        StringEnum(["idle", "working", "blocked", "done", "unknown"] as const, {
          description: "Wait until agent reaches this status (alternative to match)",
        }),
      ),
      timeout_seconds: Type.Optional(Type.Integer({ description: "Give up after N seconds (default 300)" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      if (!params.match && !params.status) {
        throw new Error("herdr_wait requires `match` (text) or `status`");
      }
      if (params.match && params.status) {
        throw new Error("herdr_wait takes either `match` or `status`, not both");
      }
      const timeoutMs = Math.min((params.timeout_seconds ?? 300), 3600) * 1000;
      const argv = params.match
        ? ["wait", "output", params.target, "--match", params.match, "--timeout", String(timeoutMs)]
        : ["agent", "wait", params.target, "--status", params.status!, "--timeout", String(timeoutMs)];
      if (params.match && params.regex) argv.push("--regex");
      const res = await runHerdr(pi, argv, { timeoutMs: timeoutMs + 10_000, signal });
      return {
        content: [{ type: "text", text: res.stdout.trim() || `condition met (or timed out) for ${params.target}` }],
        details: { target: params.target, match: params.match ?? null, status: params.status ?? null },
      };
    },
  });

  // ── Tool: herdr_dispatch ────────────────────────────────────────────────
  const dispatchGuidelines = [
    "herdr_dispatch: launching an agent costs money and can modify repos — only when the user explicitly asks to run/spawn/hand off work to another agent, and confirm scope for anything that writes outside /tmp.",
    "herdr_dispatch briefs must be self-contained: the spawned agent inherits nothing — absolute paths, explicit 'do NOT modify' constraints for read-only tasks, and where to write output.",
  ];
  pi.registerTool({
    name: "herdr_dispatch",
    label: "herdr Dispatch",
    description:
      "Hand a self-contained task to another coding agent (claude/codex/pi/opencode) in a new herdr tab. " +
      "Runs the herdr-task wrapper: creates the tab, prompts the agent, waits, collects output, optionally closes the tab. " +
      "Use --detach to start it and collect later (then pair with herdr_wait + herdr_read).",
    promptSnippet: "Spawn a sub-agent task in a sibling herdr pane and get its result",
    promptGuidelines: dispatchGuidelines,
    parameters: Type.Object({
      brief: Type.String({
        description:
          "Full self-contained task brief for the spawned agent: absolute paths, constraints, output location.",
      }),
      agent: Type.Optional(herdrAgent),
      label: Type.Optional(Type.String({ description: "Tab label (default: first words of the brief)" })),
      detach: Type.Optional(Type.Boolean({ description: "Start and return immediately with the ids (default false)" })),
      close_when_done: Type.Optional(Type.Boolean({ description: "Close the tab once the agent reports done" })),
      split: Type.Optional(Type.Boolean({ description: "Split current pane instead of a new tab" })),
      timeout_seconds: Type.Optional(Type.Integer({ description: "Wait limit in seconds (default 1800)" })),
      focus: Type.Optional(Type.Boolean({ description: "Focus the new tab (default: keep focus here)" })),
    }),
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      const task = findHerdrTask();
      if (!task) {
        throw new Error(
          "herdr-task wrapper not found (looked in ~/.claude/skills/herdr and ~/.agents/skills/herdr). " +
          "Set HERDR_TASK_BIN to the script path.",
        );
      }
      // The brief goes in as a FILE so quotes/backticks/bracketed paste never mangle it.
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const briefFile = join(mkdtempSync(join(tmpdir(), "herdr-brief-")), "brief.md");
      writeFileSync(briefFile, params.brief, "utf8");

      const argv = [task, "--file", briefFile];
      if (params.agent) argv.push("--agent", params.agent);
      if (params.label) argv.push("--label", params.label);
      if (params.detach) argv.push("--detach");
      if (params.close_when_done) argv.push("--close-when-done");
      if (params.split) argv.push("--pane");
      if (params.focus) argv.push("--focus");
      argv.push("--timeout", String(Math.min(params.timeout_seconds ?? 1800, 7200)));

      onUpdate?.({ content: [{ type: "text", text: `dispatching → ${params.agent ?? "claude"}…` }], details: {} });
      const result = await pi.exec("python3", argv, {
        timeout: params.detach ? 120_000 : Math.min(params.timeout_seconds ?? 1800, 7200) * 1000 + 60_000,
        signal,
      });
      const stdout = (result.stdout ?? "").trim();
      const stderr = (result.stderr ?? "").trim();
      if (result.code !== 0) {
        throw new Error(`herdr-task exit ${result.code}${stderr ? `: ${stderr.slice(0, 800)}` : stdout ? ` — tail: ${stdout.slice(-800)}` : ""}`);
      }
      return {
        content: [{ type: "text", text: (stdout || stderr || "(no output)").slice(0, 40_000) }],
        details: { agent: params.agent ?? "claude", detach: !!params.detach, argv },
      };
    },

    renderCall(args, theme) {
      const p = (args ?? {}) as { agent?: string; detach?: boolean; brief?: string };
      let text = theme.fg("toolTitle", theme.bold("herdr_dispatch "));
      text += theme.fg("accent", p.agent ?? "claude");
      if (p.detach) text += theme.fg("muted", " (detach)");
      if (p.brief) {
        const one = p.brief.replace(/\s+/g, " ");
        text += theme.fg("dim", ` "${one.length > 50 ? one.slice(0, 50) + "…" : one}"`);
      }
      return new Text(text, 0, 0);
    },
  });

  // ── Command: /herdr-restore — passthrough to the restore script ─────────
  pi.registerCommand("herdr-restore", {
    description: "Plan or run pi session restoration after reboot (dry-run by default)",
    handler: async (args, _ctx) => {
      const script = (process.env.PI_HERDR_RESTORE_BIN ?? "~/.local/bin/herdr-restore").replace(/^~/, homedir());
      const rest = args ? args.trim().split(/\s+/) : ["--workspace", selfWorkspace(), "--dry-run"];
      try {
        const result = await pi.exec("python3", [script, ...rest], { timeout: 120_000 });
        const text = [(result.stdout ?? ""), (result.stderr ?? "")].filter(Boolean).join("\n").trim();
        pi.sendMessage({
          customType: "herdr-restore",
          content: `$ herdr-restore ${rest.join(" ")}\n\n\`\`\`\n${text || "(no output)"}\n\`\`\``,
          display: true,
        }, { deliverAs: "nextTurn" });
      } catch (e) {
        pi.sendMessage({
          customType: "herdr-restore",
          content: `herdr-restore failed: ${e instanceof Error ? e.message : String(e)}`,
          display: true,
        }, { deliverAs: "nextTurn" });
      }
    },
  });

  // ── Session hooks: manifest + status ────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    try {
      const entry = await writeManifestEntry(pi, ctx as never);
      if (entry) {
        ctx.ui.setStatus("herdr", `${entry.workspaceLabel ?? entry.workspace} · ${entry.pane} · manifest ok`);
      }
    } catch { /* manifest is best-effort */ }
  });
}

function workspaceLabelOf(
  workspaces: { workspace_id: string; label: string }[],
  id: string,
): string | undefined {
  return workspaces.find((w) => w.workspace_id === id)?.label;
}