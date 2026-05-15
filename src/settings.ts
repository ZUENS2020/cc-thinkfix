import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CC_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

export function patchCCSettings(proxyPort: number): string | null {
  if (!exists(CC_SETTINGS_PATH)) return null;
  try {
    const raw = readFileSync(CC_SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (!settings.env || typeof settings.env !== "object") return null;
    const env = settings.env as Record<string, string>;
    const original = env.ANTHROPIC_BASE_URL;
    if (!original) return null;
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
    writeFileSync(CC_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
    return original;
  } catch {
    return null;
  }
}

export function restoreCCSettings(originalUrl: string | null) {
  if (!originalUrl) return;
  try {
    if (!exists(CC_SETTINGS_PATH)) return;
    const raw = readFileSync(CC_SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (!settings.env || typeof settings.env !== "object") return;
    const env = settings.env as Record<string, string>;
    env.ANTHROPIC_BASE_URL = originalUrl;
    writeFileSync(CC_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  } catch {
    // best effort — don't crash on cleanup failure
  }
}

function exists(path: string): boolean {
  try {
    readFileSync(path, "utf-8");
    return true;
  } catch {
    return false;
  }
}