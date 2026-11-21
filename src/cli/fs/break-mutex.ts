import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How long a remover waits for another remover's critical section (microseconds of work). */
const MUTEX_WAIT_MS = 250;
/** A mutex with no readable pid this old was left by a process that died while taking it. */
const ORPHAN_AGE_MS = 5_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function holderPid(dir: string): number | null {
  try {
    const raw = readFileSync(join(dir, "pid"), "utf8").trim();
    return /^\d+$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function asidePath(mutex: string, tag: string): string {
  return `${mutex}.${tag}.${process.pid}.${randomBytes(4).toString("hex")}`;
}

/**
 * Moves the mutex directory aside only while it is still the one `expected` names (inode, and the
 * pid inside it), then deletes the moved copy, which no other process can reach. The mutex is never
 * deleted in place: a half-deleted (empty) mutex is a directory another process's rename can replace,
 * which is how two holders and an EPERM from `rm` happened.
 */
function moveAsideIf(mutex: string, expected: { ino: number; pid: number | null }, tag: string): boolean {
  const aside = asidePath(mutex, tag);
  try {
    renameSync(mutex, aside);
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
  const moved = statSync(aside, { throwIfNoEntry: false });
  if (moved?.ino !== expected.ino || holderPid(aside) !== expected.pid) {
    try {
      renameSync(aside, mutex);
      return false;
    } catch {
      // The mutex was re-taken meanwhile; the moved directory serves no holder.
    }
  }
  rmSync(aside, { recursive: true, force: true });
  return moved?.ino === expected.ino;
}

/** Takes the mutex: a directory holding our pid, renamed into place only while none is there. */
function tryTake(mutex: string): number | null {
  const stage = asidePath(mutex, "stage");
  try {
    mkdirSync(stage, { mode: 0o700 });
    writeFileSync(join(stage, "pid"), `${process.pid}\n`, { mode: 0o600 });
    const ino = statSync(stage).ino;
    renameSync(stage, mutex);
    return ino;
  } catch {
    rmSync(stage, { recursive: true, force: true });
    return null;
  }
}

/**
 * Clears a mutex whose holder died inside its critical section. Two clearers racing on the same dead
 * mutex both check the moved inode, so at most one deletes it and neither deletes a live one.
 */
function clearDeadHolder(mutex: string): void {
  const st = statSync(mutex, { throwIfNoEntry: false });
  if (st === undefined) return;
  const pid = holderPid(mutex);
  const dead = pid === null ? Date.now() - st.mtimeMs > ORPHAN_AGE_MS : !pidAlive(pid);
  if (dead) moveAsideIf(mutex, { ino: st.ino, pid }, "dead");
}

/**
 * Runs `fn` holding `<lockDir>.break`, the mutex every lock removal shares. Returns `undefined`
 * without running `fn` when another remover holds it past `MUTEX_WAIT_MS`.
 */
export function withBreakMutex<T>(lockDir: string, fn: () => T): T | undefined {
  const mutex = `${lockDir}.break`;
  const deadline = Date.now() + MUTEX_WAIT_MS;
  for (;;) {
    const ino = tryTake(mutex);
    if (ino !== null) {
      try {
        return fn();
      } finally {
        moveAsideIf(mutex, { ino, pid: process.pid }, "done");
      }
    }
    clearDeadHolder(mutex);
    if (Date.now() >= deadline) return undefined;
    sleepSync(1);
  }
}
