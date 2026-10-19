# spec-review — pi extension

Independent review of a specification **before** implementation. The lead is
the current pi agent; the reviewers are separate processes of pi, Codex CLI and
Claude Code. There is no `pi-subagents` integration yet: pi reviewers are
launched directly in isolated contexts.

## Install

From the repository root:

```bash
git clone https://github.com/glebis/pi-extensions ~/.pi/agent/extensions
```

Or add just this extension by copying the directory into
`~/.pi/agent/extensions/`. To try it for one invocation without installing:

```bash
pi -e ./spec-review
```

Or install it permanently from the checked-out directory:

```bash
pi install ./spec-review
```

The current session does not pick up an extension installed mid-session; use
`/reload`. Installing does not modify global settings.

For saved reviewer sets, create `.pi/spec-review.json` in the target project
following `config.example.json`. The model is optional: with `model` absent or
empty the CLI uses its own default and no `--model` flag is passed. To pick one
explicitly, add a `model` with an available ID; the CLIs must be installed and
authenticated beforehand. These settings belong to the separate CLI, not to the
model of the current pi session. The config file is trusted: it decides where
context is sent. Do not put secrets in the context or in Git.

## Interactive panel

Run `/spec-review` inside pi with no arguments. A TUI panel opens with
selectable actions — no browser, no diff. **↑↓ / Tab** move focus, **Enter**
opens the selected action. Setup opens a wizard: specification and context are
typed in; agents, models, limits and quorum are picked from lists. Unavailable
actions are marked with the reason. **PgUp / PgDn** scroll statuses. The letter
shortcuts below are optional.

- **N** — setup: spec path, a saved or custom CLI set, models, round limit,
  minimum reviews, context and repository access. A custom set offers
  Pi/Codex/Claude on their default model, explicit models from presets, and
  available models from the pi registry. The chosen agent/model is removed from
  the list; IDs are generated automatically. In presets duplicates are
  collapsed and invalid entries filtered out; if no valid entry remains, the
  custom-set picker opens. Limit and quorum are chosen only from allowed
  values. Costs are confirmed before the run. The config file is optional for a
  custom set.
- **F** — read the independent reviews and the discussion outcome. Arrows /
  PgUp / PgDn scroll, Esc goes back.
- **R** — retry the failed reviewers. Successful reviews are kept; the
  discussion repeats when there are disagreements. Costs another round; a
  changed specification needs a full pass.
- **S** — stop with confirmation. No acceptance is issued and the used round is
  not returned.
- **L** — hand the report to the lead for a spec edit and re-check.
- **D** — hand a dispute decision or question to the lead. This does not lift
  critical findings or the barrier.
- **Esc** — close the panel **without cancelling**. `/spec-review` reopens it.
  Brief progress remains above the editor and in the status line.

The panel shows each reviewer's status as its process finishes; the model's
token stream is not printed. While a run is in the background, switching,
branching and navigating the session tree are blocked. Ending the session
cancels the running processes. A custom set is kept in the current session
state and is not written to the shared presets file.

You can point at a file directly: `/spec-review /absolute/path/to/spec.md` or
`/spec-review "docs/my spec.md"`. The wizard opens with that specification
already selected, without asking for the path again. Arguments are not parsed
as a shell command: everything after the command is one path; JSON is detected
only by a leading `{`.

## JSON arguments

```text
/spec-review {"spec":"docs/spec.md","preset":"deep","rounds":3,"minimum":2,"context":["src/types.ts"]}
```

`rounds` is required on every run. Range 1–20. One round is an independent pass
plus, when there are findings, a discussion. At most eight reviewers.
`minimum` is the minimum number of reviewers that finished successfully; a
process error, a timeout or invalid JSON does not count as success. Any
successful negative review blocks acceptance, even if the positive minimum has
already been reached.

`reviewers` may be passed in the command JSON to override the saved set.
`context` is a list of text files. `repository:true` allows looking at the
repository and defaults to `false`: processes run in the artifacts directory
and receive only the specification text and the selected files. Context and
specification are each limited to 512 KiB.

Every reviewer works through the same checklist: requirement completeness,
contradictions, implementability, security, task boundaries, acceptance
criteria, implementation order, tests. When there are findings, the successful
reviewers receive all independent reviews and issue updated verdicts. The lead
sees both passes, edits the specification and calls `spec_review_round` again.
Unresolved critical disagreements go to the human; hitting the limit is not
approval.

The report and a snapshot of the specification are saved next to it:

```text
spec.md.reviews/<run-id>/
  spec.md
  independent.json
  <reviewer>-independent.txt
  <reviewer>-discussion.txt
  report.json
```

Acceptance is bound to the SHA-256 of the exact specification content. Any edit
voids it. Changes to context files do not void acceptance — the chosen
behaviour of the first version.

## Automatic barrier

Add `"autoSpec":"docs/spec.md"` at the top level of `.pi/spec-review.json` to
arm the barrier when pi starts. After a manual command it is armed as well.
Without `autoSpec` or a manual run the barrier is inert: there is no automatic
spec discovery and no detection of an intent to "start implementing".

Before acceptance, reading, asking the user and editing the specification
itself are allowed. Shell and unknown tools are blocked: they can change code.
The lead is told to run the review; if the parameters are not set yet, a
command with a round limit is required. The edit loop is driven by the lead
agent, not by a separate autonomous daemon.

Explicit bypass:

```text
/spec-review-bypass reason
```

Requires confirmation through the UI, records the reason in session state and
applies only to the current hash. Bypass is not allowed in headless mode.

## Security limits and checks

The barrier restricts pi tool calls. It is not an OS sandbox and not protection
against a malicious agent. The user's shell and other processes are
unrestricted. State and report files are not signed. Pi reviewers get only
read-only tools with no extensions/MCP; Codex runs in a read-only sandbox;
Claude gets a limited tool list. The behaviour of any CLI and of local policies
depends on the installed version. Full filesystem isolation and a guaranteed
absence of third-party hooks are not claimed.

The process timeout is 180 seconds; combined stdout/stderr is capped at 2 MiB.
Cancellation kills the process group on POSIX. Failed runs are recorded in the
report; there is no automatic failover to another CLI.

```bash
npm test
```

The tests use Node.js 22+, an installed pi and a stub CLI — no paid model
calls. For a non-standard install, point `PI_TEST_HOST` at the
`@earendil-works/pi-coding-agent` package. Covered: loading by a real pi, the
independent pass and discussion, acceptance, invalidation, round limit, state
recovery, validation, errors, cancellation and timeout. A UI test that
simulates keyboard input covers setup, background run, closing without
cancelling, progress, reading reviews, retrying only the failed reviewers,
handing over to the lead and stopping. Live model calls and visual rendering in
a real terminal are not verified yet.
