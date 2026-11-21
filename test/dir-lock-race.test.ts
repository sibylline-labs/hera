import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { acquireDirLockSync } from "../src/cli/fs/dir-lock.js";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURE = path.join(REPO, "test", "fixtures", "lock-contender.ts");

interface ContenderResult {
  attempts: number;
  wins: number;
  overlaps: number;
  errors: string[];
  errorCount: number;
}

function contend(mode: string, dir: string, lockDir: string, snapshot: object, ms: number) {
  return new Promise<ContenderResult>((resolve, reject) => {
    const child = spawn("bun", [FIXTURE, mode, dir, lockDir, String(ms), JSON.stringify(snapshot)], {
      cwd: REPO,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(JSON.parse(out) as ContenderResult);
      } catch {
        reject(new Error(`contender ${mode} exited ${code}: ${err.slice(0, 400)}`));
      }
    });
  });
}

function scratch(name: string): string {
  const dir = path.join(REPO, "data", "scratch", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe("DirLock holds under contending removers", () => {
  // admits: removers acting on a stale or forged observation moving a live holder's lock aside, so
  // a third contender acquires while the holder still runs (two holders); process interleaving is
  // runtime-only. Two removers run at once so the `.break` mutex itself is contended.
  test.each([
    ["break", "stale pid", (ino: number) => ({ pid: 999999, ino })],
    ["break", "live pid on another inode", (ino: number) => ({ pid: process.pid, ino: ino + 1 })],
    ["release", "forged owner", (ino: number) => ({ pid: 999999, ino })],
  ] as const)(
    "a live holder keeps sole ownership while two processes loop %s (%s) and another loops acquire",
    async (mode, _label, forge) => {
      const dir = scratch(`dir-lock-race-${mode}-${forge(0).pid}`);
      const held = acquireDirLockSync(dir);
      const ino = fs.statSync(held.lockDir).ino;
      try {
        const [r1, r2, acquirer] = await Promise.all([
          contend(mode, dir, held.lockDir, forge(ino), 1500),
          contend(mode, dir, held.lockDir, forge(ino), 1500),
          contend("acquire", dir, held.lockDir, {}, 1500),
        ]);
        expect([r1.errors, r2.errors, acquirer.errors]).toEqual([[], [], []]);
        expect(r1.attempts + r2.attempts).toBeGreaterThan(50);
        expect(r1.wins + r2.wins).toBe(0);
        expect(acquirer.wins).toBe(0);
        expect(fs.statSync(held.lockDir).ino).toBe(ino);
        expect(fs.readFileSync(held.pidFile, "utf8").trim()).toBe(String(process.pid));
      } finally {
        held.release();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );

  // admits: two processes inside the `.break` critical section at once, or a release that throws
  // EPERM at a remover, because the mutex is deleted in place while another takes it; runtime-only.
  test("four processes contending the break mutex never overlap and never throw", async () => {
    const dir = scratch("dir-lock-race-mutex");
    const lockDir = path.join(dir, ".eris-lock");
    try {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => contend("mutex", dir, lockDir, {}, 2000)),
      );
      expect(results.map((r) => r.errors)).toEqual([[], [], [], []]);
      expect(results.reduce((n, r) => n + r.overlaps, 0)).toBe(0);
      expect(results.reduce((n, r) => n + r.attempts, 0)).toBeGreaterThan(200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  // admits: withDirLock's release finalizer throwing (an Effect defect) or acquire failing with
  // anything but lock-held when four processes break each other's locks (maxAgeMs 1); runtime-only.
  test("four processes looping withDirLock (maxAgeMs 1) see only success or lock-held", async () => {
    const dir = scratch("dir-lock-race-with-lock");
    try {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() => contend("with-lock", dir, path.join(dir, ".eris-lock"), {}, 2000)),
      );
      expect(results.map((r) => r.errors)).toEqual([[], [], [], []]);
      expect(results.reduce((n, r) => n + r.wins, 0)).toBeGreaterThan(20);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  // admits: a breaker of an empty (pid-less) lockDir moving aside a populated lock a creator renamed
  // over it between snapshot and rmdir (two holders, leaked `.stale.*` directories); runtime-only.
  test("breaking empty lockDirs never lets two acquirers hold or leaks moved-aside directories", async () => {
    const dir = scratch("dir-lock-race-empty-break");
    const lockDir = path.join(dir, ".eris-lock");
    try {
      const results = await Promise.all([
        ...[1, 2, 3].map(() => contend("break-empty", dir, lockDir, {}, 3000)),
        ...[1, 2, 3].map(() => contend("acquire-marked", dir, lockDir, {}, 3000)),
      ]);
      const acquirers = results.slice(3);
      expect(results.map((r) => r.errors)).toEqual([[], [], [], [], [], []]);
      expect(acquirers.reduce((n, r) => n + r.overlaps, 0)).toBe(0);
      expect(acquirers.reduce((n, r) => n + r.wins, 0)).toBeGreaterThan(0);
      expect(fs.readdirSync(dir).filter((n) => n.includes(".stale."))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
