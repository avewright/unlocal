import { mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { UnlocalError } from "./errors.ts";

/**
 * A process lock over a file that several unlocal processes read, change and write:
 * the account ledger, a project's state. Locks are directories because mkdir either
 * creates one or fails atomically; the holder refreshes its mtime while it works, so a
 * slow deploy isn't mistaken for a crashed one and a crashed holder is taken over.
 *
 * Not re-entrant: never lock the same target twice in one call stack (a nested
 * `withAccount` inside `runGuard` would wait on itself).
 */

export interface LockOptions {
  /** How long to wait for a busy lock before giving up. Default 10s. */
  waitMs?: number;
  /** A lock the holder hasn't refreshed for this long is presumed abandoned. Default 30s. */
  staleMs?: number;
  /** What's locked, for the error message. Defaults to the target path. */
  what?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withLock<T>(target: string, fn: () => T | Promise<T>, options: LockOptions = {}): Promise<T> {
  const lock = `${target}.lock`;
  const waitMs = options.waitMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const what = options.what ?? target;

  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) {
        // Rename before removing: only one waiter can win the rename, so a stale
        // lock is never deleted out from under a process that just took it.
        const tomb = `${lock}.stale-${process.pid}-${Date.now()}`;
        await rename(lock, tomb).then(() => rm(tomb, { recursive: true, force: true }), () => {});
      } else if (Date.now() >= deadline) {
        throw new UnlocalError("BUSY", `${what} is in use by another unlocal process`, {
          hint: `wait for it to finish and retry; if nothing is running, remove ${lock}`,
        });
      } else {
        await sleep(15 + Math.random() * 25);
      }
    }
  }

  const beat = setInterval(() => {
    const now = new Date();
    void utimes(lock, now, now).catch(() => {});
  }, Math.max(1_000, Math.floor(staleMs / 3)));
  beat.unref();

  try {
    return await fn();
  } finally {
    clearInterval(beat);
    await rm(lock, { recursive: true, force: true });
  }
}
