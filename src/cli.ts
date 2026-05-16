#!/usr/bin/env node
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectUpstream, resolvePort, type ProxyConfig } from "./config.js";
import { launchClaude } from "./launcher.js";
import { startProxy } from "./proxy.js";
import { patchCCSettings, restoreCCSettings, selfHeal } from "./settings.js";
import {
  deleteState,
  deregisterWrapperLocked,
  initDaemonStateLocked,
  isPidAlive,
  pruneDeadWrappersLocked,
  readState,
  registerWrapperLocked,
  withStateLock,
  writeStateAtomicLocked,
  type DaemonState,
} from "./state.js";

const DAEMON_LOG_PATH = join(homedir(), ".claude", ".cc-thinkfix-daemon.log");

const HELP = `cc-thinkfix — transparent proxy that fixes Anthropic thinking blocks

Usage:
  cc-thinkfix claude [args...]      Launch Claude Code through cc-thinkfix
  cc-thinkfix serve [--port <n>]    Run a foreground proxy (no settings patch)
  cc-thinkfix --version
  cc-thinkfix --help

How 'cc-thinkfix claude' works:
  - Reuses (or spawns, if absent) a single background daemon process that
    listens on a free random port and patches ~/.claude/settings.json to
    point at it.
  - Multiple 'cc-thinkfix claude' invocations share the same daemon.
  - The daemon shuts itself down (restoring settings.json) when the last
    Claude Code wrapper exits.

How 'cc-thinkfix serve' works:
  - Standalone foreground proxy. Does NOT patch settings.json.
  - Default port 28080 (override with --port or CC_THINKFIX_PORT).
  - Point your client at http://127.0.0.1:<port>/ manually.
`;

async function main() {
  // Recover from a prior unclean exit before doing anything that reads state.
  // selfHeal preserves an alive daemon's patch (checked via sidecar pid).
  if (selfHeal()) {
    console.log("[cc-thinkfix] recovered ~/.claude/settings.json from prior unclean exit");
  }

  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    const pkg = (await import("../package.json", { with: { type: "json" } })).default;
    console.log(pkg.version);
    process.exit(0);
  }

  if (args.length === 0) {
    console.log(HELP);
    process.exit(2);
  }

  const command = args[0];

  if (command === "serve") {
    const portIdx = args.indexOf("--port");
    const port = portIdx !== -1 ? Number(args[portIdx + 1]) : undefined;
    const logIdx = args.indexOf("--log-level");
    const logLevel = logIdx !== -1 ? (args[logIdx + 1] as ProxyConfig["logLevel"]) : "info";
    await serveCommand({ port, logLevel });
    return;
  }

  if (command === "__daemon") {
    await daemonCommand();
    return;
  }

  if (command === "claude") {
    const claudeArgs = args.slice(1);
    await claudeCommand(claudeArgs);
    return;
  }

  console.error(`unknown command: ${command}`);
  console.log(HELP);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// `serve` — foreground proxy, no state file, no settings patch.
// ---------------------------------------------------------------------------

