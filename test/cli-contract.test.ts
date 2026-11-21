import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import pkg from "../package.json" with { type: "json" };
import {
  ErisError,
  HeraCli,
  failureLines,
  resolveDeadlineMs,
  scrubFreeText,
} from "../src/cli/index.js";
import {
  createPopulatedLockDir,
  readHolderPid,
  releaseLockIfOwned,
  snapshotLock,
  tryBreakStaleLock,
} from "../src/cli/fs/lock-helpers.js";
import { AWS_EXAMPLE_KEY } from "./fixtures/provider-tokens.js";

const SCRATCH = path.resolve(import.meta.dirname, "..", "data", "scratch", "cli-contract");
const B64_43 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";

describe("failure block fix lines (output contract)", () => {
  // admits: a continuation fix line without the `fix: ` prefix that line-prefix consumers drop; output text has no type.
  test("every line of a multi-line fix starts with `fix: `", () => {
    const err = ErisError.operational("multi-fix", {
      what: "it broke",
      fix: "first step\n  second step\n\nthird step",
    });
    const fixRows = failureLines(err, { erisHome: "/h" }).filter((l) => !/^(ERROR|slug:|docs:) /.test(l));
    expect(fixRows).toEqual(["fix: first step", "fix:   second step", "fix: third step"]);
  });

  // admits: a fabricated `eris doctor` fix when the error carries none; output text has no type.
  test.each([undefined, "", "   \n  "])("no `fix:` line and no `eris doctor` when fix is %j", (fix) => {
    const err = ErisError.operational("no-fix", { what: "it broke", ...(fix === undefined ? {} : { fix }) });
    const lines = failureLines(err, { erisHome: "/h" });
    expect(lines.some((l) => l.startsWith("fix:"))).toBe(false);
    expect(lines.join("\n")).not.toContain("eris doctor");
    expect(lines).toHaveLength(4);
  });

  // admits: the verb's own internal-error block suggesting a command that does not exist; output text has no type.
  test("an unexpected defect renders no `eris doctor` suggestion", async () => {
    let stderr = "";
    const verb = HeraCli.verb({
      name: "boom",
      handler: () => {
        throw new Error("defect");
      },
    });
    const code = await verb(undefined, { erisHome: "/h", stderr: (s: string) => (stderr += s) });
    expect(code).toBe(1);
    expect(stderr).toContain("slug: cli-internal-error");
    expect(stderr).not.toContain("eris doctor");
  });
});

describe("pool deadline env var is integer seconds (ERIS_BATCH_TIMEOUT)", () => {
  // admits: a seconds env value read as milliseconds (1000x shorter deadline); the env value is an untyped string.
  test.each([
    ["60", 60_000],
    ["1", 1_000],
    ["0", 60_000],
    ["-5", 60_000],
    ["1.5", 60_000],
    ["abc", 60_000],
    [undefined, 60_000],
  ])("ERIS_BATCH_TIMEOUT=%j resolves to %d ms", (raw, ms) => {
    expect(resolveDeadlineMs({ deadlineEnvVar: "ERIS_BATCH_TIMEOUT" }, { ERIS_BATCH_TIMEOUT: raw })).toBe(ms);
  });

  // admits: the seconds conversion leaking into the explicit milliseconds option; both are `number`.
  test("an explicit deadlineMs stays milliseconds and wins over the env var", () => {
    expect(resolveDeadlineMs({ deadlineMs: 250, deadlineEnvVar: "T" }, { T: "9" })).toBe(250);
  });
});

