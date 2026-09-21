# telegram-telethon — pi extension

Native Telegram tools for [pi](https://github.com/earendil-works/pi-mono), wrapping the
`telegram-telethon` skill CLI (Telethon under the hood) installed on this machine.

Instead of the LLM shelling out through bash to `tg.py`, pi gets typed tools it can call
directly, with JSON-parsed results, sensible per-action timeouts, Esc-cancel propagation,
output truncation at the standard 50KB/2000-line cap, and the skill's draft-vs-send
safety rules baked into the prompt guidelines.

## Tools

### `telegram`

One tool, `action` enum over the full tg.py surface:

| Read | Write | Media | Publishing |
|------|-------|-------|------------|
| `status`, `chats`, `recent`, `search`, `unread`, `thread` | `send`, `edit`, `delete`, `forward`, `mark_read` | `download`, `transcribe` | `draft`, `drafts`, `draft_send`, `publish`, `lint_channel` |

Read actions return parsed JSON in `details` (e.g. chat list with ids, unread counts,
last-message timestamps). Validation errors for malformed calls (e.g. `send` without
`text`/`file`) surface as tool errors with actionable messages.

Draft-vs-send semantics (from the skill, enforced via prompt guidelines):

- explicit *"драфт" / "draft"* → action `draft`
- explicit *"отправь" / "send"* → action `send`
- ambiguous (*"write a message to X"*) → draft or ask first

`chat: "me"` targets the user's own Saved Messages.

### `telegram_daemon`

- `status` — reports running/not-running via `pgrep` + recent `daemon.log` tail
  (the skill's own `tgd.py status` is a stub)
- `logs` — last N lines of `~/.config/telegram-telethon/daemon.log`
  (the skill's `tgd.py logs` blocks forever on `tail -f`; this tool does not)
- `start` — launches `tgd.py start` detached via `nohup`, verifies the process appeared

## User commands

- `/tg <args…>` — direct `tg.py` passthrough (e.g. `/tg status`, `/tg list --limit 5`).
  Output is appended to the session so the LLM can see it next turn. User-invoked only.

## Requirements

- The `telegram-telethon` skill checkout at `~/.agents/skills/telegram-telethon/`
  (authenticated once via `python3 scripts/tg.py setup`)
- `python3` on PATH (override with `TG_PYTHON`)
- `TELEGRAM_TELETHON_DIR` — optional override for the skill location
- `TG_TELETHON_CONFIG_DIR` — optional override for the config dir

## Files

```
~/.pi/agent/extensions/telegram-telethon/
├── index.ts        # entry — registers tools + /tg command
├── tg-bridge.ts    # CLI discovery, argv building, validation, JSON formatting
└── README.md
```

`node_modules/` contains only symlinks into pi's own bundled dependencies
(`typebox`, `@earendil-works/pi-*`, `@types/node`) for editor/tsc support;
at runtime pi resolves those packages itself.

## Typecheck

```bash
cd ~/.pi/agent/extensions/telegram-telethon
npx -y -p typescript tsc --noEmit --strict --skipLibCheck \
  --module esnext --moduleResolution bundler --target es2022 --types node \
  index.ts tg-bridge.ts
```

Hot-reload changes in a running session with `/reload`.