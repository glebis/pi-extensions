# cenno — pi extension

Registers cenno-backed question tools so pi asks you through cenno floating
panels **by default** instead of ending its turn with a plain-text question.

## Tools

- **`ask_user`** — one question, one panel. Mirrors cenno's MCP `ask_user`:
  `title` (+ optional `body_md`, `input.kind`, `choices`, `flow`, `progress`,
  `timeout_s`, `muted`, `say`, `urgency`, `device_hint`, `a2ui`). Returns
  `{answer, via, elapsed_s}` or `{answered:false}` on timeout (never a yes).
- **`ask_sequence`** — several questions in one panel, instant advance.
  Returns `{answers:[…]}` aligned to the questions.

Plus a `/cenno-test [timeout]` command that fires a test panel.

## How it works

Each call spawns one short-lived `cenno --mcp-stdio` bridge process (always
torn down afterwards — no orphans). If the cenno app isn't running, the
extension launches `cenno --tray` and waits for
`~/Library/Application Support/app.cenno/mcp.sock`. Esc in pi cancels the
pending panel via the agent abort signal. Omitted fields (flow, timeout_s)
defer to cenno's own `~/.cenno/config.json` defaults.

## Configuration

- Binary path: set `CENNO_BIN` if cenno isn't in `/Applications`.
- Panel geometry, default flow/timeout, TTS: `~/.cenno/config.json` (cenno app).
- Requires macOS with cenno installed: `brew install --cask glebis/tap/cenno`.