/**
 * /run — detect and launch the current project's server.
 *
 *   /run                  detect the launch recipe and start it
 *   /run <command...>     start an arbitrary command instead
 *   /run --pane [cmd...]  start in a herdr tab instead of a managed process
 *   /run status           state, url, pid/tab, uptime
 *   /run logs [n]         scrollable tail of captured output
 *   /run stop             stop the server
 *   /run restart          stop, then start the same command again
 *   /run help             usage
 *
 * Managed mode (default) spawns a detached process group, captures output into
 * a ring buffer, mirrors it into the footer/status widget, and kills the whole
 * group on session shutdown.
 *
 * Pane mode opens a real herdr tab that outlives this session. Requires
 * HERDR_ENV=1; falls back to managed mode with a warning otherwise.
 *
 * Before spawning, the recipe's binary is checked against PATH. A missing
 * toolchain is otherwise only visible as an opaque exit-127 notification.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

const RING_SIZE = 500;
const TAIL_LINES = 6;
const STOP_GRACE_MS = 5_000;
const PANE_POLL_MS = 5_000;
const URL_PROBE_MS = 2_500;
const PANE_READ_LINES = 200;

// ---------------------------------------------------------------------------
// Recipe detection
// ---------------------------------------------------------------------------

export interface Recipe {
	command: string;
	source: string;
}

/** Script names tried in this order; first hit wins. */
const SCRIPT_ORDER = ["dev", "start", "serve", "develop", "watch"];

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

export function detectPackageManager(cwd: string): string {
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
	return "npm";
}

function packageRecipes(cwd: string): Recipe[] {
	const raw = readText(join(cwd, "package.json"));
	if (!raw) return [];
	let scripts: Record<string, string>;
	try {
		scripts = (JSON.parse(raw) as { scripts?: Record<string, string> }).scripts ?? {};
	} catch {
		return [];
	}

	const pm = detectPackageManager(cwd);
	const names = SCRIPT_ORDER.filter((name) => scripts[name]);
	// Fall back to derived names (dev:web, start:api, …) when nothing exact matched.
	if (names.length === 0) {
		const derived = Object.keys(scripts)
			.filter((name) => /^(dev|start|serve)(:|$)/.test(name))
			.sort();
		names.push(...derived.slice(0, 3));
	}

	return names.map((name) => ({
		command: `${pm} run ${name}`,
		source: `package.json → scripts.${name}`,
	}));
}

function makefileRecipes(cwd: string): Recipe[] {
	const raw = readText(join(cwd, "Makefile"));
	if (!raw) return [];
	const targets = new Set<string>();
	for (const line of raw.split("\n")) {
		const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
		if (match) targets.add(match[1]);
	}
	return ["dev", "run", "serve"]
		.filter((target) => targets.has(target))
		.map((target) => ({ command: `make ${target}`, source: `Makefile → ${target}` }));
}

function procfileRecipes(cwd: string): Recipe[] {
	const raw = readText(join(cwd, "Procfile"));
	if (!raw) return [];
	for (const line of raw.split("\n")) {
		const match = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/.exec(line);
		if (match) return [{ command: match[2], source: `Procfile → ${match[1]}` }];
	}
	return [];
}

