/**
 * The atomic `.env` / `.secret.env` set writer (plus `.dev.vars` when the caller hands bytes for
 * it). Either every new file lands, or the previous set is still on disk byte-identical, modes and
 * mtimes included:
 *
 *   1. a private staging dir `<dir>/.eris-pull.XXXXXX/` (`0700`, from `mkdtemp`) + `prev/`;
 *   2. every file written inside it under its FINAL basename, so a stage leaked by SIGKILL is
 *      hidden by the bare `.env` / `.secret.env` / `.dev.vars` patterns a consumer's `.gitignore`
 *      already carries. The `.eris-pull.` prefix is a name sweepers read;
 *   3. `.env` at the umask default (never a hardcoded mode); `.secret.env` and `.dev.vars`
 *      chmod `0600` before they are renamed into place;
 *   4. the existing set snapshotted into `prev/` (`cp -p`: bytes, mode, mtime);
 *   5. the renames in order (`.env`, `.secret.env`, `.dev.vars`); a failed rename rolls every
 *      earlier one back from the snapshot (or removes an orphaned new file), and restores a target
 *      the failed rename lost;
 *   6. the staging dir removed.
 *
 * Any failure removes the stage, except a failed rollback: that result is `critical` and the stage
 * is kept, because its `prev/` snapshot is the operator's recovery source.
 *
 * While a stage exists, SIGINT / SIGTERM / SIGHUP remove it (`pair-signals.ts`). The rename set
 * and its rollback run synchronously, so no signal lands between two renames.
 *
 * Nothing here prints: a failure is a value carrying the operator-facing message.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { ErrorSlug } from "../../core/schema/index.js";
import { ErisError } from "../errors/eris-error.js";
import { commitPair } from "./pair-commit.js";
import { guardStage } from "./pair-signals.js";
import type {
  PairBytes,
  PairFailure,
  PairOptions,
  PairResult,
  PairStage,
  PairStep,
  PairSuccess,
} from "./pair-types.js";

export type {
  PairBytes,
  PairFailure,
  PairOptions,
  PairResult,
  PairStage,
  PairStep,
  PairSuccess,
} from "./pair-types.js";

/**
 * Creates the staging dir (before the caller fetches anything, so a failure here costs no remote
 * call). The stage is removed on a signal from now until `commit` or `discard`.
 */
export async function stagePair(
  dir: string,
  opts: PairOptions = {},
): Promise<{ readonly ok: true; readonly stage: PairStage } | PairFailure> {
  let guard: ReturnType<typeof guardStage> | undefined;
  const hook = async (step: PairStep) => {
    try {
      await opts.faults?.(step);
    } catch {
      throw new Error(step);
    }
    // A signal removed the stage while this step ran and the process is exiting 128+signal:
    // carrying on would write into the deleted stage and report a bogus write failure first.
    if (guard?.isSignalled()) await new Promise<never>(() => {});
  };

  let path: string;
  try {
    await hook("stage");
    path = mkdtempSync(join(dir, ".eris-pull."));
  } catch {
    return { ok: false, message: `Failed to create a staging dir in ${dir}`, critical: false };
  }

  const live = guardStage(path);
  guard = live;
  const fail = (message: string): PairFailure => {
    live.remove();
    return { ok: false, message, critical: false, stage: path };
  };

  try {
    await hook("prev");
    mkdirSync(join(path, "prev"));
  } catch {
    return fail(`Failed to create ${path}/prev`);
  }

  const stage: PairStage = {
    dir,
    path,
    discard: () => {
      if (live.isLive()) live.remove();
    },
    commit: (envBytes, secretBytes, devVarsBytes) =>
      commitPair({ dir, stagePath: path, guard: live, opts, hook, fail }, envBytes, secretBytes, devVarsBytes),
  };
  return { ok: true, stage };
}

/** Stage, then commit, for a caller with nothing to do in between. */
export async function writePair(
  dir: string,
  envBytes: PairBytes,
  secretBytes: PairBytes,
  opts: PairOptions = {},
  devVarsBytes?: PairBytes,
): Promise<PairResult> {
  const staged = await stagePair(dir, opts);
  if (!staged.ok) return staged;
  return staged.stage.commit(envBytes, secretBytes, devVarsBytes);
}

export interface PairWriteInput {
  readonly dir: string;
  readonly env: PairBytes;
  readonly secret: PairBytes;
  readonly devVars?: PairBytes | undefined;
  readonly options?: PairOptions | undefined;
}

function pairFailure(r: PairFailure, cause?: unknown): ErisError {
  const slug = r.critical ? "pair-writer-rollback-failed" : "pair-writer-failed";
  return ErisError.operational(ErrorSlug.make(slug), { what: r.message, cause });
}

/**
 * `writePair` as an Effect: fails with `ErisError` `pair-writer-failed`, or
 * `pair-writer-rollback-failed` when a rollback failed and the stage was kept for recovery.
 */
export function writePairEffect(input: PairWriteInput): Effect.Effect<PairSuccess, ErisError> {
  return Effect.tryPromise({
    try: () => writePair(input.dir, input.env, input.secret, input.options, input.devVars),
    catch: (cause) =>
      pairFailure({ ok: false, message: `Failed to write the env set in ${input.dir}`, critical: false }, cause),
  }).pipe(Effect.flatMap((r) => (r.ok ? Effect.succeed(r) : Effect.fail(pairFailure(r)))));
}

export const AtomicPairWriter = {
  stage: stagePair,
  writePair,
  write: writePairEffect,
} as const;
