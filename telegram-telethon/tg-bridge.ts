/**
 * Bridge to the telegram-telethon skill CLI (scripts/tg.py, scripts/tgd.py).
 *
 * The extension shells out to the installed skill — auth (API id/hash,
 * session file) stays entirely inside the skill's config dir; no secrets
 * pass through this code.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Candidate locations of the telegram-telethon skill checkout. */
function skillDirCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.TELEGRAM_TELETHON_DIR) {
    candidates.push(process.env.TELEGRAM_TELETHON_DIR);
  }
  const home = homedir();
  candidates.push(
    join(home, ".agents", "skills", "telegram-telethon"),
    join(home, ".claude", "skills", "telegram-telethon"),
    join(home, ".codex", "skills", "telegram-telethon"),
  );
  return candidates;
}

let cachedTgScript: string | null = null;
let cachedTgdScript: string | null = null;

function findScript(scripts: string[]): string | null {
  return (
    scripts.find((p) => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    }) ?? null
  );
}

export function getTgScript(): string {
  if (cachedTgScript) return cachedTgScript;
  for (const dir of skillDirCandidates()) {
    const script = join(dir, "scripts", "tg.py");
    if (existsSync(script)) {
      cachedTgScript = script;
      return script;
    }
  }
  throw new Error(
    "telegram-telethon skill not found. Looked in: " +
      skillDirCandidates().join(", ") +
      ". Set TELEGRAM_TELETHON_DIR to the skill checkout.",
  );
}

export function getTgdScript(): string {
  if (cachedTgdScript) return cachedTgdScript;
  for (const dir of skillDirCandidates()) {
    const script = join(dir, "scripts", "tgd.py");
    if (existsSync(script)) {
      cachedTgdScript = script;
      return script;
    }
  }
  throw new Error(
    "telegram-telethon daemon controller not found (tgd.py). " +
      "Set TELEGRAM_TELETHON_DIR to the skill checkout.",
  );
}

export type TelegramAction =
  | "status"
  | "chats"
  | "recent"
  | "search"
  | "unread"
  | "thread"
  | "send"
  | "edit"
  | "delete"
  | "forward"
  | "mark_read"
  | "draft"
  | "drafts"
  | "draft_send"
  | "download"
  | "transcribe"
  | "lint_channel"
  | "publish";

/** Per-action subprocess timeouts, tuned for network + media operations. */
export const ACTION_TIMEOUT_MS: Partial<Record<TelegramAction, number>> = {
  transcribe: 300_000,
  download: 300_000,
  publish: 240_000,
  send: 120_000,
  edit: 120_000,
};
export const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Run tg.py with argv. Throws (→ isError tool result) on:
 * - non-zero exit code
 * - missing script
 */