function composeRecipes(cwd: string): Recipe[] {
	for (const file of ["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]) {
		if (existsSync(join(cwd, file))) {
			return [{ command: "docker compose up", source: file }];
		}
	}
	return [];
}

/** Ordered launch candidates for a project directory. */
export function detectRecipes(cwd: string): Recipe[] {
	return [...packageRecipes(cwd), ...makefileRecipes(cwd), ...procfileRecipes(cwd), ...composeRecipes(cwd)];
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Shell syntax that makes the first token unreliable as a binary name:
 * pipelines, redirects, substitution, chaining, quoting.
 */
const SHELL_META = /[|&;<>()$`"']/;

/** Shell builtins are never binaries, so they must not be gated on. */
const SHELL_BUILTINS = new Set([
	"cd", "echo", "printf", "export", "source", ".", "set", "unset", "eval", "exec",
	"alias", "unalias", "umask", "wait", "read", "exit", "return", "shift", "trap",
	"true", "false", "test", "[", ":", "type", "command", "builtin", "pwd",
]);

const INSTALL_HINTS: Record<string, string> = {
	npm: "ships with Node.js — install Node (brew install node, or nvm/fnm)",
	npx: "ships with Node.js — install Node (brew install node, or nvm/fnm)",
	pnpm: "brew install pnpm   (or: corepack enable pnpm)",
	yarn: "brew install yarn   (or: corepack enable yarn)",
	bun: "brew install oven-sh/bun/bun",
	make: "xcode-select --install   (make ships with the Command Line Tools)",
	docker: "install Docker Desktop — it provides both `docker` and `docker compose`",
};

/**
 * The binary a command will invoke, or undefined when that cannot be told
 * confidently. Undefined means "do not gate this": a false block would be
 * worse than the confusing error it replaces.
 */
export function requiredBinary(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed || SHELL_META.test(trimmed)) return undefined;

	const tokens = trimmed.split(/\s+/);
	let index = 0;
	// Skip `sudo` and leading VAR=value assignments.
	while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]) || tokens[index] === "sudo")) {
		index++;
	}
	const head = tokens[index];
	if (!head) return undefined;
	if (SHELL_BUILTINS.has(head)) return undefined;
	return head;
}

/** Resolve an executable the way the shell will, without spawning a shell. */
export function findBinary(name: string, pathValue: string = process.env.PATH ?? ""): string | undefined {
	if (name.includes("/")) return existsSync(name) ? name : undefined;

	for (const dir of pathValue.split(":")) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			// statSync follows symlinks, and X_OK succeeds on any searchable
			// directory — without the isFile check, a directory that happens to
			// share a binary's name (e.g. a Python package named `docker`) is
			// mistaken for an executable.
			if (!statSync(candidate).isFile()) continue;
			accessSync(candidate, fsConstants.X_OK);
			return candidate;
		} catch {
			// Not in this directory, or not runnable.
		}
	}
	return undefined;
}

function missingBinaryMessage(binary: string, command: string): string {
	const hint = INSTALL_HINTS[binary] ?? `Install ${binary}, then run /run again.`;
	return `${binary} is not installed — not starting:\n  ${command}\n\n${hint}`;
}

/** Pull a browsable local URL out of a server's log output. */
export function extractUrl(text: string): string | undefined {
	const full = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s"'`)\]|]*/.exec(text);
	if (full) return full[0].replace(/[.,;]+$/, "");

	const local = /\b(?:localhost|127\.0\.0\.1):(\d{2,5})\b/.exec(text);
	if (local) return `http://localhost:${local[1]}`;

	const named = /\b(?:listening on|running at|server started|available at|port)\D{0,12}(\d{2,5})\b/i.exec(text);
	if (named) return `http://localhost:${named[1]}`;

	return undefined;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RunState {
	mode: "managed" | "pane";
	command: string;
	source: string;
	startedAt: number;
	lines: string[];
	child?: ChildProcess;
	pid?: number;
	tabId?: string;
	paneId?: string;
	port?: number;
	url?: string;
	exit?: { code: number | null; signal: string | null };
	stopping?: boolean;
	lastPaint?: number;
	urlProbe?: NodeJS.Timeout;
	panePoll?: NodeJS.Timeout;
	panePrev?: string;
}

let state: RunState | null = null;

