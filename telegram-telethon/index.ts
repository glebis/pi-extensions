/**
 * telegram-telethon — native Telegram tools for pi.
 *
 * Wraps the installed `telegram-telethon` skill CLI (Telethon under the hood)
 * as first-class pi tools, so the LLM can read/search/send/edit Telegram,
 * manage drafts, download + transcribe media, publish channel drafts, and
 * control the monitor daemon — without shelling out through bash.
 *
 * Config:  ~/.config/telegram-telethon/   (managed by the skill's setup)
 * Override skill location with TELEGRAM_TELETHON_DIR, python with TG_PYTHON.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildArgv,
  formatResult,
  runTg,
  validateParams,
  ACTION_TIMEOUT_MS,
  getTgScript,
  getTgdScript,
  DEFAULT_TIMEOUT_MS,
  type TelegramParams,
  type TelegramAction,
} from "./tg-bridge";

const ACTIONS = [
  "status", "chats", "recent", "search", "unread", "thread",
  "send", "edit", "delete", "forward", "mark_read",
  "draft", "drafts", "draft_send",
  "download", "transcribe", "lint_channel", "publish",
] as const;

const telegramSchema = Type.Object({
  action: StringEnum(ACTIONS as unknown as [TelegramAction, ...TelegramAction[]], {
    description:
      "Operation: status (connection), chats (list dialogs), recent (last messages), " +
      "search (by content), unread, thread (forum topic), send, edit, delete, forward, " +
      "mark_read, draft (save/clear a draft), drafts (list), draft_send (send existing draft), " +
      "download (media), transcribe (voice), lint_channel (detect leaked markup), publish (draft→channel).",
  }),
  chat: Type.Optional(
    Type.String({
      description:
        'Chat name, @username, or chat title. Use "me" for your own Saved Messages (the literal "Saved Messages" does not resolve).',
    }),
  ),
  chat_id: Type.Optional(Type.Integer({ description: "Numeric chat ID (alternative to chat)" })),
  query: Type.Optional(
    Type.String({ description: "search: search text; chats: filter by name" }),
  ),
  text: Type.Optional(
    Type.String({ description: "Message text for send/edit/draft. For draft, empty string clears that chat's draft." }),
  ),
  message_id: Type.Optional(
    Type.Integer({ description: "Single message ID (edit, download, transcribe specific message, lint)" }),
  ),
  message_ids: Type.Optional(
    Type.Array(Type.Integer(), { description: "Message IDs for delete / forward" }),
  ),
  limit: Type.Optional(Type.Integer({ description: "Max items to fetch (default per CLI)" })),
  days: Type.Optional(Type.Integer({ description: "recent: only fetch messages from last N days" })),
  thread_id: Type.Optional(Type.Integer({ description: "thread: forum thread ID" })),
  reply_to: Type.Optional(Type.Integer({ description: "send/draft: reply to this message ID" })),
  topic: Type.Optional(Type.Integer({ description: "send: forum topic ID" })),
  file: Type.Optional(Type.String({ description: "send: path of a file to attach" })),
  markdown: Type.Optional(
    Type.Boolean({ description: "send: convert markdown (##, **, _, [text](url), bullets) to Telegram HTML" }),
  ),
  html: Type.Optional(
    Type.Boolean({ description: "send: text is already Telegram HTML (<b>, <a href>, ...)" }),
  ),
  schedule: Type.Optional(
    Type.String({
      description:
        'send/publish: schedule delivery — "+1h", "+30m", "tomorrow 09:30", or ISO "2026-04-20T15:00" (naive times = Europe/Berlin)',
    }),
  ),
  from_chat: Type.Optional(Type.String({ description: "forward: source chat" })),
  to_chat: Type.Optional(Type.String({ description: "forward: destination chat" })),
  max_id: Type.Optional(Type.Integer({ description: "mark_read: mark up to this message ID" })),
  output_dir: Type.Optional(Type.String({ description: "download: output directory (default ~/Downloads)" })),
  media_type: Type.Optional(
    StringEnum(["voice", "video", "photo", "document"] as const, {
      description: "download: filter by media type",
    }),
  ),
  method: Type.Optional(
    StringEnum(["telegram", "groq", "whisper"] as const, {
      description: "transcribe: transcription method (default telegram Premium; groq/whisper fallbacks)",
    }),
  ),
  draft: Type.Optional(
    Type.String({ description: "publish: draft markdown slug or path, e.g. 'Channels/klodkot/drafts/20260416-post'" }),
  ),
  dry_run: Type.Optional(Type.Boolean({ description: "publish: preview without sending" })),
  no_revoke: Type.Optional(Type.Boolean({ description: "delete: do not delete for everyone" })),
  clear_all: Type.Optional(Type.Boolean({ description: "draft: clear ALL drafts" })),
  overwrite: Type.Optional(Type.Boolean({ description: "draft: replace existing draft instead of appending" })),
  no_preview: Type.Optional(Type.Boolean({ description: "draft: disable link preview" })),
  lines: Type.Optional(Type.Integer({ description: "daemon logs: number of lines" })),
});

export default function (pi: ExtensionAPI) {
  // ── Tool: telegram ──────────────────────────────────────────────────────
  pi.registerTool({
    name: "telegram",
    label: "Telegram",
    description:
      "Full Telegram client: read chats/messages, search, send/edit/delete/forward, drafts, " +
      "download media, transcribe voice, publish channel drafts, lint channel formatting. " +
      "Runs the local telegram-telethon (Telethon) CLI with the user's authenticated account — " +
      "no configuration needed. Prefer this over any bash/curl/network workaround for Telegram.",
    promptSnippet: "Read, search, send, draft, and manage Telegram chats and media",
    promptGuidelines: [
      "Use telegram for all Telegram operations instead of running python/curl or suggesting the user open the app.",
      "telegram draft-vs-send rule: an explicit 'draft/драфт' request → action 'draft'; an explicit 'send/отправь/пошли' request → action 'send'; for ambiguous requests like 'write a message to X', save a draft or ask the user first — only action 'send', 'edit', 'draft_send', 'delete', or 'forward' when instruction is explicit.",
      'telegram: chat "me" addresses the user\'s own Saved Messages; increase limit when a chat is not found by name.',
    ],
    parameters: telegramSchema,
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      const p = params as unknown as TelegramParams;
      const error = validateParams(p);
      if (error) throw new Error(error);

      onUpdate?.({
        content: [{ type: "text", text: `Telegram ${p.action}…` }],
        details: { action: p.action },
      });

      const argv = buildArgv(p);
      const timeout = ACTION_TIMEOUT_MS[p.action] ?? DEFAULT_TIMEOUT_MS;
      const result = await runTg(pi, argv, timeout, signal);
      const { text, details } = formatResult(result.stdout);
      return {
        content: [{ type: "text", text }],
        details: { ...((details as object) ?? {}), argv },
      };
    },

    renderCall(args, theme) {
      const p = (args ?? {}) as TelegramParams;
      let text = theme.fg("toolTitle", theme.bold("telegram "));
      text += theme.fg("accent", p.action ?? "?");
      const where = p.chat ?? p.from_chat ?? p.draft ?? (p.chat_id !== undefined ? `id:${p.chat_id}` : "");
      if (where) text += theme.fg("muted", ` ${where}`);
      if (p.text) {
        const oneLine = p.text.replace(/\s+/g, " ");
        text += theme.fg("dim", ` "${oneLine.length > 40 ? oneLine.slice(0, 40) + "…" : oneLine}"`);
      }
      return new Text(text, 0, 0);
    },
  });

  // ── Tool: telegram_daemon ───────────────────────────────────────────────
  // Note: tgd.py's own "status" is a stub and its "logs" runs `tail -f`
  // (blocks forever), so this tool implements status/logs natively and only
  // delegates the actual start to tgd.py (detached).
  pi.registerTool({
    name: "telegram_daemon",
    label: "Telegram Daemon",
    description:
      "Control the telegram-telethon background monitor daemon (tgd.py): 'status' shows whether it is running (recent log tail included), " +
      "'logs' shows the last N lines of the daemon log, 'start' launches it detached in the background. " +
      "The daemon watches configured chats and runs triggers (configure by editing ~/.config/telegram-telethon/daemon.yaml with normal file tools).",
    parameters: Type.Object({
      action: StringEnum(["status", "logs", "start"] as const, { description: "Daemon operation" }),
      lines: Type.Optional(Type.Integer({ description: "logs/status: number of log lines to show (default 50 / 5)" })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      const configDir = process.env.TG_TELETHON_CONFIG_DIR ?? join(homedir(), ".config", "telegram-telethon");
      const logFile = join(configDir, "daemon.log");
      const python = process.env.TG_PYTHON ?? "python3";

      // pgrep -fl tgd.py → "PID python3 /path/tgd.py start"; filter to real matches
      async function findDaemonProcess(): Promise<string[]> {
        const res = await pi.exec("pgrep", ["-fl", "tgd.py"], { timeout: 5_000, signal }).catch(() => null);
        if (!res || res.code !== 0) return [];
        const lines = (res.stdout ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
        return lines.filter((l) => /\b(python3?|\.)\b/.test(l) || l.includes("tgd.py"));
      }

      async function tailLog(lines: number): Promise<string> {
        const res = await pi.exec("tail", ["-n", String(lines), logFile], { timeout: 5_000, signal }).catch(() => null);
        return res && res.code === 0 && res.stdout?.trim() ? res.stdout.trim() : "(no daemon.log yet)";
      }

      if (params.action === "logs") {
        const text = await tailLog(params.lines ?? 50);
        return { content: [{ type: "text", text }], details: { logFile } };
      }

      if (params.action === "status") {
        const procs = await findDaemonProcess();
        const log = await tailLog(params.lines ?? 5);
        const state = procs.length > 0
          ? `daemon: RUNNING${procs.length > 1 ? ` (${procs.length} processes)` : ""}\n${procs.join("\n")}`
          : "daemon: not running";
        return { content: [{ type: "text", text: `${state}\n\nrecent log:\n${log}` }], details: { running: procs.length > 0, procs } };
      }

      // start — detached so the tool returns instead of blocking on the daemon loop
      const tgd = getTgdScript();
      const shellCmd = `nohup "${python}" "${tgd}" start >> "${logFile}" 2>&1 & echo started`;
      await pi.exec("/bin/sh", ["-c", shellCmd], { timeout: 10_000, signal });
      await new Promise((r) => setTimeout(r, 2_000));
      const procs = await findDaemonProcess();
      const text = procs.length > 0
        ? `daemon started (pid ${procs[0].split(/\s+/)[0]}). Recent log:\n${await tailLog(3)}`
        : "start command issued, but no daemon process detected after 2s — check daemon.log";
      return { content: [{ type: "text", text }], details: { running: procs.length > 0 } };
    },
  });

  // ── Command: /tg <args…> — direct passthrough, no LLM turn ──────────────
  // Output lands in the transcript as a message the LLM can see next turn.
  pi.registerCommand("tg", {
    description: "Run telegram-telethon CLI directly, e.g. /tg status, /tg list --limit 5",
    handler: async (args, _ctx) => {
      const argv = args ? args.trim().split(/\s+/) : ["status"];
      try {
        const result = await runTg(pi, argv, DEFAULT_TIMEOUT_MS);
        const { text } = formatResult(result.stdout);
        pi.sendMessage({
          customType: "tg-cli",
          content: `/tg ${argv.join(" ")}\n\n\`\`\`\n${text || "(no output)"}\n\`\`\``,
          display: true,
        }, { deliverAs: "nextTurn" });
      } catch (e) {
        pi.sendMessage({
          customType: "tg-cli",
          content: `/tg failed: ${e instanceof Error ? e.message : String(e)}`,
          display: true,
        }, { deliverAs: "nextTurn" });
      }
    },
  });

  // ── Availability check on session start ─────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    try {
      getTgScript();
      ctx.ui.setStatus("telegram", "ready");
    } catch {
      // Skill not installed — tools will surface a helpful error if called.
      ctx.ui.setStatus("telegram", "skill not found");
    }
  });

  pi.on("session_shutdown", async () => {
    // Nothing long-lived: each tool call is a fresh subprocess.
  });
}