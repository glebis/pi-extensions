/**
 * Minimal JSON-RPC client for cenno's MCP stdio bridge.
 *
 * Spawns `cenno --mcp-stdio` per tool call, makes sure the app is running
 * first (launches `cenno --tray` and waits for its MCP socket on cold start),
 * and ALWAYS tears the bridge process down afterwards — no orphaned
 * `--mcp-stdio` processes.
 *
 * Binary location can be overridden with the CENNO_BIN environment variable.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

export const CENNO_BIN = process.env.CENNO_BIN ?? "/Applications/cenno.app/Contents/MacOS/cenno";

const SOCKET_PATH = join(homedir(), "Library", "Application Support", "app.cenno", "mcp.sock");
const LAUNCH_WAIT_MS = 10_000;

export function cennoBinaryAvailable(): boolean {
  try {
    accessSync(CENNO_BIN, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** cenno reads ~/.cenno at launch; the socket appears once the app is up. */
async function ensureAppRunning(signal?: AbortSignal): Promise<void> {
  if (existsSync(SOCKET_PATH)) return;
  const launcher = spawn(CENNO_BIN, ["--tray"], { stdio: "ignore", detached: true });
  launcher.unref();
  const deadline = Date.now() + LAUNCH_WAIT_MS;
  while (!existsSync(SOCKET_PATH)) {
    if (signal?.aborted) throw new Error("aborted");
    if (Date.now() > deadline) {
      throw new Error(`cenno did not create ${SOCKET_PATH} within ${LAUNCH_WAIT_MS / 1000}s — is cenno installed at ${CENNO_BIN}?`);
    }
    await sleep(200);
  }
  await sleep(300); // let the socket accept connections
}

function killBridge(child: ChildProcess): void {
  try {
    child.stdin?.end();
  } catch {
    /* ignore */
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  const reaper = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }, 500);
  reaper.unref?.();
}

export interface CennoCallOptions {
  signal?: AbortSignal;
  /** Overall budget for the whole bridge round-trip, in ms. */
  timeoutMs: number;
}

export async function cennoToolCall(
  toolName: string,
  args: Record<string, unknown>,
  options: CennoCallOptions,
): Promise<string> {
  await ensureAppRunning(options.signal);

  const child = spawn(CENNO_BIN, ["--mcp-stdio"], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr?.on("data", () => {}); // drain so the pipe never backs up

  const deadline = Date.now() + options.timeoutMs;
  const waiters = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const failAll = () => {
    const reason =
      options.signal?.aborted
        ? new Error("aborted")
        : bridgeError ?? new Error("cenno bridge exited before responding");
    for (const w of waiters.values()) w.reject(reason);
    waiters.clear();
  };
  let bridgeError: Error | null = null;
  child.once("error", (err) => {
    bridgeError = new Error(`failed to launch cenno bridge (${CENNO_BIN}): ${err.message}`);
    failAll();
  });

  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // ignore non-JSON noise on stdout
    }
    const waiter = typeof msg?.id === "number" ? waiters.get(msg.id) : undefined;
    if (!waiter) return;
    waiters.delete(msg.id);
    if (msg.error) {
      const e = msg.error;
      waiter.reject(new Error(typeof e === "string" ? e : (e?.message ?? JSON.stringify(e))));
    } else {
      waiter.resolve(msg.result);
    }
  });
  child.on("close", failAll);
  rl.on("close", failAll);

  const onAbort = () => killBridge(child);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    let nextId = 1;
    const callWithId = (id: number, method: string, params: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        if (bridgeError) {
          reject(bridgeError);
          return;
        }
        if (options.signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        if (deadline <= Date.now()) {
          reject(new Error(`cenno call exceeded its ${Math.round(options.timeoutMs / 1000)}s budget before ${method} was sent`));
          return;
        }
        const entry = { resolve, reject };
        waiters.set(id, entry);
        const timer = setTimeout(() => {
          if (waiters.delete(id)) {
            reject(new Error(`cenno did not respond to ${method} within ${Math.round(options.timeoutMs / 1000)}s budget`));
          }
        }, Math.max(1_000, deadline - Date.now()));
        timer.unref?.();
        child.stdin!.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n",
          (err) => {
            if (err && waiters.delete(id)) reject(new Error(`failed to write to cenno bridge: ${err.message}`));
          },
        );
      });

    await callWithId(nextId++, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "pi-cenno-extension", version: "1.0.0" },
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const result = await callWithId(nextId++, "tools/call", { name: toolName, arguments: args });

    if (result?.isError) {
      const text = (result?.content ?? [])
        .map((c: any) => (c?.type === "text" ? c.text : ""))
        .join("\n")
        .trim();
      throw new Error(text || "cenno returned a tool error");
    }
    const text = (result?.content ?? [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("cenno returned an empty response");
    return text;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    killBridge(child);
  }
}