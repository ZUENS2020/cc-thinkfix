// Lightweight update check. Runs at startup of user-facing commands.
//
// Design goals:
//   - Never block the user. We don't await the network — just kick off a
//     fetch in the background and write the result to a cache file. The
//     warning is shown on the NEXT invocation, after the cache is fresh.
//   - Check at most once per ~24h. Cached in ~/.claude/.cc-thinkfix-update-check.json.
//   - Opt out via env CC_THINKFIX_DISABLE_UPDATE_CHECK=1.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CACHE_PATH = join(homedir(), ".claude", ".cc-thinkfix-update-check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_TIMEOUT_MS = 1500;
const REGISTRY_URL = "https://registry.npmjs.org/cc-thinkfix/latest";

interface UpdateCache {
  checkedAt: string;
  latestVersion: string;
}

function readCache(): UpdateCache | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8")) as UpdateCache;
  } catch {
    return null;
  }
}

function writeCache(latestVersion: string): void {
  try {
    writeFileSync(
      CACHE_PATH,
      JSON.stringify(
        { checkedAt: new Date().toISOString(), latestVersion },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
  } catch {
    // best effort — not worth crashing over
  }
}

/**
 * Compare two semver-ish strings (X.Y.Z). Returns true iff a < b.
 * Tolerates suffixes (1.2.3-beta) by stripping them.
 */
export function isOlderVersion(a: string, b: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, "").split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false;
}

/**
 * Synchronously print an update-available banner if the cache says we're
 * behind. Then, if the cache is stale, kick off a background fetch that
 * will update the cache for next time. Never throws, never awaits.
 */
export function checkForUpdates(currentVersion: string): void {
  if (process.env.CC_THINKFIX_DISABLE_UPDATE_CHECK === "1") return;

  const cache = readCache();
  if (cache && isOlderVersion(currentVersion, cache.latestVersion)) {
    process.stderr.write(
      `\x1b[33m[cc-thinkfix] update available: ${currentVersion} → ${cache.latestVersion}\x1b[0m\n` +
        `  Run: npm i -g cc-thinkfix@latest\n`,
    );
  }

  // Refresh in the background if stale.
  const stale =
    !cache ||
    Date.now() - new Date(cache.checkedAt).getTime() > CHECK_INTERVAL_MS;
  if (stale) {
    void refreshInBackground();
  }
}

async function refreshInBackground(): Promise<void> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, { signal: ac.signal });
    if (!res.ok) return;
    const body = (await res.json()) as { version?: string };
    if (typeof body.version === "string") {
      writeCache(body.version);
    }
  } catch {
    // Network errors, timeout, etc. — silent.
  } finally {
    clearTimeout(t);
  }
}
