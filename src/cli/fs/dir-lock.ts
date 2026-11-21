import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { ErrorSlug } from "../../core/schema/index.js";
import { ErisError } from "../errors/eris-error.js";
import {
  DEFAULT_LOCK_MAX_AGE_MS,
  DEFAULT_LOCK_NAME,
  createPopulatedLockDir,
  isLockStale,
  readHolderPid,
  releaseLockIfOwned,
  snapshotLock,
  tryBreakStaleLock,
} from "./lock-helpers.js";

export interface DirLockOptions {
  readonly lockName?: string | undefined;
  readonly maxAgeMs?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
}

export interface DirLockHandle {
  readonly lockDir: string;
  readonly pidFile: string;
  readonly ownerPid: number;
  /** The inode of the lock directory this handle created; release removes only that directory. */
  readonly lockIno: number;
  readonly release: () => void;
}

/**
 * Synchronously acquires a directory lock (`<dir>/.eris-lock`).
 * Throws an `ErisError` (`slug: "lock-held"`) if held by a live, non-stale process.
 */
export function acquireDirLockSync(
  dir: string,
  opts: DirLockOptions = {},
): DirLockHandle {
  const targetDir = resolve(dir);
  mkdirSync(dirname(targetDir), { recursive: true });
  mkdirSync(targetDir, { recursive: true });

  const lockName = opts.lockName ?? DEFAULT_LOCK_NAME;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_LOCK_MAX_AGE_MS;
  const nowFn = opts.nowMs ?? Date.now;
  const lockDir = join(targetDir, lockName);
  const pidFile = join(lockDir, "pid");

  let released = false;
  const makeHandle = (created: { pidFile: string; ino: number }): DirLockHandle => {
    const handle: DirLockHandle = {
      lockDir,
      pidFile: created.pidFile,
      ownerPid: process.pid,
      lockIno: created.ino,
      release: () => {
        if (released) return;
        released = true;
        releaseDirLockSync(handle);
      },
    };
    return handle;
  };

  try {
    return makeHandle(createPopulatedLockDir(lockDir));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") {
      throw ErisError.operational(ErrorSlug.make("lock-acquire-failed"), {
        what: `Failed to acquire lock at ${lockDir}`,
        cause: err,
      });
    }
  }

  // One observation decides both staleness and which lock to break, so a lock swapped in between
  // (other pid, or the same pid on a new inode) is never broken on the old one's evidence.
  const observed = snapshotLock(lockDir);
  if (observed !== null && isLockStale(observed, maxAgeMs, nowFn())) {
    if (tryBreakStaleLock(lockDir, observed)) {
      try {
        return makeHandle(createPopulatedLockDir(lockDir));
      } catch {
        // Another contender won the race; fall through to lock-held
      }
    }
  }

  const holder = observed?.pid ?? readHolderPid(pidFile);
  throw ErisError.operational(ErrorSlug.make("lock-held"), {
    what: `Directory lock ${lockDir} is already held${holder ? ` by pid ${holder}` : ""}`,
    fix: `Wait for the active eris process${holder ? ` (pid ${holder})` : ""} to finish, or remove ${lockDir} if it is stale.`,
  });
}

/**
 * Synchronously releases a `DirLockHandle`'s lock, only while `lockDir` is still the directory the
 * handle created (same inode, same pid); a lock another process took since is left alone.
 */
export function releaseDirLockSync(handle: DirLockHandle): void {
  releaseLockIfOwned(handle.lockDir, { ino: handle.lockIno, pid: handle.ownerPid });
}

/**
 * Runs an `Effect` while holding `<dir>/.eris-lock`, releasing the lock via
 * `Effect.acquireUseRelease` on success, failure, defect (`Effect.die`), or
 * fiber interruption.
 */
export function withDirLock<A, E, R>(
  dir: string,
  effect: Effect.Effect<A, E, R>,
  opts: DirLockOptions = {},
): Effect.Effect<A, E | ErisError, R> {
  return Effect.acquireUseRelease(
    Effect.try({
      try: () => acquireDirLockSync(dir, opts),
      catch: (err) =>
        ErisError.is(err)
          ? err
          : ErisError.operational(ErrorSlug.make("lock-acquire-failed"), {
              what:
                err instanceof Error
                  ? err.message
                  : `Failed to acquire directory lock in ${dir}`,
              cause: err,
            }),
    }),
    () => effect,
    (handle) =>
      Effect.sync(() => {
        handle.release();
      }),
  );
}

export const DirLock = {
  acquireSync: acquireDirLockSync,
  releaseSync: releaseDirLockSync,
  withLock: withDirLock,
} as const;