function stamp(): string {
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pushLines(target: RunState, incoming: string): void {
	for (const line of incoming.split("\n")) {
		if (!line.trim()) continue;
		target.lines.push(`[${stamp()}] ${line.replace(/\s+$/, "")}`);
	}
	if (target.lines.length > RING_SIZE) target.lines.splice(0, target.lines.length - RING_SIZE);
}

function noteUrl(target: RunState, text: string): void {
	if (target.url) return;
	const url = extractUrl(text);
	if (!url) return;
	target.url = url;
	const port = Number(/:(\d{2,5})/.exec(url)?.[1]);
	if (Number.isFinite(port)) target.port = port;
}

function uptime(target: RunState): string {
	const seconds = Math.max(0, Math.round((Date.now() - target.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
}

function isRunning(target: RunState | null): target is RunState {
	return Boolean(target && !target.exit && !target.stopping);
}

function summary(target: RunState): string {
	const parts = [target.command];
	if (target.exit) {
		parts.push(`exited ${target.exit.code ?? target.exit.signal ?? "?"}`);
	} else {
		parts.push(uptime(target));
	}
	if (target.url) parts.push(target.url);
	if (target.pid) parts.push(`pid ${target.pid}`);
	if (target.tabId) parts.push(`tab ${target.tabId}`);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function paint(ctx: ExtensionCommandContext, target: RunState | null = state, force = false): void {
	if (!ctx.hasUI) return;
	if (!target) {
		ctx.ui.setStatus("run", undefined);
		ctx.ui.setWidget("run", undefined);
		return;
	}

	// Throttle the live widget so chatty servers don't thrash the TUI.
	const now = Date.now();
	if (!force && target.lastPaint && now - target.lastPaint < 250) return;
	target.lastPaint = now;

	const marker = target.exit ? "■" : "▶";
	const head = `${marker} ${target.command}${target.url ? ` · ${target.url}` : ""}${
		target.exit ? ` — exited ${target.exit.code ?? target.exit.signal ?? "?"}` : ""
	}`;
	const tail = target.lines.slice(-TAIL_LINES).map((line) => `  ${line}`);

	ctx.ui.setStatus("run", isRunning(target) ? `${marker} ${target.command}${target.url ? ` · ${target.url}` : ""}` : undefined);
	ctx.ui.setWidget("run", [head, ...tail]);
}

async function showLogs(ctx: ExtensionCommandContext, count: number): Promise<void> {
	if (!state || state.lines.length === 0) {
		ctx.ui.notify("No output captured yet.", "info");
		return;
	}
	const lines = state.lines.slice(-count);
	await ctx.ui.select(`${state.command} — last ${lines.length} lines (${state.exit ? "stopped" : "running"})`, lines);
}

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

function killGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			/* already gone */
		}
	}
}

async function stopManaged(target: RunState): Promise<void> {
	const pid = target.pid;
	if (!pid) return;
	target.stopping = true;
	killGroup(pid, "SIGTERM");
	await new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS));
	if (target.exit) return;
	killGroup(pid, "SIGKILL");
}

async function stopPane(target: RunState): Promise<void> {
	if (!target.tabId) return;
	target.stopping = true;
	try {
		await execFileAsync("herdr", ["tab", "close", target.tabId]);
	} catch {
		/* tab already gone */
	}
	if (!target.exit) target.exit = { code: 0, signal: null };
}

async function stop(target: RunState): Promise<void> {
	if (target.mode === "pane") await stopPane(target);
	else await stopManaged(target);
	if (target.urlProbe) clearTimeout(target.urlProbe);
	if (target.panePoll) clearInterval(target.panePoll);
	target.urlProbe = undefined;
	target.panePoll = undefined;
}

async function probeWithLsof(target: RunState): Promise<void> {
	const pid = target.pid;
	if (!pid || target.url || target.exit) return;
	for (const flag of ["-g", "-p"]) {
		try {
			const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", flag, String(pid)]);
			const ports = [...stdout.matchAll(/[:.](\d{2,5})\s+\(LISTEN\)/g)].map((match) => Number(match[1]));
			const port = [...new Set(ports)].filter((value) => value > 0).sort((a, b) => a - b)[0];
			if (port) {
				target.port = port;
				target.url = `http://localhost:${port}`;
				return;
			}
		} catch {
			/* lsof missing or nothing listening */
		}
	}
}

function attachManaged(target: RunState, ctx: ExtensionCommandContext): void {
	const child = target.child;
	if (!child) return;
	target.pid = child.pid;

	child.stdout?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		pushLines(target, text);
		noteUrl(target, text);
		paint(ctx, target);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		const text = chunk.toString();
		pushLines(target, text);
		noteUrl(target, text);
		paint(ctx, target);
	});

	child.on("error", (error) => {
		pushLines(target, `spawn failed: ${error.message}`);
	});

	child.on("close", (code, signal) => {
		if (target.exit) return;
		target.exit = { code, signal };
		if (target.urlProbe) clearTimeout(target.urlProbe);
		if (target.stopping) {
			paint(ctx, target, true);
			return;
		}
		paint(ctx, target, true);
		const tail = target.lines.slice(-5).join("\n");
		ctx.ui.notify(
			`${target.command} exited (${code ?? signal ?? "?"})\n${tail}`,
			code === 0 ? "info" : "error",
		);
	});
}

function startManaged(cwd: string, command: string, source: string, ctx: ExtensionCommandContext): RunState {
	const child = spawn(command, {
		cwd,
		shell: true,
		detached: true, // own process group, so we can signal the whole tree
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, FORCE_COLOR: "1" },
	});

	const target: RunState = {
		mode: "managed",
		command,
		source,
		startedAt: Date.now(),
		lines: [],
		child,
	};
	attachManaged(target, ctx);
	target.urlProbe = setTimeout(() => void probeWithLsof(target), URL_PROBE_MS);
	// Timers must not hold the event loop open.
	target.urlProbe.unref?.();
	return target;
}

