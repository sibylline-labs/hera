import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { StageGuard } from "./pair-signals.js";
import type { PairBytes, PairFailure, PairOptions, PairResult, PairStep } from "./pair-types.js";

type Which = "plain" | "secret" | "devvars";

interface StagedFile {
  readonly which: Which;
  readonly name: string;
  readonly data: Uint8Array;
  readonly mode: number;
}

export interface CommitContext {
  readonly dir: string;
  readonly stagePath: string;
  readonly guard: StageGuard;
  readonly opts: PairOptions;
  /** Runs an async fault hook; throws when the step is failed. */
  readonly hook: (step: PairStep) => Promise<void>;
  /** Removes the stage and returns the non-critical failure. */
  readonly fail: (message: string) => PairFailure;
}

class StepFailed extends Error {}

function bytes(v: PairBytes): Uint8Array {
  return typeof v === "string" ? Buffer.from(v, "utf8") : v;
}

/** `cp -p`: bytes, mode and times. */
function copyPreserving(from: string, to: string): void {
  const st = statSync(from);
  copyFileSync(from, to);
  chmodSync(to, st.mode & 0o7777);
  utimesSync(to, st.atime, st.mtime);
}

/**
 * Writes every file into the stage under its final basename, snapshots the existing set into
 * `prev/`, then renames the set into place synchronously, rolling back on a failed rename.
 * `.env` is opened `0666` so the umask decides its mode; secret-bearing files are `0600`.
 */
export async function commitPair(
  ctx: CommitContext,
  envBytes: PairBytes,
  secretBytes: PairBytes,
  devVarsBytes: PairBytes | undefined,
): Promise<PairResult> {
  const { dir, stagePath, guard, opts, hook, fail } = ctx;
  const files: StagedFile[] = [
    { which: "plain", name: ".env", data: bytes(envBytes), mode: 0o666 },
    { which: "secret", name: ".secret.env", data: bytes(secretBytes), mode: 0o600 },
  ];
  if (devVarsBytes !== undefined) {
    files.push({ which: "devvars", name: ".dev.vars", data: bytes(devVarsBytes), mode: 0o600 });
  }
  const out = (name: string) => join(dir, name);
  const tmp = (name: string) => join(stagePath, name);
  const prev = (name: string) => join(stagePath, "prev", name);

  const writeFile = async (f: StagedFile) => {
    let fd: number | undefined;
    try {
      await hook(`open-${f.which}`);
      fd = openSync(tmp(f.name), "w", f.mode);
      await hook(`write-${f.which}`);
      let off = 0;
      while (off < f.data.byteLength) off += writeSync(fd, f.data, off);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  };

  for (const f of files) {
    try {
      await writeFile(f);
    } catch {
      return fail(`Failed to write ${tmp(f.name)}`);
    }
    if (f.which === "plain") continue;
    try {
      await hook(`chmod-${f.which}`);
      chmodSync(tmp(f.name), 0o600);
    } catch {
      return fail(`Failed to chmod ${tmp(f.name)}`);
    }
  }

  const had = files.map((f) => existsSync(out(f.name)) && statSync(out(f.name)).isFile());
  for (const [i, f] of files.entries()) {
    if (!had[i]) continue;
    try {
      await hook(`snapshot-${f.which}`);
      copyPreserving(out(f.name), prev(f.name));
    } catch {
      return fail(`Failed to snapshot ${out(f.name)} before rename pair`);
    }
  }

  // The rename set: synchronous from here to the end, so no signal lands between renames.
  const step = (s: PairStep) => {
    try {
      void opts.faults?.(s);
    } catch {
      throw new StepFailed(s);
    }
  };
  const critical = (message: string): PairResult => {
    guard.keep();
    return { ok: false, message, critical: true, stage: stagePath };
  };
  const rollbackMessage = (name: string) =>
    `CRITICAL: rollback of ${out(name)} failed — manual recovery from ${prev(name)} required`;

  for (const [i, f] of files.entries()) {
    try {
      step(`rename-${f.which}`);
      renameSync(tmp(f.name), out(f.name));
    } catch {
      // Undo every rename already made, in order, then restore a target the failed rename lost.
      for (const [j, g] of files.slice(0, i).entries()) {
        if (!had[j]) {
          rmSync(out(g.name), { force: true });
          continue;
        }
        try {
          step(`rollback-${g.which}`);
          renameSync(prev(g.name), out(g.name));
        } catch {
          return critical(rollbackMessage(g.name));
        }
      }
      if (had[i] && !existsSync(out(f.name))) {
        try {
          step(`rollback-${f.which}`);
          renameSync(prev(f.name), out(f.name));
        } catch {
          return critical(rollbackMessage(f.name));
        }
      }
      return fail(`Failed to rename ${tmp(f.name)} -> ${out(f.name)}`);
    }
  }

  guard.remove();
  return {
    ok: true,
    envPath: out(".env"),
    secretPath: out(".secret.env"),
    ...(devVarsBytes === undefined ? {} : { devVarsPath: out(".dev.vars") }),
  };
}