describe("scrubFreeText covers eris outbound-scan's 13 classes", () => {
  // admits: a sib_ token redacted under the wrong class or left partly in plaintext; regex behaviour has no type.
  test("sib_ service tokens redact as sib-token", () => {
    const res = scrubFreeText(`token sib_01HZY3N8Q2W5K7M9P1R3T5V7X9_${B64_43} end`);
    expect(res.text).toBe("token <redacted:sib-token> end");
    expect(res.redactions).toEqual(["sib-token"]);
  });

  // admits: a device code shipped unredacted; regex behaviour has no type.
  test("sibdc_ device codes redact as sibdc-code", () => {
    const res = scrubFreeText(`polling sibdc_BCDFGHJK_${B64_43}`);
    expect(res.text).toBe("polling <redacted:sibdc-code>");
    expect(res.redactions).toEqual(["sibdc-code"]);
  });

  // admits: a shape narrowed while syncing with eris (bounded JWT segments, a sib_ token with a
  // non-issued secret length, a scheme outside the known list); regex behaviour has no type.
  test.each([
    [`jwt eyJhbGciOiJIUzI1NiJ9.eyJ${"a".repeat(600)}.sig_${"b".repeat(40)}`, "jwt eyJ"],
    ["sib_01HZY3N8Q2W5K7M9P1R3T5V7X9_shortSecret12", "shortSecret12"],
    ["https://deploy:hunter2hunter2@git.example.com/repo", "hunter2hunter2"],
  ])("%s keeps redacting", (raw, leaked) => {
    const once = scrubFreeText(raw);
    expect(once.text).not.toContain(leaked === "jwt eyJ" ? "a".repeat(600) : leaked);
    expect(scrubFreeText(once.text).text).toBe(once.text);
  });

  // admits: an AWS secret classified as a generic assignment; regex behaviour has no type.
  test("aws_secret_access_key assignments redact as aws-key", () => {
    const res = scrubFreeText("aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(res.text).not.toContain("wJalrXUtnFEMI");
    expect(res.redactions).toContain("aws-key");
  });

  // admits: a key id glued to another match leaking, or a second scrub changing the text; regex behaviour has no type.
  test.each([
    `${AWS_EXAMPLE_KEY}gh${"p_"}${"a".repeat(36)}`,
    `postgres://${AWS_EXAMPLE_KEY}@db.internal/app`,
    `${AWS_EXAMPLE_KEY}${"x".repeat(5)}://u:p@h`,
  ])("a key id glued to another class's match redacts, and a second scrub changes nothing: %s", (raw) => {
    const once = scrubFreeText(raw).text;
    expect(once).not.toContain(AWS_EXAMPLE_KEY);
    expect(scrubFreeText(once).text).toBe(once);
    expect(scrubFreeText(once).redactions).toEqual([]);
  });
});

describe("DirLock removal is bound to the observed lock (inode + pid)", () => {
  // admits: two contenders both winning a stale-lock break; filesystem interleaving is runtime-only.
  test("a contender that observed a stale holder does not break a fresh lock taken since", () => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    const lockDir = path.join(SCRATCH, ".eris-lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "pid"), "999999\n");
    const observed = snapshotLock(lockDir);
    expect(observed?.pid).toBe(999999);

    // Contender A breaks the stale lock and takes a fresh one.
    expect(tryBreakStaleLock(lockDir, observed!)).toBe(true);
    createPopulatedLockDir(lockDir);

    // Contender B, still acting on its stale observation, must back out.
    expect(tryBreakStaleLock(lockDir, observed!)).toBe(false);
    expect(readHolderPid(path.join(lockDir, "pid"))).toBe(process.pid);
    expect(fs.readdirSync(SCRATCH)).toEqual([".eris-lock"]);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  });

  // admits: a same-pid re-acquisition (pid reuse, or this process again) matching a stale
  // observation of the previous lock; only the inode tells them apart, at runtime.
  test("a lock with the observed pid on a new inode is not broken on the old observation", () => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    const lockDir = path.join(SCRATCH, ".eris-lock");
    createPopulatedLockDir(lockDir);
    const first = snapshotLock(lockDir)!;
    fs.renameSync(lockDir, path.join(SCRATCH, "kept-so-the-inode-is-not-reused"));
    createPopulatedLockDir(lockDir);

    expect(tryBreakStaleLock(lockDir, first)).toBe(false);
    expect(snapshotLock(lockDir)?.ino).not.toBe(first.ino);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  });

  // admits: a release that removes a lock another process re-took after this one lost it;
  // filesystem interleaving is runtime-only.
  test("release removes the lock only while it is the lock the releaser created", () => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    const lockDir = path.join(SCRATCH, ".eris-lock");
    const created = createPopulatedLockDir(lockDir);

    expect(releaseLockIfOwned(lockDir, { ino: created.ino, pid: 999999 })).toBe(false);
    expect(releaseLockIfOwned(lockDir, { ino: created.ino + 1, pid: process.pid })).toBe(false);
    expect(readHolderPid(path.join(lockDir, "pid"))).toBe(process.pid);
    expect(releaseLockIfOwned(lockDir, { ino: created.ino, pid: process.pid })).toBe(true);
    expect(fs.readdirSync(SCRATCH)).toEqual([]);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  });

  // admits: release throwing ENOENT (or an Effect defect in withDirLock's finalizer) when the lock's
  // directory was removed by the guarded work; main returned quietly.
  test("releasing a lock whose directory is gone returns false and writes nothing", () => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    const lockDir = path.join(SCRATCH, "gone", ".eris-lock");
    fs.mkdirSync(path.dirname(lockDir));
    const created = createPopulatedLockDir(lockDir);
    fs.rmSync(path.dirname(lockDir), { recursive: true, force: true });

    expect(releaseLockIfOwned(lockDir, { ino: created.ino, pid: process.pid })).toBe(false);
    expect(fs.existsSync(path.dirname(lockDir))).toBe(false);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  });

  // admits: an empty stale lockDir (pid null) not being removed, or a populated lock with an
  // unreadable pid file being left forever; the rmdir/ENOTEMPTY branch is otherwise unexercised.
  test("an empty stale lockDir is removed, and one holding an unreadable pid file is moved aside", () => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    const lockDir = path.join(SCRATCH, ".eris-lock");
    fs.mkdirSync(lockDir);
    expect(tryBreakStaleLock(lockDir, snapshotLock(lockDir)!)).toBe(true);
    expect(fs.readdirSync(SCRATCH)).toEqual([]);

    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "pid"), "not-a-pid");
    const snap = snapshotLock(lockDir)!;
    expect(snap.pid).toBeNull();
    expect(tryBreakStaleLock(lockDir, snap)).toBe(true);
    expect(fs.readdirSync(SCRATCH)).toEqual([]);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  });

  // admits: a remover that died inside the break mutex blocking every later break forever;
  // process death is runtime-only.
  test("a break mutex left by a dead process is cleared by the next remover", () => {
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH, { recursive: true });
    const lockDir = path.join(SCRATCH, ".eris-lock");
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, "pid"), "999999\n");
    fs.mkdirSync(`${lockDir}.break`);
    fs.writeFileSync(path.join(`${lockDir}.break`, "pid"), "999998\n");

    expect(tryBreakStaleLock(lockDir, snapshotLock(lockDir)!)).toBe(true);
    expect(fs.readdirSync(SCRATCH)).toEqual([]);
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  });
});

describe("package surface", () => {
  // admits: boundary-io: a subpath entry pointing at a missing module; package.json has no checker here (the consumer typecheck covers resolution).
  test("granular CLI subpaths resolve to plane modules", () => {
    const exportsMap = pkg.exports as Record<string, { default: string }>;
    for (const sub of ["errors", "manifest", "fs", "process", "runtime"]) {
      const entry = exportsMap[`./cli/${sub}`];
      expect(entry?.default).toBe(`./src/cli/${sub}/index.ts`);
      expect(fs.existsSync(path.resolve(import.meta.dirname, "..", entry!.default))).toBe(true);
    }
  });

  // admits: any package other than effect creeping back into hard dependencies; package.json has no checker.
  test("effect is the only hard dependency (the agent group's peer pins live in test/hygiene/agent-pins)", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(["effect"]);
  });
});
