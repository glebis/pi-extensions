# herdr — pi extension

Turns pi into a native participant of the running
[herdr](https://herdr.dev) instance: when pi runs inside a herdr pane
(`HERDR_ENV=1`) it registers orchestration tools; outside herdr it
registers **nothing**.

## Tools

| Tool | Purpose |
|---|---|
| `herdr_overview` | Workspaces + detected agents with status (idle/working/blocked/done); your pane is marked. The "who is doing what" snapshot. |
| `herdr_read` | Read another pane's screen (viewport / recent scrollback / unwrapped transcript). |
| `herdr_wait` | Block until pane output matches a string/regex or an agent reaches a status; Esc-cancellable. |
| `herdr_dispatch` | Hand a self-contained task to another agent (claude/codex/pi/opencode) via the `herdr-task` wrapper — create tab → prompt → wait → collect → optional close. Briefs travel as files so paste never mangles them. |

## Session manifest + restore

On every TUI `session_start` inside herdr, the extension appends one line to
`~/.local/state/pi-herdr/manifest.jsonl`:

```
{ ts, hostname, pane, workspace+label, tab+label, cwd, sessionFile, sessionId }
```

herdr restores workspace *layout* after a reboot (workspaces, tabs, pane
trees, cwd) — but panes come back as empty shells. `herdr-restore` closes
the gap: it matches restored panes to manifest entries (workspace
label/id + tab + cwd — stable keys, since herdr pane ids can compact) and
types `cd <cwd> && pi --session <file>` into each.

```bash
herdr-restore                     # dry run plan (all workspaces)
herdr-restore --workspace w5      # scope
herdr-restore --yes               # live restore
herdr-restore --allow-continue    # fall back to 'pi -c' when cwd has sessions but no manifest hit
```

In-session: `/herdr-restore [args]` runs the same script and shows the plan
(defaults to scoped dry-run).

## Automation

`~/Library/LaunchAgents/com.glebkalinin.herdr-restore.plist` runs the script
in launchd mode: waits for the herdr server socket, gives the restored
layout ~10s to materialize, restores, and marks the boot done **only after a
pass that restored something** (incomplete passes retry — safe, because
panes already running an agent are skipped).

Arming automatic live restoration (one-time, deliberate):

```bash
touch ~/.local/state/pi-herdr/ENABLE_LIVE_RESTORE
```

Without the flag the launchd job stays a quiet dry-runner and exits fast on
an empty manifest.

## Companions

- `herdr integration install pi` — official herdr extension reporting
  pi agent state (working/blocked/idle) and the active session path to the
  herdr server. Complements, not duplicates: it feeds herdr's UI/API; this
  extension feeds pi's tools and the restore manifest.

## Safety model

- No credential exposure: talks to herdr over the local socket CLI only
- Manifest is best-effort; failures never break a session
- Restore never touches: focused panes, panes with a detected agent,
  panes whose cwd is missing, entries from other hosts, duplicate targets

## Files

```
~/.pi/agent/extensions/herdr/
├── index.ts          # tools + /herdr-restore + session hooks (env-gated)
├── herdr-bridge.ts   # herdr CLI exec, list parsing, manifest writer
└── README.md
~/.local/bin/herdr-restore                  # standalone restore pass (launchd + manual)
~/.local/state/pi-herdr/                    # manifest.jsonl, restore.log, opt-in flag
~/Library/LaunchAgents/com.glebkalinin.herdr-restore.plist
```