async function startPane(cwd: string, command: string, source: string, ctx: ExtensionCommandContext): Promise<RunState> {
	const args = ["tab", "create", "--cwd", cwd, "--label", `${basename(cwd)} · run`, "--no-focus"];
	const workspace = process.env.HERDR_WORKSPACE_ID;
	if (workspace) args.splice(2, 0, "--workspace", workspace);

	const { stdout } = await execFileAsync("herdr", args);
	let payload: { result?: { root_pane?: { pane_id?: string }; tab?: { tab_id?: string } } };
	try {
		payload = JSON.parse(stdout);
	} catch {
		throw new Error(`could not parse herdr output: ${stdout.slice(0, 160)}`);
	}

	const paneId = payload.result?.root_pane?.pane_id;
	const tabId = payload.result?.tab?.tab_id;
	if (!paneId || !tabId) throw new Error(`herdr returned no pane for the new tab`);

	await execFileAsync("herdr", ["pane", "run", paneId, command]);

	const target: RunState = {
		mode: "pane",
		command,
		source,
		startedAt: Date.now(),
		lines: [],
		paneId,
		tabId,
	};

	const poll = async () => {
		if (target.exit) return;
		try {
			const { stdout: text } = await execFileAsync("herdr", [
				"pane",
				"read",
				paneId,
				"--source",
				"recent-unwrapped",
				"--lines",
				String(PANE_READ_LINES),
			]);
			const fresh = newPaneText(target.panePrev ?? "", text);
			target.panePrev = fresh.prev;
			if (fresh.appended.length > 0) {
				pushLines(target, fresh.appended.join("\n"));
				noteUrl(target, fresh.appended.join("\n"));
				paint(ctx, target);
			}
		} catch {
			// Pane is gone: the server was stopped by hand from the herdr UI.
			target.exit = { code: null, signal: "closed" };
			if (target.panePoll) clearInterval(target.panePoll);
			target.panePoll = undefined;
			paint(ctx, target, true);
			ctx.ui.notify(`${target.command} — herdr tab ${target.tabId} closed`, "info");
		}
	};

	target.panePoll = setInterval(() => void poll(), PANE_POLL_MS);
	target.panePoll.unref?.();
	setTimeout(() => void poll(), 1_500);
	return target;
}