async function serveCommand(opts: { port?: number; logLevel?: ProxyConfig["logLevel"] }) {
  const config = detectUpstream();
  config.port = resolvePort(opts.port);
  config.logLevel = opts.logLevel;
  try {
    const { close } = await startProxy(config);
    const shutdown = async (sig: string) => {
      console.log(`\n${sig} received, shutting down`);
      await close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      const already = await pingExistingProxy(config.port);
      console.error(
        already
          ? `[cc-thinkfix] another cc-thinkfix is already listening on port ${config.port}.\n` +
              "  Nothing to do — point your client at it directly."
          : `[cc-thinkfix] port ${config.port} is occupied by something else.\n` +
              "  Free the port, or run with --port <N> / CC_THINKFIX_PORT=N.",
      );
      process.exit(1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// `__daemon` — detached background proxy spawned by `cc-thinkfix claude`.
// Picks a random free port, writes state file, patches settings.json,
// auto-shuts-down when the last wrapper deregisters.
// ---------------------------------------------------------------------------

async function daemonCommand() {
  const config = detectUpstream();
  // port: 0 lets the OS pick a free port.
  const handle = await startProxy({
    ...config,
    port: 0,
    logLevel: "info",
    onShutdownRequest: async () => {
      // The HTTP /__shutdown handler hits this; the actual cleanup is
      // shared with the SIGTERM path below.
      await daemonCleanup();
    },
  });

  const actualPort = handle.port;

  const originalUrl = patchCCSettings(actualPort);
  if (originalUrl) {
    console.log(`[daemon] patched ~/.claude/settings.json → http://127.0.0.1:${actualPort}`);
  }

  await withStateLock(() => {
    initDaemonStateLocked(actualPort);
  });
  console.log(`[daemon] state written: pid=${process.pid} port=${actualPort}`);

  // Periodic prune of dead wrappers. If the count drops to 0 (e.g. because
  // wrappers were killed -9 before they could deregister), shut ourselves down.
  const pruneTimer = setInterval(() => {
    void (async () => {
      try {
        const remaining = await withStateLock(() => pruneDeadWrappersLocked());
        if (remaining === 0) {
          // Give a small grace window so a wrapper that just started doesn't
          // get its proxy yanked between spawn and register.
          const state = readState();
          const sinceStart = state ? Date.now() - new Date(state.startedAt).getTime() : Infinity;
          if (sinceStart > 30_000) {
            console.log("[daemon] no wrappers left, shutting down");
            await daemonCleanup();
            await handle.close();
          }
        }
      } catch (err) {
        console.error("[daemon] prune timer error:", err);
      }
    })();
  }, 10_000);

  let cleanedUp = false;
  async function daemonCleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(pruneTimer);
    try {
      restoreCCSettings(originalUrl);
      if (originalUrl) console.log("[daemon] restored ~/.claude/settings.json");
    } catch (err) {
      console.error("[daemon] restore failed:", err);
    }
    try {
      deleteState();
    } catch {
      // ignore
    }
  }

  const sigShutdown = async (sig: string) => {
    console.log(`[daemon] ${sig} received, shutting down`);
    await daemonCleanup();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void sigShutdown("SIGINT"));
  process.on("SIGTERM", () => void sigShutdown("SIGTERM"));

  // Best-effort sync cleanup for exit paths the async handlers can't catch.
  process.on("exit", () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      restoreCCSettings(originalUrl);
    } catch {
      // ignore
    }
    try {
      deleteState();
    } catch {
      // ignore
    }
  });

  // Stay alive until the proxy server closes. After that, process exits.
  await handle.closed;
}

// ---------------------------------------------------------------------------
// `claude` — the user-facing wrapper. Ensures a daemon is up, registers self,
// launches claude, deregisters on exit.
// ---------------------------------------------------------------------------

async function claudeCommand(claudeArgs: string[]) {
  // 1. Make sure a daemon is up and get its port.
  const { port } = await ensureDaemon();

  // 2. Register ourselves with the daemon's state file so the daemon knows
  //    not to shut down while we're still running.
  await withStateLock(() => {
    const n = registerWrapperLocked(process.pid);
    if (n === null) {
      console.error("[cc-thinkfix] daemon disappeared between health-check and register; aborting");
      process.exit(1);
    }
    return n;
  });

  // 3. Launch claude with ANTHROPIC_BASE_URL injected (proxy port from daemon).
  const child = launchClaude(port, claudeArgs);

  let cleanedUp = false;

  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    let remaining: number | null = null;
    try {
      remaining = await withStateLock(() => deregisterWrapperLocked(process.pid));
    } catch (err) {
      console.error("[cc-thinkfix] failed to deregister wrapper:", err);
    }
    if (remaining === 0) {
      // We were the last wrapper. Ask the daemon to shut down gracefully.
      const state = readState();
      const targetPort = state?.port ?? port;
      try {
        await fetch(`http://127.0.0.1:${targetPort}/__shutdown`, { method: "POST" });
      } catch {
        // Daemon may already be down — that's fine.
      }
    }
  };

  const cleanupSync = () => {
    // Synchronous best-effort. Can't trigger /__shutdown HTTP here, but we
    // can still try to deregister so the daemon's periodic prune notices.
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      // We can't take the lock asynchronously here, so do an unlocked write.
      // The daemon's prune timer will fix up any inconsistency within 10s.
      const state = readState();
      if (state) {
        state.wrappers = state.wrappers.filter((w) => w.wrapperPid !== process.pid);
        // Note: writeStateAtomic is internal; using state lock would be async.
        // We rely on the daemon's periodic prune to clean up if this fails.
      }
    } catch {
      // ignore
    }
  };

  child.on("exit", async (code) => {
    await cleanup();
    process.exit(code ?? 0);
  });

  child.on("error", async (err) => {
    console.error("[cc-thinkfix] failed to launch claude:", err.message);
    await cleanup();
    process.exit(1);
  });

  process.on("uncaughtException", (err) => {
    console.error("[cc-thinkfix] uncaught:", err);
    cleanupSync();
    process.exit(1);
  });
  process.on("exit", cleanupSync);
}

