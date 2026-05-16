// Patch ~/.claude/settings.json to point ANTHROPIC_BASE_URL at our local proxy
// while cc-thinkfix is running, then restore on exit.
//
// Crash-safety: before patching, the original URL is mirrored to a sidecar file.
// `selfHeal()` runs on startup and uses the sidecar to recover settings.json
// if a previous run was killed before it could restore. This way a polluted
// settings.json from a -9'd run doesn't poison the next launch.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CC_SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const SIDECAR_PATH = join(homedir(), ".claude", ".cc-thinkfix-original.json");

interface Sidecar {
  originalBaseUrl: string;
  patchedAt: string;
  pid: number;
}

/**
 * Crash recovery. Called once at process startup, before reading config.
 * If a sidecar exists, restore settings.json from it and delete the sidecar.
 *
 * Returns true if recovery happened (so the caller can log it).
 */
export function selfHeal(): boolean {
  if (!existsSync(SIDECAR_PATH)) return false;
  try {
    const sidecar = JSON.parse(readFileSync(SIDECAR_PATH, "utf-8")) as Sidecar;
    if (!sidecar.originalBaseUrl) {
      unlinkSync(SIDECAR_PATH);
      return false;
    }
    writeBaseUrl(sidecar.originalBaseUrl);
    unlinkSync(SIDECAR_PATH);
    return true;
  } catch {
    // Corrupt sidecar — remove it so it doesn't haunt future runs. Don't
    // touch settings.json since we don't know what to restore to.
    try {
      unlinkSync(SIDECAR_PATH);
    } catch {
      // ignore
    }
    return false;
  }
}

export function patchCCSettings(proxyPort: number): string | null {
  if (!existsSync(CC_SETTINGS_PATH)) return null;
  try {
    const raw = readFileSync(CC_SETTINGS_PATH, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    if (!settings.env || typeof settings.env !== "object") return null;
    const env = settings.env as Record<string, string>;
    const original = env.ANTHROPIC_BASE_URL;
    if (!original) return null;

    // Write sidecar FIRST so a crash between sidecar-write and settings-write
    // still leaves us with the truth. (Settings is the unchanged original
    // at that point; sidecar matches it; selfHeal will be a no-op rewrite.)
    const sidecar: Sidecar = {
      originalBaseUrl: original,
      patchedAt: new Date().toISOString(),
      pid: process.pid,
    };
    writeFileSync(SIDECAR_PATH, JSON.stringify(sidecar, null, 2) + "\n", "utf-8");

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
    writeBaseUrl(originalUrl);
  } catch {
    // best effort — don't crash on cleanup failure
  }
  // Sidecar can go away now that the real file is restored.
  try {
    if (existsSync(SIDECAR_PATH)) unlinkSync(SIDECAR_PATH);
  } catch {
    // ignore
  }
}

function writeBaseUrl(url: string): void {
  if (!existsSync(CC_SETTINGS_PATH)) return;
  const raw = readFileSync(CC_SETTINGS_PATH, "utf-8");
  const settings = JSON.parse(raw) as Record<string, unknown>;
  if (!settings.env || typeof settings.env !== "object") return;
  const env = settings.env as Record<string, string>;
  env.ANTHROPIC_BASE_URL = url;
  writeFileSync(CC_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}
