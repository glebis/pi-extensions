/**
 * Bridge between pi and the running herdr instance.
 *
 * Only active when pi runs inside a herdr pane (HERDR_ENV=1) — every entry
 * point checks env so the extension is inert elsewhere. Talks to herdr via
 * the `herdr` CLI over the local socket; never touches secrets.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const STATE_DIR =
  process.env.PI_HERDR_STATE_DIR ?? join(homedir(), ".local", "state", "pi-herdr");
export const MANIFEST_PATH = join(STATE_DIR, "manifest.jsonl");

export function insideHerdr(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID;
}

export function selfPane(): string {
  return process.env.HERDR_PANE_ID ?? "";
}
export function selfWorkspace(): string {
  return process.env.HERDR_WORKSPACE_ID ?? "";
}
export function selfTab(): string {
  return process.env.HERDR_TAB_ID ?? "";
}

/** Run a herdr CLI subcommand; parse stdout as JSON when it parses. */
export async function runHerdr(
  pi: ExtensionAPI,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ code: number; stdout: string; stderr: string; json?: unknown }> {
  const bin = process.env.HERDR_BIN ?? "herdr";
  const result = await pi.exec(bin, args, { timeout: opts.timeoutMs ?? 20_000, signal: opts.signal });
  const stdout = result.stdout ?? "";
  if (result.code !== 0) {
    const detail = ((result.stderr ?? "") || stdout).trim();
    throw new Error(
      `herdr ${args.join(" ")} failed (exit ${result.code})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    // text-only output (pane read etc.)
  }
  return { code: result.code, stdout, stderr: result.stderr ?? "", json };
}

/** Locate the herdr-task wrapper shipped with the herdr skill. */
export function findHerdrTask(): string | null {
  const candidates: string[] = [];
  if (process.env.HERDR_TASK_BIN) candidates.push(process.env.HERDR_TASK_BIN);
  const home = homedir();
  candidates.push(
    join(home, ".claude", "skills", "herdr", "scripts", "herdr-task"),
    join(home, ".agents", "skills", "herdr", "scripts", "herdr-task"),
  );
  return candidates.find((p) => existsSync(p)) ?? null;
}

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
  agent_status: string;
  pane_count: number;
  focused: boolean;
}
export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd: string;
  agent?: string;
  agent_status: string;
  name?: string;
  label?: string;
  focused: boolean;
}
export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label: string;
  pane_count: number;
}

export function paneListFrom(json: unknown): HerdrPane[] {
  return (json as { result?: { panes?: HerdrPane[] } })?.result?.panes ?? [];
}
export function agentListFrom(json: unknown): HerdrPane[] {
  return (json as { result?: { agents?: HerdrPane[] } })?.result?.agents ?? [];
}
export function workspaceListFrom(json: unknown): HerdrWorkspace[] {
  return (json as { result?: { workspaces?: HerdrWorkspace[] } })?.result?.workspaces ?? [];
}
export function tabListFrom(json: unknown): HerdrTab[] {
  return (json as { result?: { tabs?: HerdrTab[] } })?.result?.tabs ?? [];
}

// ── Manifest: durable pane → pi session mapping used by herdr-restore ─────

export interface ManifestEntry {
  version: 1;
  ts: string;
  hostname: string;
  agent: "pi";
  mode: string; // only "tui" entries are restorable
  pane: string;
  workspace: string;
  tab: string;
  workspaceLabel: string | null;
  tabLabel: string | null;
  cwd: string;
  sessionFile: string;
  sessionId: string | null;
}

interface SessionCtx {
  mode: string;
  sessionManager: { getSessionFile(): string | null; getSessionId?: () => string | null };
}

/**
 * Snap the current herdr context + pi session to the manifest.
 * Gated: only TUI sessions inside herdr. Best-effort — never throws to
 * break a session start.
 */
export async function writeManifestEntry(
  pi: ExtensionAPI,
  ctx: SessionCtx,
): Promise<ManifestEntry | null> {
  try {
    if (!insideHerdr() || ctx.mode !== "tui") return null;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile || !sessionFile.startsWith("/")) return null;
    let sessionId: string | null = null;
    try {
      sessionId = ctx.sessionManager.getSessionId?.() ?? null;
    } catch { /* optional */ }

    const pane = selfPane();
    const workspaceId = selfWorkspace();
    const tabId = selfTab();
    const cwd = process.env.HERDR_STARTUP_CWD ?? process.cwd();

    // Resolve stable labels for restore matching (ids may compact across boots).
    let workspaceLabel: string | null = null;
    let tabLabel: string | null = null;
    try {
      const ws = await runHerdr(pi, ["workspace", "list"]);
      const mine = workspaceListFrom(ws.json).find((w) => w.workspace_id === workspaceId);
      workspaceLabel = mine?.label ?? null;
    } catch { /* best effort */ }
    try {
      const tb = await runHerdr(pi, ["tab", "list", "--workspace", workspaceId]);
      tabLabel = tabListFrom(tb.json).find((t) => t.tab_id === tabId)?.label ?? null;
    } catch { /* best effort */ }

    const entry: ManifestEntry = {
      version: 1,
      ts: new Date().toISOString(),
      hostname: hostname(),
      agent: "pi",
      mode: ctx.mode,
      pane,
      workspace: workspaceId,
      tab: tabId,
      workspaceLabel,
      tabLabel,
      cwd,
      sessionFile,
      sessionId,
    };
    appendManifestEntry(entry);
    return entry;
  } catch {
    return null;
  }
}

/** Append one entry as a JSONL line; create dir on demand. */
export function appendManifestEntry(entry: ManifestEntry): void {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(MANIFEST_PATH, JSON.stringify(entry) + "\n", "utf8");
}