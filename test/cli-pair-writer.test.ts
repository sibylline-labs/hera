/**
 * The atomic `.env` / `.secret.env` (/ `.dev.vars`) set writer. Every test fails a different step
 * and asserts the previous set survived, observed on disk rather than on a return value. The
 * cases and messages mirror the consumer CLI's own suite, so that suite passes against this
 * implementation with only its import changed.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AtomicPairWriter, type PairStep, writePair } from "../src/cli/fs/index.js";
import { ErisError } from "../src/cli/errors/index.js";

const REPO = resolve(import.meta.dirname, "..");
const HOLD = join(REPO, "test", "fixtures", "pair-writer-hold.ts");
const OLD_ENV = "OLD=1\n";
const OLD_SECRET = "S=old\n";
const NEW_ENV = "NEW=2\n";
const NEW_SECRET = "S=new\n";
const OLD_MTIME = new Date("2024-01-02T03:04:05Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hera-pair-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const envPath = () => join(dir, ".env");
const secretPath = () => join(dir, ".secret.env");
const devPath = () => join(dir, ".dev.vars");
const mode = (p: string) => statSync(p).mode & 0o777;
const stages = () => readdirSync(dir).filter((n) => n.startsWith(".eris-pull."));

/** `.env` at 0640 (not the umask default, so a re-created file would show) and `.secret.env` 0600. */
function seedPair(): void {
  writeFileSync(envPath(), OLD_ENV);
  chmodSync(envPath(), 0o640);
  writeFileSync(secretPath(), OLD_SECRET);
  chmodSync(secretPath(), 0o600);
  utimesSync(envPath(), OLD_MTIME, OLD_MTIME);
  utimesSync(secretPath(), OLD_MTIME, OLD_MTIME);
}

function expectPreviousPair(): void {
  expect(readFileSync(envPath(), "utf8")).toBe(OLD_ENV);
  expect(readFileSync(secretPath(), "utf8")).toBe(OLD_SECRET);
  expect(mode(envPath())).toBe(0o640);
  expect(mode(secretPath())).toBe(0o600);
  expect(statSync(envPath()).mtime.getTime()).toBe(OLD_MTIME.getTime());
}

function failAt(step: PairStep, side?: () => void) {
  return (s: PairStep) => {
    if (s === step) {
      side?.();
      throw new Error(`injected fault at ${s}`);
    }
  };
}

describe("writePair: success", () => {
  // admits: boundary-io: a hardcoded .env mode, a secret file inheriting the plain mode, or a stage surviving success; runtime fs state.
  it("replaces both files, .env at the umask default and .secret.env at 0600, and leaves no stage", async () => {
    seedPair();
    const r = await writePair(dir, NEW_ENV, NEW_SECRET);
    expect(r).toEqual({ ok: true, envPath: envPath(), secretPath: secretPath() });
    expect(readFileSync(envPath(), "utf8")).toBe(NEW_ENV);
    expect(readFileSync(secretPath(), "utf8")).toBe(NEW_SECRET);
    expect(mode(envPath())).toBe(0o666 & ~process.umask());
    expect(mode(secretPath())).toBe(0o600);
    expect(stages()).toEqual([]);
  });
});

