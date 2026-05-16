import { readFileSync as readSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProxyConfig {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  port?: number;
  logLevel?: "silent" | "info" | "debug";
}

const CC_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

// Fixed default port so settings.json doesn't churn every run, and so a
// second `cc-thinkfix claude` can detect the first one with a try-bind.
// Override via env CC_THINKFIX_PORT or --port.
export const DEFAULT_PROXY_PORT = 28080;

export function resolvePort(cliPort?: number): number {
  if (cliPort && Number.isFinite(cliPort)) return cliPort;
  const envPort = process.env.CC_THINKFIX_PORT;
  if (envPort) {
    const n = Number(envPort);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PROXY_PORT;
}

interface CCSettings {
  env?: Record<string, string>;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Refuse to treat a loopback URL as the upstream. If we ever read one, it
// means settings.json is in a leftover patched state from a previous run
// that didn't clean up — using it as the upstream would forward requests
// to ourselves (infinite loop) or to a stale port (ECONNREFUSED).
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function readCCSettings(): ProxyConfig | null {
  if (!existsSync(CC_SETTINGS_PATH)) return null;
  try {
    const raw = JSON.parse(readSync(CC_SETTINGS_PATH, "utf-8")) as CCSettings;
    const env = raw.env ?? {};
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const apiKey = env.ANTHROPIC_API_KEY ?? env.ANTHROPIC_AUTH_TOKEN ?? "";
    if (!baseUrl) return null;
    return { upstreamBaseUrl: stripTrailingSlash(baseUrl), upstreamApiKey: apiKey };
  } catch {
    return null;
  }
}

function readFromEnv(): ProxyConfig | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";
  if (!baseUrl) return null;
  return { upstreamBaseUrl: stripTrailingSlash(baseUrl), upstreamApiKey: apiKey };
}

export function detectUpstream(): ProxyConfig {
  const fromCC = readCCSettings();
  if (fromCC) {
    if (isLoopback(fromCC.upstreamBaseUrl)) {
      console.error(
        `[cc-thinkfix] ~/.claude/settings.json has a loopback ANTHROPIC_BASE_URL (${fromCC.upstreamBaseUrl}).\n` +
          "  This means a previous cc-thinkfix run didn't restore the file (likely killed -9 or crashed).\n" +
          "  Edit ~/.claude/settings.json and set ANTHROPIC_BASE_URL back to your real upstream\n" +
          "  (e.g. https://litellm.example.com), then try again.",
      );
      process.exit(1);
    }
    return fromCC;
  }

  const fromEnv = readFromEnv();
  if (fromEnv) {
    if (isLoopback(fromEnv.upstreamBaseUrl)) {
      console.error(
        `[cc-thinkfix] ANTHROPIC_BASE_URL env var is a loopback address (${fromEnv.upstreamBaseUrl}).\n` +
          "  cc-thinkfix needs to know the real upstream — pointing it at localhost would loop.",
      );
      process.exit(1);
    }
    return fromEnv;
  }

  console.error(
    "[cc-thinkfix] Cannot detect upstream URL.\n" +
      "  Set ANTHROPIC_BASE_URL in your environment,\n" +
      "  or add it to ~/.claude/settings.json under env.",
  );
  process.exit(1);
}