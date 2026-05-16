#!/usr/bin/env node
import { detectUpstream, resolvePort, type ProxyConfig } from "./config.js";
import { launchClaude } from "./launcher.js";
import { startProxy } from "./proxy.js";
import { patchCCSettings, restoreCCSettings, selfHeal } from "./settings.js";

/**
 * Health-check probe: is there a healthy cc-thinkfix already listening on `port`?
 * Returns true only if /health responds with our signature, so we don't
 * accidentally adopt some unrelated service that happens to share the port.
 */
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

const HELP = `cc-thinkfix — transparent proxy that fixes Anthropic thinking blocks

Usage:
  cc-thinkfix claude [args...]      Start proxy + launch Claude Code
  cc-thinkfix serve [--port <n>]    Start standalone proxy
  cc-thinkfix --version
  cc-thinkfix --help

The proxy auto-detects your upstream from ~/.claude/settings.json
or ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY environment variables.

Default port 28080 (override with --port or CC_THINKFIX_PORT env var).
Singleton: a second 'cc-thinkfix claude' shares the existing proxy
instead of starting a new one — only the first instance touches settings.json.
`;

async function main() {
  // Recover from a previous run that didn't clean up (kill -9, crash, etc.)
  // before reading any config — otherwise we'd read the polluted patched value
  // as if it were the real upstream.
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

  if (command === "claude") {
    const claudeArgs = args.slice(1);
    await claudeCommand(claudeArgs);
    return;
  }

  console.error(`unknown command: ${command}`);
  console.log(HELP);
  process.exit(2);
}

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
      if (already) {
        console.error(
          `[cc-thinkfix] another cc-thinkfix is already listening on port ${config.port}.\n` +
            "  Nothing to do — point your client at it directly.",
        );
      } else {
        console.error(
          `[cc-thinkfix] port ${config.port} is occupied by something else.\n` +
            "  Free the port, or run with --port <N> / CC_THINKFIX_PORT=N.",
        );
      }
      process.exit(1);
    }
    throw err;
  }
}

async function claudeCommand(claudeArgs: string[]) {
  const port = resolvePort();

  // Singleton model:
  //   - If a healthy cc-thinkfix is already on `port`, we're a follower.
  //     We do NOT call detectUpstream (the owner's patch makes settings.json
  //     look like a loopback URL, and the loopback guard would trip).
  //   - Otherwise we try to become the owner: read upstream config, bind the
  //     port, patch settings.json. If we lose a race to another starter,
  //     fall back to follower.
  let isOwner = false;
  let proxyClose: (() => Promise<void>) | null = null;
  let originalUrl: string | null = null;

  if (await pingExistingProxy(port)) {
    console.log(
      `[cc-thinkfix] joining existing cc-thinkfix proxy on port ${port} (follower)`,
    );
  } else {
    const config = detectUpstream();
    try {
      const handle = await startProxy({ ...config, port, logLevel: "info" });
      proxyClose = handle.close;
      isOwner = true;
      console.log(`[cc-thinkfix] proxy started on port ${port} (owner)`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      // Lost the race — another cc-thinkfix bound the port between our ping
      // and our bind. Re-ping to confirm it's ours, then fall through to follower.
      if (!(await pingExistingProxy(port))) {
        console.error(
          `[cc-thinkfix] port ${port} is in use by something that isn't a cc-thinkfix proxy.\n` +
            `  Free the port, or set CC_THINKFIX_PORT=<N> / --port <N> to a free port.`,
        );
        process.exit(1);
      }
      console.log(
        `[cc-thinkfix] joining existing cc-thinkfix proxy on port ${port} (follower, won race)`,
      );
    }

    if (isOwner) {
      originalUrl = patchCCSettings(port);
      if (originalUrl) {
        console.log(`[cc-thinkfix] patched ~/.claude/settings.json → http://127.0.0.1:${port}`);
      }
    }
  }

  const child = launchClaude(port, claudeArgs);

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (isOwner) {
      restoreCCSettings(originalUrl);
      if (originalUrl) {
        console.log("[cc-thinkfix] restored ~/.claude/settings.json");
      }
      if (proxyClose) {
        try {
          await proxyClose();
        } catch {
          // ignore — we're exiting anyway
        }
      }
    }
  };

  // Synchronous best-effort cleanup for paths the event loop can't service
  // (uncaughtException, process.exit, plain SIGTERM that doesn't bubble through child).
  const cleanupSync = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (isOwner) restoreCCSettings(originalUrl);
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

  // launcher.ts forwards SIGINT/SIGTERM to the child. These handlers add
  // owner-side cleanup for paths the child-exit handler can't catch.
  process.on("uncaughtException", (err) => {
    console.error("[cc-thinkfix] uncaught:", err);
    cleanupSync();
    process.exit(1);
  });
  process.on("exit", cleanupSync);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});