describe("writePair: with .dev.vars", () => {
  const OLD_DEV = "OLD_DEV=1\n";
  const NEW_DEV = "NEW_DEV=2\n";

  // admits: boundary-io: the third file staged at a non-0600 mode or left in the stage; runtime fs state.
  it("lands all three files, .dev.vars at 0600, and leaves no stage", async () => {
    const r = await writePair(dir, NEW_ENV, NEW_SECRET, {}, NEW_DEV);
    expect(r).toEqual({ ok: true, envPath: envPath(), secretPath: secretPath(), devVarsPath: devPath() });
    expect(readFileSync(devPath(), "utf8")).toBe(NEW_DEV);
    expect(mode(devPath())).toBe(0o600);
    expect(stages()).toEqual([]);
  });

  // admits: boundary-io: a pull for a non-wrangler service clobbering a hand-made third file; runtime fs state.
  it("without bytes for it, never creates or touches a .dev.vars", async () => {
    writeFileSync(devPath(), OLD_DEV);
    await writePair(dir, NEW_ENV, NEW_SECRET);
    expect(readFileSync(devPath(), "utf8")).toBe(OLD_DEV);
  });

  for (const step of ["open-devvars", "write-devvars", "chmod-devvars", "snapshot-devvars", "rename-devvars"] as const) {
    // admits: boundary-io: a failed third-file step leaving a half-replaced trio or a plaintext stage; runtime fs state.
    it(`${step}: the previous trio is intact and the stage is removed`, async () => {
      seedPair();
      writeFileSync(devPath(), OLD_DEV);
      const r = await writePair(dir, NEW_ENV, NEW_SECRET, { faults: failAt(step) }, NEW_DEV);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.critical).toBe(false);
      expectPreviousPair();
      expect(readFileSync(devPath(), "utf8")).toBe(OLD_DEV);
      expect(stages()).toEqual([]);
    });
  }

  // admits: boundary-io: a failed third rename losing the old file with no restore; runtime fs state.
  it("rename-devvars that lost the old .dev.vars restores it from the snapshot", async () => {
    seedPair();
    writeFileSync(devPath(), OLD_DEV);
    const faults = failAt("rename-devvars", () => rmSync(devPath()));
    const r = await writePair(dir, NEW_ENV, NEW_SECRET, { faults }, NEW_DEV);
    expect(r.ok).toBe(false);
    expectPreviousPair();
    expect(readFileSync(devPath(), "utf8")).toBe(OLD_DEV);
    expect(stages()).toEqual([]);
  });

  // admits: boundary-io: a failed rollback reported as ordinary while deleting the recovery snapshot; runtime fs state.
  it("a failed rollback with three files is CRITICAL and keeps the snapshot", async () => {
    seedPair();
    writeFileSync(devPath(), OLD_DEV);
    const faults = (s: PairStep) => {
      if (s === "rename-devvars" || s === "rollback-secret") throw new Error(`injected fault at ${s}`);
    };
    const r = await writePair(dir, NEW_ENV, NEW_SECRET, { faults }, NEW_DEV);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.critical).toBe(true);
    expect(r.message).toContain(`rollback of ${secretPath()} failed`);
    expect(stages()).toHaveLength(1);
  });

  // admits: boundary-io: orphaned new files left when nothing existed before; runtime fs state.
  it("rename-devvars with no previous files removes the two new ones already renamed", async () => {
    const r = await writePair(dir, NEW_ENV, NEW_SECRET, { faults: failAt("rename-devvars") }, NEW_DEV);
    expect(r.ok).toBe(false);
    expect([envPath(), secretPath(), devPath()].map(existsSync)).toEqual([false, false, false]);
  });
});

describe("writePair: a failed step leaves the previous pair byte-identical", () => {
  const rows: Array<[PairStep, (stage: string) => string]> = [
    ["stage", () => `Failed to create a staging dir in ${dir}`],
    ["prev", (s) => `Failed to create ${s}/prev`],
    ["open-plain", (s) => `Failed to write ${s}/.env`],
    ["write-plain", (s) => `Failed to write ${s}/.env`],
    ["open-secret", (s) => `Failed to write ${s}/.secret.env`],
    ["write-secret", (s) => `Failed to write ${s}/.secret.env`],
    ["chmod-secret", (s) => `Failed to chmod ${s}/.secret.env`],
    ["snapshot-plain", () => `Failed to snapshot ${dir}/.env before rename pair`],
    ["snapshot-secret", () => `Failed to snapshot ${dir}/.secret.env before rename pair`],
    ["rename-plain", (s) => `Failed to rename ${s}/.env -> ${dir}/.env`],
    ["rename-secret", (s) => `Failed to rename ${s}/.secret.env -> ${dir}/.secret.env`],
  ];
  for (const [step, message] of rows) {
    // admits: boundary-io: a failed step leaving a half pair, a stage, or a message the operator cannot act on; runtime fs state.
    it(`${step}: previous pair intact, stage removed, the step's own message`, async () => {
      seedPair();
      const r = await writePair(dir, NEW_ENV, NEW_SECRET, { faults: failAt(step) });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.critical).toBe(false);
      expect(r.message).toBe(message(r.stage ?? ""));
      expectPreviousPair();
      expect(stages()).toEqual([]);
    });
  }

  // admits: boundary-io: an orphaned new .env left when the pair did not exist before; runtime fs state.
  it("rename-secret with no previous files removes the orphaned new .env", async () => {
    const r = await writePair(dir, NEW_ENV, NEW_SECRET, { faults: failAt("rename-secret") });
    expect(r.ok).toBe(false);
    expect(existsSync(envPath())).toBe(false);
    expect(existsSync(secretPath())).toBe(false);
    expect(stages()).toEqual([]);
  });

  // admits: boundary-io: a failed second rename losing the old secret file with no restore; runtime fs state.
  it("rename-secret that lost the old .secret.env restores it from the snapshot", async () => {
    seedPair();
    const faults = failAt("rename-secret", () => rmSync(secretPath()));
    const r = await writePair(dir, NEW_ENV, NEW_SECRET, { faults });
    expect(r.ok).toBe(false);
    expectPreviousPair();
    expect(stages()).toEqual([]);
  });
});

