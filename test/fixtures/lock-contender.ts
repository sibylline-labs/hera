/**
 * A DirLock contender for test/dir-lock-race.test.ts, run as its own process:
 *   bun test/fixtures/lock-contender.ts <mode> <dir> <lockDir> <durationMs> <snapshotJson>
 * Modes: `acquire` loops acquireDirLockSync (each win released at once); `break` loops
 * tryBreakStaleLock with a snapshot; `release` loops releaseDirLockSync with a forged handle;
 * `mutex` loops withBreakMutex around an exclusive marker file and counts overlaps; `with-lock`
 * loops withDirLock with maxAgeMs 1 and counts defects and unexpected failures.
 * Prints `{"mode","attempts","wins","overlaps","errors"}` on stdout; never exits non-zero.
 */
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { withBreakMutex } from "../../src/cli/fs/break-mutex.js";
import { acquireDirLockSync, releaseDirLockSync, withDirLock } from "../../src/cli/fs/dir-lock.js";
import { snapshotLock, tryBreakStaleLock } from "../../src/cli/fs/lock-helpers.js";

const [mode, dir, lockDir, durationMs, snapshotJson] = process.argv.slice(2);
const snapshot = JSON.parse(snapshotJson ?? "{}") as { pid: number; ino: number };
const deadline = Date.now() + Number(durationMs);
let attempts = 0;
let wins = 0;
let overlaps = 0;
const errors: string[] = [];
while (Date.now() < deadline) {
  attempts++;
  try {
    if (mode === "acquire") {
      try {
        const handle = acquireDirLockSync(dir!);
        wins++;
        handle.release();
      } catch (err) {
        if ((err as { slug?: string }).slug !== "lock-held") throw err;
      }
    } else if (mode === "acquire-marked") {
      try {
        const handle = acquireDirLockSync(dir!, { maxAgeMs: 60_000 });
        const marker = `${dir}/active`;
        try {
          closeSync(openSync(marker, "wx"));
          unlinkSync(marker);
          wins++;
        } catch {
          overlaps++;
        }
        handle.release();
      } catch (err) {
        if ((err as { slug?: string }).slug !== "lock-held") throw err;
      }
    } else if (mode === "break-empty") {
      try {
        mkdirSync(lockDir!);
      } catch {
        // a lock is already there
      }
      const snap = snapshotLock(lockDir!);
      if (snap !== null && snap.pid === null && tryBreakStaleLock(lockDir!, snap)) wins++;
    } else if (mode === "break") {
      if (tryBreakStaleLock(lockDir!, snapshot)) wins++;
    } else if (mode === "release") {
      releaseDirLockSync({
        lockDir: lockDir!,
        pidFile: `${lockDir}/pid`,
        ownerPid: snapshot.pid,
        lockIno: snapshot.ino,
        release: () => {},
      });
    } else if (mode === "mutex") {
      withBreakMutex(lockDir!, () => {
        const marker = `${lockDir}.inside`;
        let fd: number;
        try {
          fd = openSync(marker, "wx");
        } catch {
          overlaps++;
          return;
        }
        closeSync(fd);
        unlinkSync(marker);
      });
    } else {
      const exit = Effect.runSyncExit(withDirLock(dir!, Effect.sync(() => "ok"), { maxAgeMs: 1 }));
      if (Exit.isSuccess(exit)) wins++;
      else if (Cause.hasDies(exit.cause)) errors.push(`die: ${Cause.pretty(exit.cause).split("\n")[0]}`);
      else {
        const slug = (Cause.findErrorOption(exit.cause) as { value?: { slug?: string } }).value?.slug;
        if (slug !== "lock-held") errors.push(`fail: ${slug}`);
      }
    }
  } catch (err) {
    errors.push(String((err as Error).message ?? err).slice(0, 160));
  }
}
process.stdout.write(JSON.stringify({ mode, attempts, wins, overlaps, errors: errors.slice(0, 5), errorCount: errors.length }));
