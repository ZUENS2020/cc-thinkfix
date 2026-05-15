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

interface CCSettings {
  env?: Record<string, string>;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
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
  if (fromCC) return fromCC;

  const fromEnv = readFromEnv();
  if (fromEnv) return fromEnv;

  console.error(
    "[cc-thinkfix] Cannot detect upstream URL.\n" +
      "  Set ANTHROPIC_BASE_URL in your environment,\n" +
      "  or add it to ~/.claude/settings.json under env.",
  );
  process.exit(1);
}