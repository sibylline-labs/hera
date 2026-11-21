/**
 * Types for the atomic `.env` / `.secret.env` (/ `.dev.vars`) set writer
 * (`atomic-pair-writer.ts`).
 */

/** A named step of the pair write; `PairOptions.faults` can fail any of them. */
export type PairStep =
  | "stage"
  | "prev"
  | "open-plain"
  | "write-plain"
  | "open-secret"
  | "write-secret"
  | "chmod-secret"
  | "snapshot-plain"
  | "snapshot-secret"
  | "rename-plain"
  | "rename-secret"
  | "rollback-plain"
  | "rollback-secret"
  | "open-devvars"
  | "write-devvars"
  | "chmod-devvars"
  | "snapshot-devvars"
  | "rename-devvars"
  | "rollback-devvars";

export interface PairOptions {
  /**
   * Fault injection (tests only): a hook that throws (or, before the rename set, returns a
   * rejected promise) fails that step. Inside the synchronous rename set it is called
   * synchronously and a returned promise is not awaited.
   */
  readonly faults?: ((step: PairStep) => void | Promise<void>) | undefined;
}

export interface PairSuccess {
  readonly ok: true;
  readonly envPath: string;
  readonly secretPath: string;
  readonly devVarsPath?: string;
}

export interface PairFailure {
  readonly ok: false;
  /** The operator-facing failure text. */
  readonly message: string;
  /** A rollback failed; the staging dir (named in `stage`) was kept for recovery from `prev/`. */
  readonly critical: boolean;
  /** The staging dir, when one had been created. */
  readonly stage?: string;
}

export type PairResult = PairSuccess | PairFailure;

export type PairBytes = string | Uint8Array;

export interface PairStage {
  /** The service dir the set lands in. */
  readonly dir: string;
  /** `<dir>/.eris-pull.XXXXXX`. */
  readonly path: string;
  /** Write every file and commit them as a set. Consumes the stage. */
  commit(envBytes: PairBytes, secretBytes: PairBytes, devVarsBytes?: PairBytes): Promise<PairResult>;
  /** Remove the stage without committing (the caller failed before commit). */
  discard(): void;
}