// ---------------------------------------------------------------------------
// Daemon discovery / spawn.
// ---------------------------------------------------------------------------

async function ensureDaemon(): Promise<{ daemonPid: number; port: number }> {
  // Loop until we either find a healthy daemon, become the spawner, or fail.
  // CRITICAL: the state-file lock is held only for tiny decision moments.
  // The actual daemon spawn + wait happens OUTSIDE the lock so the daemon
  // itself can take the lock to write its initial state.
  while (true) {
    type Decision = "reuse" | "spawn" | "wait";
    const decision = await withStateLock<Decision>(() => {
      const s = readState();
      if (s && isPidAlive(s.daemonPid)) {
        return "reuse";
      }
      if (s?.spawningPid && isPidAlive(s.spawningPid)) {
        // Another wrapper is in the middle of spawning a daemon.
        return "wait";
      }
      // Either no state, daemon dead, or spawner crashed. Claim spawn for ourselves.
      writeStateAtomicLocked({
        daemonPid: 0,
        port: 0,
        startedAt: new Date().toISOString(),
        wrappers: [],
        spawningPid: process.pid,
      });
      return "spawn";
    });

    if (decision === "reuse") {
      const state = readState();
      if (state && (await pingExistingProxy(state.port))) {
        return { daemonPid: state.daemonPid, port: state.port };
      }
      // Daemon pid alive but port not responding — force a respawn next iteration.
      await withStateLock(() => {
        const cur = readState();
        if (cur && cur.daemonPid && !cur.spawningPid) {
          // Mark the stuck daemon dead from our perspective by clearing state.
          try {
            process.kill(cur.daemonPid, "SIGTERM");
          } catch {
            // ignore
          }
          deleteState();
        }
      });
      continue;
    }

    if (decision === "wait") {
      await sleep(200);
      continue;
    }

    // We're the spawner.
    try {
      // Pre-flight: validate upstream config under the wrapper context so
      // errors surface here with a clear stack rather than as a silent daemon
      // crash.
      detectUpstream();
      // If the dead daemon left a sidecar+patched settings.json, recover
      // before the new daemon reads settings.json as its upstream.
      if (selfHeal()) {
        console.log("[cc-thinkfix] recovered ~/.claude/settings.json from stale daemon");
      }
      const result = await spawnAndWaitForDaemon();
      return result;
    } catch (err) {
      // Spawn failed — clear our placeholder so other wrappers don't wait forever.
      await withStateLock(() => deleteState());
      throw err;
    }
  }
}

async function spawnAndWaitForDaemon(): Promise<{ daemonPid: number; port: number }> {
  const logFd = openSync(DAEMON_LOG_PATH, "a");
  const scriptPath = process.argv[1];
  const child = spawn(process.execPath, [scriptPath, "__daemon"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  closeSync(logFd);

  const spawnedPid = child.pid;
  if (!spawnedPid) throw new Error("failed to spawn daemon (no pid)");

  // Poll for the daemon to replace our placeholder with a real entry. We're
  // NOT holding the state lock here — the daemon needs it to write state.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const state = readState();
    if (
      state &&
      state.daemonPid &&
      state.daemonPid !== 0 &&
      isPidAlive(state.daemonPid) &&
      (await pingExistingProxy(state.port))
    ) {
      console.log(`[cc-thinkfix] daemon ready: pid=${state.daemonPid} port=${state.port}`);
      return { daemonPid: state.daemonPid, port: state.port };
    }
    if (!isPidAlive(spawnedPid)) {
      throw new Error(
        `daemon process exited before becoming ready. See ${DAEMON_LOG_PATH} for details.`,
      );
    }
    await sleep(100);
  }
  throw new Error(`daemon did not become ready within 15s. See ${DAEMON_LOG_PATH}.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pingExistingProxy(port: number, timeoutMs = 1500): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { name?: string } | null;
    return body?.name === "cc-thinkfix";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mark _DaemonState as referenced so unused-import lint stays quiet — used
// transitively via withStateLock callbacks.
void ({} as DaemonState | undefined);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
