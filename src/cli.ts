#!/usr/bin/env node
import { detectUpstream, type ProxyConfig } from "./config.js";
import { launchClaude } from "./launcher.js";
import { startProxy } from "./proxy.js";
import { patchCCSettings, restoreCCSettings, selfHeal } from "./settings.js";

const HELP = `cc-thinkfix — transparent proxy that fixes Anthropic thinking blocks

Usage:
  cc-thinkfix claude [args...]      Start proxy + launch Claude Code
  cc-thinkfix serve [--port <n>]    Start standalone proxy
  cc-thinkfix --version
  cc-thinkfix --help

The proxy auto-detects your upstream from ~/.claude/settings.json
or ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY environment variables.

With 'cc-thinkfix claude', you just run your normal Claude Code commands
prefixed with 'cc-thinkfix'. No config changes needed.
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
  config.port = opts.port;
  config.logLevel = opts.logLevel;
  const { close } = await startProxy(config);

  const shutdown = async (sig: string) => {
    console.log(`\n${sig} received, shutting down`);
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function claudeCommand(claudeArgs: string[]) {
  const config = detectUpstream();
  const { port, close } = await startProxy({ ...config, logLevel: "info" });

  const originalUrl = patchCCSettings(port);
  if (originalUrl) {
    console.log(`[cc-thinkfix] patched ~/.claude/settings.json → http://127.0.0.1:${port}`);
  }
  console.log(`[cc-thinkfix] proxy started on port ${port}, launching claude...`);

  const child = launchClaude(port, claudeArgs);

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    restoreCCSettings(originalUrl);
    if (originalUrl) {
      console.log("[cc-thinkfix] restored ~/.claude/settings.json");
    }
    try {
      await close();
    } catch {
      // ignore — we're exiting anyway
    }
  };

  // Synchronous cleanup for cases where the event loop won't get a chance to
  // run async code (uncaught exception, process.exit). Best effort.
  const cleanupSync = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    restoreCCSettings(originalUrl);
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

  // launcher.ts already forwards SIGINT/SIGTERM to the child. We additionally
  // make sure that if we ourselves get killed before the child does, we still
  // restore settings.json.
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