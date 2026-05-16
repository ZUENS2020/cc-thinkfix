// Shared state for the cc-thinkfix daemon and its wrapper clients.
//
// ~/.claude/.cc-thinkfix-state.json records which daemon is running, on what
// port, and which wrapper processes are currently using it. Wrappers register
// themselves on launch and deregister on exit; the daemon tears itself down
// when the wrapper count hits zero.
//
// Concurrency: writes go through `withStateLock` which uses an atomic
// `mkdir(lockDir, { exclusive })`. The critical sections are tiny (read +
// modify + atomic rename), so contention is rare. Stale locks (older than
// LOCK_STALE_MS, or held by a dead pid) are forcibly cleared.

import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_PATH = join(homedir(), ".claude", ".cc-thinkfix-state.json");
const LOCK_DIR = join(homedir(), ".claude", ".cc-thinkfix-state.lock");
const LOCK_STALE_MS = 5_000;
const LOCK_RETRY_MS = 50;
const LOCK_RETRY_LIMIT = 100;

export interface WrapperEntry {
  wrapperPid: number;
  joinedAt: string;
}

export interface DaemonState {
  daemonPid: number;
  port: number;
  startedAt: string;
  wrappers: WrapperEntry[];
  // While a wrapper is in the middle of spawning a daemon, this is its PID.
  // Other wrappers seeing this should wait instead of also spawning. Cleared
  // by the daemon's initDaemonStateLocked overwrite once it's healthy.
  spawningPid?: number;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readState(): DaemonState | null {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

export function writeStateAtomicLocked(state: DaemonState): void {
  const tmp = STATE_PATH + ".tmp." + process.pid;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, STATE_PATH);
}

// Internal alias for files inside this module that already hold the lock.
const writeStateAtomic = writeStateAtomicLocked;

export function deleteState(): void {
  try {
    unlinkSync(STATE_PATH);
  } catch {
    // ignore — already gone
  }
}

export async function withStateLock<T>(
  fn: () => T | Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    try {
      mkdirSync(LOCK_DIR);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock held — clear if stale.
      let stale = false;
      try {
        const age = Date.now() - statSync(LOCK_DIR).mtimeMs;
        if (age > LOCK_STALE_MS) stale = true;
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          rmdirSync(LOCK_DIR);
        } catch {
          // best effort
        }
      }
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      return await fn();
    } finally {
      try {
        rmdirSync(LOCK_DIR);
      } catch {
        // ignore — lock might have been force-cleared
      }
    }
  }
  throw new Error("timed out acquiring cc-thinkfix state lock");
}

/**
 * Register a wrapper PID against the current daemon. Caller must hold the
 * state lock (use `withStateLock`).
 *
 * Returns the new wrapper count, or null if the state file is missing /
 * mentions a dead daemon (caller should treat this as "no daemon").
 */
export function registerWrapperLocked(wrapperPid: number): number | null {
  const state = readState();
  if (!state || !isPidAlive(state.daemonPid)) return null;
  state.wrappers = state.wrappers.filter((w) => w.wrapperPid !== wrapperPid);
  state.wrappers.push({ wrapperPid, joinedAt: new Date().toISOString() });
  writeStateAtomic(state);
  return state.wrappers.length;
}

/**
 * Remove a wrapper PID from the daemon's registry. Returns the remaining
 * wrapper count after removal, or null if no state file. Caller must hold
 * the state lock.
 */
export function deregisterWrapperLocked(wrapperPid: number): number | null {
  const state = readState();
  if (!state) return null;
  state.wrappers = state.wrappers.filter((w) => w.wrapperPid !== wrapperPid);
  writeStateAtomic(state);
  return state.wrappers.length;
}

/**
 * Daemon-side: write/replace the initial state record. Caller must hold the
 * state lock.
 */
export function initDaemonStateLocked(port: number): void {
  writeStateAtomic({
    daemonPid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    wrappers: [],
  });
}

/**
 * Daemon-side: drop any wrappers whose PIDs are no longer alive. Returns the
 * remaining wrapper count. Caller must hold the state lock.
 */
export function pruneDeadWrappersLocked(): number {
  const state = readState();
  if (!state) return 0;
  const before = state.wrappers.length;
  state.wrappers = state.wrappers.filter((w) => isPidAlive(w.wrapperPid));
  if (state.wrappers.length !== before) writeStateAtomic(state);
  return state.wrappers.length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