export async function runTg(
  pi: ExtensionAPI,
  argv: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<CliRunResult> {
  const script = getTgScript();
  const python = process.env.TG_PYTHON ?? "python3";
  const result = await pi.exec(python, [script, ...argv], {
    timeout: timeoutMs,
    signal,
  });

  const tail = (s: string, n = 2000) => {
    s = (s ?? "").trim();
    return s.length > n ? s.slice(-n) : s;
  };

  if (result.code !== 0) {
    const detail = [tail(result.stderr), tail(result.stdout)]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `tg.py exited with code ${result.code}${detail ? `:\n${detail}` : ""}`,
    );
  }
  return { code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export type TelegramParams = {
  action: TelegramAction;
  chat?: string;
  chat_id?: number;
  query?: string;
  text?: string;
  message_id?: number;
  message_ids?: number[];
  limit?: number;
  days?: number;
  thread_id?: number;
  reply_to?: number;
  topic?: number;
  file?: string;
  markdown?: boolean;
  html?: boolean;
  schedule?: string;
  from_chat?: string;
  to_chat?: string;
  max_id?: number;
  output_dir?: string;
  media_type?: "voice" | "video" | "photo" | "document";
  method?: "telegram" | "groq" | "whisper";
  draft?: string;
  dry_run?: boolean;
  no_revoke?: boolean;
  clear_all?: boolean;
  overwrite?: boolean;
  no_preview?: boolean;
  lines?: number;
};

/** Validate action-specific required params; returns a human-readable error or null. */
export function validateParams(p: TelegramParams): string | null {
  switch (p.action) {
    case "send":
      if (!p.chat) return "send requires `chat`";
      if (!p.text && !p.file) return "send requires `text` and/or `file`";
      break;
    case "edit":
      if (!p.chat || !p.message_id || !p.text)
        return "edit requires `chat`, `message_id` and `text`";
      break;
    case "delete":
      if (!p.chat) return "delete requires `chat`";
      if (!p.message_ids?.length) return "delete requires `message_ids` (array of ints)";
      break;
    case "forward":
      if (!p.from_chat || !p.to_chat) return "forward requires `from_chat` and `to_chat`";
      if (!p.message_ids?.length) return "forward requires `message_ids` (array of ints)";
      break;
    case "thread":
      if (!p.chat_id || !p.thread_id) return "thread requires `chat_id` and `thread_id`";
      break;
    case "search":
      if (!p.query) return "search requires `query`";
      break;
    case "publish":
      if (!p.draft) return "publish requires `draft` (draft markdown slug or path)";
      break;
    case "draft":
      if (p.text === undefined && !p.clear_all && !p.chat)
        return "draft requires `text` (use empty string to clear the chat's draft, or `clear_all: true` to clear every draft)";
      break;
  }
  return null;
}

/**
 * Build the tg.py argv for the given params.
 * Flag names mirror scripts/tg.py exactly.
 */
export function buildArgv(p: TelegramParams): string[] {
  const argv: string[] = [];
  // Skip undefined/false values; booleans become bare flags, strings are
  // passed through verbatim (including empty string — used to clear drafts).
  const push = (flag: string, value?: string | number | boolean) => {
    if (value === undefined || value === false) return;
    argv.push(flag);
    if (typeof value !== "boolean") argv.push(String(value));
  };
  const pushFlag = (flag: string) => argv.push(flag);
  // Remap action names to tg.py subcommand names.
  const subcommand: Record<string, string> = {
    mark_read: "mark-read",
    draft_send: "draft-send",
    lint_channel: "lint-channel",
    chats: "list",
  };
  argv.push(subcommand[p.action] ?? p.action);

  switch (p.action) {
    case "status":
      break;

    case "chats":
      push("--limit", p.limit);
      push("--search", p.query);
      pushFlag("--json");
      break;

    case "recent":
      // CLI accepts both positional and --chat; use --chat for uniformity
      if (p.chat) push("--chat", p.chat);
      if (p.chat_id !== undefined) push("--chat-id", p.chat_id);
      push("--limit", p.limit);
      push("--days", p.days);
      pushFlag("--json");
      break;

    case "search":
      argv.push(p.query!);
      push("--chat", p.chat);
      if (p.chat_id !== undefined) push("--chat-id", p.chat_id);
      push("--limit", p.limit);
      pushFlag("--json");
      break;

    case "unread":
      if (p.chat_id !== undefined) push("--chat-id", p.chat_id);
      pushFlag("--json");
      break;

    case "thread":
      push("--chat-id", p.chat_id);
      push("--thread-id", p.thread_id);
      push("--limit", p.limit);
      pushFlag("--json");
      break;

    case "send":
      push("--chat", p.chat);
      if (p.text !== undefined) push("--text", p.text);
      if (p.file) push("--file", p.file);
      if (p.reply_to !== undefined) push("--reply-to", p.reply_to);
      if (p.topic !== undefined) push("--topic", p.topic);
      if (p.markdown) pushFlag("--markdown");
      if (p.html) pushFlag("--html");
      if (p.schedule) push("--schedule", p.schedule);
      break;

    case "edit":
      push("--chat", p.chat);
      push("--message-id", p.message_id);
      push("--text", p.text);
      break;

    case "delete":
      push("--chat", p.chat);
      for (const id of p.message_ids ?? []) argv.push("--message-ids", String(id));
      if (p.no_revoke) pushFlag("--no-revoke");
      break;

    case "forward":
      push("--from", p.from_chat);
      push("--to", p.to_chat);
      for (const id of p.message_ids ?? []) argv.push("--message-ids", String(id));
      break;

    case "mark_read":
      push("--chat", p.chat);
      push("--max-id", p.max_id);
      break;

    case "draft":
      if (p.chat) push("--chat", p.chat);
      if (p.text !== undefined) push("--text", p.text);
      if (p.reply_to !== undefined) push("--reply-to", p.reply_to);
      if (p.no_preview) pushFlag("--no-preview");
      if (p.overwrite) pushFlag("--overwrite");
      if (p.clear_all) pushFlag("--clear-all");
      break;

    case "drafts":
      push("--limit", p.limit);
      break;

    case "draft_send":
      push("--chat", p.chat);
      break;

    case "download":
      push("--chat", p.chat);
      push("--limit", p.limit);
      if (p.output_dir) argv.push("--output", p.output_dir);
      if (p.message_id !== undefined) argv.push("--message-id", String(p.message_id));
      if (p.media_type) push("--type", p.media_type);
      break;

    case "transcribe":
      push("--chat", p.chat);
      if (p.message_id !== undefined) push("--message-id", p.message_id);
      push("--limit", p.limit);
      if (p.method && p.method !== "telegram") push("--fallback", p.method);
      break;

    case "lint_channel":
      push("--chat", p.chat);
      push("--limit", p.limit);
      if (p.message_id !== undefined) push("--message-id", p.message_id);
      pushFlag("--json");
      break;

    case "publish":
      push("--draft", p.draft);
      if (p.dry_run) pushFlag("--dry-run");
      if (p.schedule) push("--schedule", p.schedule);
      break;
  }
  return argv;
}

/**
 * Parse CLI stdout as JSON when possible; format the tool result text.
 * Returns { text, details } — details holds the parsed payload when JSON.
 */
export function formatResult(
  stdout: string,
): { text: string; details: unknown } {
  const raw = (stdout ?? "").trim();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Not JSON (e.g. status/daemon human output) — pass through.
    const t = truncateHead(raw, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    return { text: t.content, details: { output: raw } };
  }

  const pretty = JSON.stringify(payload, null, 2);
  const t = truncateHead(pretty, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  return { text: t.content, details: payload };
}