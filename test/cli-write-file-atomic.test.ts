/**
 * `writeFileAtomic`: a reader sees the old bytes or the new bytes, the mode follows the options,
 * and a failure at any step leaves the target byte-identical with no temp sibling behind.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AtomicWriteStep, writeFileAtomic } from "../src/cli/fs/index.js";
import { HeraCli } from "../src/cli/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hera-atomic-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const target = () => join(dir, "state.json");
const mode = (p: string) => statSync(p).mode & 0o777;
const temps = (d = dir) => readdirSync(d).filter((n) => n.endsWith(".tmp"));

describe("writeFileAtomic: modes", () => {
  // admits: boundary-io: a new file hardcoded to 0644/0600 instead of the umask default; mode is runtime fs state.
  it("a new file gets the umask default", () => {
    HeraCli.writeFileAtomic(target(), "{}\n");
    expect(readFileSync(target(), "utf8")).toBe("{}\n");
    expect(mode(target())).toBe(0o666 & ~process.umask());
    expect(temps()).toEqual([]);
  });

  // admits: boundary-io: a rewrite that resets an operator's chosen mode to the temp's 0600 or the umask default.
  it("an existing file keeps its mode by default", () => {
    writeFileSync(target(), "old");
    chmodSync(target(), 0o640);
    writeFileAtomic(target(), "new");
    expect(readFileSync(target(), "utf8")).toBe("new");
    expect(mode(target())).toBe(0o640);
  });

  // admits: boundary-io: a secret file left world-readable because the old target's mode won over the explicit one.
  it("an explicit mode wins over the existing file's mode", () => {
    writeFileSync(target(), "old");
    chmodSync(target(), 0o644);
    writeFileAtomic(target(), "secret", { mode: 0o600 });
    expect(mode(target())).toBe(0o600);
  });

  // admits: boundary-io: a first write into a missing directory failing ENOENT when the caller asked for mkdir.
  it("mkdir creates the parent with the given mode", () => {
    const nested = join(dir, "a", "b", "claim.json");
    writeFileAtomic(nested, "x", { mkdir: { mode: 0o700 }, mode: 0o600 });
    expect(readFileSync(nested, "utf8")).toBe("x");
    expect(mode(join(dir, "a", "b"))).toBe(0o700);
  });

  // admits: boundary-io: latin1 manifests re-encoded as utf8, changing bytes above 0x7f.
  it("encodes string data with the given encoding", () => {
    writeFileAtomic(target(), "café", { encoding: "latin1" });
    expect([...readFileSync(target())]).toEqual([0x63, 0x61, 0x66, 0xe9]);
  });
});

describe("writeFileAtomic: a failed step leaves the target and no temp", () => {
  const steps: AtomicWriteStep[] = ["mkdir", "open", "write", "chmod", "rename"];
  for (const step of steps) {
    // admits: boundary-io: a thrown step that strands a temp (plaintext leak) or truncates the target.
    it(`${step}: target byte-identical, mode kept, no temp, the error rethrown`, () => {
      writeFileSync(target(), "old");
      chmodSync(target(), 0o640);
      const faults = (s: AtomicWriteStep) => {
        if (s === step) throw new Error(`injected fault at ${s}`);
      };
      expect(() => writeFileAtomic(target(), "new", { mkdir: true, mode: 0o600, faults })).toThrow(
        `injected fault at ${step}`,
      );
      expect(readFileSync(target(), "utf8")).toBe("old");
      expect(mode(target())).toBe(0o640);
      expect(temps()).toEqual([]);
    });
  }

  // admits: boundary-io: cleanup that only runs on injected faults and misses a real rename error from the OS.
  it("a real rename failure (target is a non-empty directory) leaves no temp", () => {
    mkdirSync(join(target(), "inner"), { recursive: true });
    expect(() => writeFileAtomic(target(), "new")).toThrow();
    expect(statSync(target()).isDirectory()).toBe(true);
    expect(temps()).toEqual([]);
  });

  // admits: boundary-io: a fixed or colliding temp name (`.pid.tmp`) leaking siblings across repeated writes.
  it("repeated writes leave exactly the final file", () => {
    for (let i = 0; i < 50; i++) writeFileAtomic(target(), `v${i}`);
    expect(readFileSync(target(), "utf8")).toBe("v49");
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});