/** Lines present in `next` but not in `prev`, tolerating a scrollback window. */
export function newPaneText(prev: string, next: string): { appended: string[]; prev: string } {
	if (next === prev) return { appended: [], prev };
	if (next.startsWith(prev)) {
		return { appended: next.slice(prev.length).split("\n").filter((line) => line.trim()), prev: next };
	}
	const seen = new Set(prev.split("\n").slice(-PANE_READ_LINES));
	const appended = next
		.split("\n")
		.filter((line) => line.trim() && !seen.has(line));
	return { appended, prev: next };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const HELP = [
	"/run                    detect the launch recipe and start it",
	"/run <command…>         start an arbitrary command",
	"/run --pane [command…]  start in a herdr tab (outlives this session)",
	"/run status             state, url, pid/tab, uptime",
	"/run logs [n]           scrollable tail of captured output (default 60)",
	"/run stop               stop the server",
	"/run restart            stop, then start the same command again",
	"/run help               this list",
];

const SUBCOMMANDS = ["status", "logs", "stop", "restart", "help"];

interface Parsed {
	sub?: string;
	rest: string;
	pane: boolean;
}

function parseArgs(raw: string): Parsed {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	let pane = false;
	if (tokens[0] === "--pane") {
		pane = true;
		tokens.shift();
	}
	if (tokens[0] === "--") tokens.shift();
	if (tokens.length > 0 && SUBCOMMANDS.includes(tokens[0])) {
		return { sub: tokens[0], rest: tokens.slice(1).join(" "), pane };
	}
	return { rest: tokens.join(" "), pane };
}

export default function runExtension(pi: ExtensionAPI) {
	pi.registerCommand("run", {
		description: "Launch the current project's server (auto-detected, or an explicit command)",
		getArgumentCompletions: (prefix) => {
			const items = [
				...SUBCOMMANDS.map((name) => ({ value: name, label: name })),
				{ value: "--pane", label: "--pane  run in a herdr tab" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (raw, ctx) => {
			const { sub, rest, pane } = parseArgs(raw);
			const cwd = ctx.cwd;

			if (sub === "help") {
				await ctx.ui.select("pi /run", HELP);
				return;
			}

			if (sub === "status") {
				if (!state) ctx.ui.notify("Nothing has been started in this session.", "info");
				else ctx.ui.notify(`${state.exit ? "■" : "▶"} ${summary(state)} · ${state.source}`, state.exit ? "warning" : "info");
				return;
			}

			if (sub === "logs") {
				const count = Number.parseInt(rest, 10);
				await showLogs(ctx, Number.isFinite(count) && count > 0 ? Math.min(count, RING_SIZE) : 60);
				return;
			}

			if (sub === "stop") {
				if (!state || state.exit) {
					ctx.ui.notify("Nothing is running.", "info");
					return;
				}
				await stop(state);
				paint(ctx, state, true);
				ctx.ui.notify(`Stopped ${state.command}`, "info");
				return;
			}

			if (sub === "restart") {
				if (!state) {
					ctx.ui.notify("Nothing to restart — use /run first.", "warning");
					return;
				}
				const { command, source, mode } = state;
				await stop(state);
				paint(ctx, null, true);
				state = null;
				await launch(command, source, mode === "pane", ctx);
				return;
			}

			// ---- start -------------------------------------------------------
			if (isRunning(state)) {
				const restart = await ctx.ui.confirm(
					"Already running",
					`${state.command} is already running (${summary(state)}).\n\nRestart it?`,
				);
				if (!restart) {
					ctx.ui.notify(`${state.url ?? summary(state)}`, "info");
					return;
				}
				await stop(state);
				state = null;
			}

			if (rest) {
				await launch(rest, "explicit command", pane, ctx);
				return;
			}

			const recipes = detectRecipes(cwd);
			if (recipes.length === 0) {
				ctx.ui.notify(
					`No launch recipe found in ${basename(cwd)} (looked at package.json, Makefile, Procfile, docker-compose).\n\nStart something explicitly: /run <command>`,
					"warning",
				);
				return;
			}

			let recipe = recipes[0];
			if (recipes.length > 1) {
				const labels = recipes.map((item, index) => `${index === 0 ? "▸ " : "  "}${item.command}    (${item.source})`);
				const choice = await ctx.ui.select("Which command should /run start?", labels);
				if (!choice) return;
				const index = labels.indexOf(choice);
				if (index >= 0) recipe = recipes[index];
			}

			await launch(recipe.command, recipe.source, pane, ctx);
		},
	});

	async function launch(command: string, source: string, inPane: boolean, ctx: ExtensionCommandContext): Promise<void> {
		const wantsPane = inPane && (ctx.mode === "tui" || ctx.mode === "rpc");
		if (inPane && process.env.HERDR_ENV !== "1") {
			ctx.ui.notify("Not inside herdr (HERDR_ENV != 1) — starting as a managed process instead.", "warning");
		}

		// The child is spawned with `{...process.env}`, so the PATH consulted here
		// is exactly the one the shell will resolve this command against.
		const binary = requiredBinary(command);
		if (binary && !findBinary(binary)) {
			ctx.ui.notify(missingBinaryMessage(binary, command), "error");
			return;
		}

		try {
			state = wantsPane && process.env.HERDR_ENV === "1"
				? await startPane(ctx.cwd, command, source, ctx)
				: startManaged(ctx.cwd, command, source, ctx);
		} catch (error) {
			ctx.ui.notify(`Could not start ${command}: ${(error as Error).message}`, "error");
			return;
		}

		paint(ctx, state, true);
		const where = state.mode === "pane" ? `herdr tab ${state.tabId}` : `pid ${state.pid}`;
		ctx.ui.notify(`▶ ${command}  (${where})\n${source}`, "info");
	}

	// Tear down only what we own. Pane tabs deliberately outlive the session.
	pi.on("session_shutdown", async () => {
		const target = state;
		if (!target) return;
		if (target.urlProbe) clearTimeout(target.urlProbe);
		if (target.panePoll) clearInterval(target.panePoll);
		if (target.mode === "managed" && target.pid && !target.exit) {
			killGroup(target.pid, "SIGTERM");
			setTimeout(() => killGroup(target.pid as number, "SIGKILL"), 1_500).unref?.();
		}
		state = null;
	});

	// Keep a stale "running" footer from outliving a process we no longer track.
	pi.on("session_start", async (_event, ctx) => {
		if (!state) {
			ctx.ui.setStatus("run", undefined);
			ctx.ui.setWidget("run", undefined);
		}
	});
}