describe("writePair: a failed rollback is CRITICAL and keeps the snapshot", () => {
  for (const [step, file] of [
    ["rollback-plain", ".env"],
    ["rollback-secret", ".secret.env"],
  ] as const) {
    // admits: boundary-io: a failed rollback that deletes or misnames the operator's recovery snapshot; runtime fs state.
    it(`${step}: names the snapshot, and the snapshot still holds the previous bytes`, async () => {
      seedPair();
      const faults = (s: PairStep) => {
        if (s === "rename-secret") {
          if (step === "rollback-secret") rmSync(secretPath());
          throw new Error("injected");
        }
        if (s === step) throw new Error("injected");
      };
      const r = await writePair(dir, NEW_ENV, NEW_SECRET, { faults });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      const snapshot = `${r.stage}/prev/${file}`;
      expect(r.critical).toBe(true);
      expect(r.message).toBe(`CRITICAL: rollback of ${dir}/${file} failed — manual recovery from ${snapshot} required`);
      expect(readFileSync(snapshot, "utf8")).toBe(file === ".env" ? OLD_ENV : OLD_SECRET);
    });
  }
});

describe("AtomicPairWriter.write (Effect)", () => {
  // admits: boundary-io: the Effect entry point reporting success or an untyped defect on a failed write; the result union is runtime.
  it("fails with pair-writer-failed and leaves the previous pair", async () => {
    seedPair();
    const exit = await Effect.runPromiseExit(
      AtomicPairWriter.write({ dir, env: NEW_ENV, secret: NEW_SECRET, options: { faults: failAt("rename-secret") } }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    const err = Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : undefined;
    expect(ErisError.is(err) && err.slug).toBe("pair-writer-failed");
    expectPreviousPair();
  });

  // admits: boundary-io: a critical rollback failure collapsed into the ordinary slug; slug choice is runtime.
  it("fails with pair-writer-rollback-failed when a rollback fails", async () => {
    seedPair();
    const faults = (s: PairStep) => {
      if (s === "rename-secret" || s === "rollback-plain") throw new Error("injected");
    };
    const exit = await Effect.runPromiseExit(AtomicPairWriter.write({ dir, env: NEW_ENV, secret: NEW_SECRET, options: { faults } }));
    const err = Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail" ? exit.cause.reasons[0].error : undefined;
    expect(ErisError.is(err) && err.slug).toBe("pair-writer-rollback-failed");
  });

  // admits: boundary-io: the Effect entry point failing or leaking a stage on the happy path; runtime fs state.
  it("succeeds with the written paths", async () => {
    const r = await Effect.runPromise(AtomicPairWriter.write({ dir, env: NEW_ENV, secret: NEW_SECRET }));
    expect(r.envPath).toBe(envPath());
    expect(stages()).toEqual([]);
  });
});

/** Starts the hold fixture and resolves once the write is parked at `step`. */
async function holdWriteAt(
  step?: PairStep,
  opts: { devVars?: boolean; siblingListener?: boolean; settlingListener?: boolean } = {},
) {
  const argv = [
    HOLD,
    dir,
    ...(step ? [step] : []),
    ...(opts.devVars ? ["--dev-vars"] : []),
    ...(opts.siblingListener ? ["--sibling-listener"] : []),
    ...(opts.settlingListener ? ["--settling-listener"] : []),
  ];
  const child = spawn("bun", argv, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  await new Promise<void>((done, reject) => {
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      if (out.includes("holding\n")) done();
    });
    child.on("exit", () => reject(new Error(`hold fixture exited early: ${out}`)));
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
    child.on("exit", (code, signal) => done({ code, signal })),
  );
  return { child, exited };
}

async function exitWithin(exited: Promise<{ code: number | null; signal: string | null }>, kill: () => void) {
  const outcome = await Promise.race([exited, new Promise<"alive">((r) => setTimeout(() => r("alive"), 3000))]);
  if (outcome === "alive") kill();
  expect(outcome).not.toBe("alive");
  return outcome as { code: number | null; signal: string | null };
}

const filesUnder = (root: string) =>
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((n) => statSync(join(root, n)).isFile())
    .sort();

/** Whether git, reading `gitignore` as the only ignore file, ignores each path (relative to `dir`). */
function ignoredBy(gitignore: string, paths: string[]): Array<[string, boolean]> {
  writeFileSync(join(dir, ".gitignore"), gitignore);
  const git = (...args: string[]) =>
    spawnSync("git", ["-c", "core.excludesFile=/dev/null", "-C", dir, ...args], { encoding: "utf8" });
  expect(git("init", "-q").status).toBe(0);
  return paths.map((rel) => [rel, git("check-ignore", "-q", "--", rel).status === 0]);
}

describe("writePair: a signal mid-write", () => {
  // admits: boundary-io: the signal path skipping stage cleanup (plaintext secret bytes) or swallowing the signal; signals are runtime-only.
  it("SIGINT while the files are written: the process dies by the signal, the pair is intact, no stage is left", async () => {
    seedPair();
    const { child, exited } = await holdWriteAt();
    expect(stages().length).toBe(1);
    child.kill("SIGINT");
    const { code, signal } = await exited;
    expect(signal ?? String(code)).toBe("SIGINT");
    expectPreviousPair();
    expect(stages()).toEqual([]);
  });

  // admits: boundary-io: a write left running on a deleted stage strands plaintext secret bytes if the exit is skipped.
  it("SIGTERM with a sibling listener: the stage is removed and the process still ends by the signal's exit", async () => {
    seedPair();
    const { child, exited } = await holdWriteAt(undefined, { siblingListener: true });
    expect(stages().length).toBe(1);
    child.kill("SIGTERM");
    const { code, signal } = await exitWithin(exited, () => child.kill("SIGKILL"));
    expect(signal === "SIGTERM" || code === 143).toBe(true);
    expectPreviousPair();
    expect(stages()).toEqual([]);
  });

  // admits: boundary-io: a sibling that settles the held step would resume the commit on the deleted stage.
  it("SIGTERM with a sibling that settles the held write: the writer never resumes on the deleted stage", async () => {
    seedPair();
    const { child, exited } = await holdWriteAt(undefined, { settlingListener: true });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.kill("SIGTERM");
    const { code, signal } = await exitWithin(exited, () => child.kill("SIGKILL"));
    expect(signal === "SIGTERM" || code === 143).toBe(true);
    expect(out).not.toContain("completed");
    expect(stages()).toEqual([]);
  });

  // admits: boundary-io: a staged name the bare gitignore patterns miss, exposing plaintext after SIGKILL; only git can judge it.
  it("SIGKILL with every file staged: the leftovers keep their final basenames, hidden by bare gitignore patterns", async () => {
    seedPair();
    writeFileSync(devPath(), "OLD_DEV=1\n", { mode: 0o600 });
    const { child, exited } = await holdWriteAt("rename-plain", { devVars: true });
    child.kill("SIGKILL");
    expect((await exited).signal).toBe("SIGKILL");

    const left = stages();
    expect(left).toHaveLength(1);
    const staged = filesUnder(join(dir, left[0] ?? ""));
    expect(staged).toEqual([".dev.vars", ".env", ".secret.env", "prev/.dev.vars", "prev/.env", "prev/.secret.env"]);
    const ignored = ignoredBy(".env\n.secret.env\n.dev.vars\n", staged.map((rel) => `${left[0]}/${rel}`));
    for (const [rel, hidden] of ignored) expect([rel, hidden]).toEqual([rel, true]);
    expectPreviousPair();
  });
});
