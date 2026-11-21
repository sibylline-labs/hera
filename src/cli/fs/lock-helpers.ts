import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { withBreakMutex } from "./break-mutex.js";

export const DEFAULT_LOCK_NAME = ".eris-lock";
export const DEFAULT_LOCK_MAX_AGE_MS = 30_000;

/**
 * Checks whether a POSIX PID is still alive (`kill(pid, 0)`).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

export function readHolderPid(pidFile: string): number | null {
  try {
    const raw = readFileSync(pidFile, "utf8").trim();
    if (!/^\d+$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Which lock a directory is: its inode, and the pid it holds (`null`: no readable pid). */
export interface LockIdentity {
  readonly ino: number;
  readonly pid: number | null;
}

export interface LockSnapshot extends LockIdentity {
  readonly mtimeMs: number;
}

/**
 * Reads `lockDir`'s inode, mtime and pid as one observation: the pid is accepted only when the
 * inode is the same before and after reading it, so the pid belongs to the directory the inode
 * names. `null` when no lock is there (or it keeps changing).
 */
export function snapshotLock(lockDir: string): LockSnapshot | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const before = statSync(lockDir);
      const pid = readHolderPid(join(lockDir, "pid"));
      const after = statSync(lockDir);
      if (before.ino === after.ino) {
        return { ino: before.ino, pid, mtimeMs: before.mtimeMs };
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function isLockStale(snapshot: LockSnapshot, maxAgeMs: number, nowMs: number): boolean {
  const ageMs = nowMs - snapshot.mtimeMs;
  if (snapshot.pid === null) {
    return ageMs > maxAgeMs;
  }
  if (!isPidAlive(snapshot.pid)) {
    return true;
  }
  return ageMs > maxAgeMs;
}

function sameLock(a: LockIdentity, b: LockIdentity): boolean {
  return a.ino === b.ino && a.pid === b.pid;
}

/**
 * Removes `lockDir` only while it is still the lock `expected` names (same inode, same pid).
 *
 * Every removal (stale break, release) runs under the `<lockDir>.break` mutex, and a creator can
 * only rename a populated lock into place while `lockDir` is absent or an empty directory. So a
 * lock with a pid file checked here is the lock renamed aside; an empty one (no readable pid) is
 * removed with `rmdir`, which fails rather than removing a populated lock renamed over it. The moved
 * inode is verified anyway and put back on a mismatch. Returns `false`, touching nothing, when the
 * lock is someone else's or the mutex stays busy.
 */
function removeLockIfStill(lockDir: string, expected: LockIdentity, tag: string): boolean {
  // Nothing to remove: skip the mutex, which would need to stage a directory beside a missing lockDir.
  if (statSync(lockDir, { throwIfNoEntry: false }) === undefined) return false;
  const removed = withBreakMutex(lockDir, () => {
    const current = snapshotLock(lockDir);
    if (current === null || !sameLock(current, expected)) return false;
    if (expected.pid === null) {
      try {
        rmdirSync(lockDir);
        return true;
      } catch (err) {
        // ENOTEMPTY on the same inode: an unreadable pid file, so not replaceable by rename; fall
        // through. A different inode is a populated lock renamed over the empty one: leave it.
        if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") return false;
        if (statSync(lockDir, { throwIfNoEntry: false })?.ino !== expected.ino) return false;
      }
    }
    const aside = `${lockDir}.${tag}.${process.pid}.${randomBytes(4).toString("hex")}`;
    try {
      renameSync(lockDir, aside);
    } catch {
      return false;
    }
    if (statSync(aside, { throwIfNoEntry: false })?.ino !== expected.ino) {
      try {
        renameSync(aside, lockDir);
      } catch {
        // lockDir was re-taken; the moved directory serves no holder
        rmSync(aside, { recursive: true, force: true });
      }
      return false;
    }
    rmSync(aside, { recursive: true, force: true });
    return true;
  });
  return removed === true;
}

/** Breaks the stale lock `observed` describes; `false` when `lockDir` is any other lock now. */
export function tryBreakStaleLock(lockDir: string, observed: LockIdentity): boolean {
  return removeLockIfStill(lockDir, observed, "stale");
}

/** Removes `lockDir` only while it is still the lock `owner` created. */
export function releaseLockIfOwned(lockDir: string, owner: LockIdentity): boolean {
  return removeLockIfStill(lockDir, owner, "rel");
}

/**
 * Creates `lockDir` holding this process's pid, atomically (stage, then rename into place; the
 * rename fails while any lock is there). Returns the pid file and the new lock's inode.
 */
export function createPopulatedLockDir(lockDir: string): { pidFile: string; ino: number } {
  const stageDir = `${lockDir}.stage.${process.pid}.${randomBytes(4).toString("hex")}`;
  mkdirSync(stageDir, { mode: 0o700 });
  try {
    writeFileSync(join(stageDir, "pid"), `${process.pid}\n`, { mode: 0o600 });
    const ino = statSync(stageDir).ino;
    renameSync(stageDir, lockDir);
    return { pidFile: join(lockDir, "pid"), ino };
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }
}
