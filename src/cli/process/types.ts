import type * as Effect from "effect/Effect";
import type { ErisError } from "../errors/eris-error.js";

export interface RunSpec {
  readonly cmd: string;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly stdin?: string | Uint8Array | undefined;
  readonly timeoutMs?: number | undefined;
  readonly killGraceMs?: number | undefined;
  readonly streamStderr?: boolean | ((chunk: string) => void) | undefined;
  readonly streamStdout?: boolean | ((chunk: string) => void) | undefined;
}

export interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly escalated?: boolean | undefined;
  readonly pid?: number | undefined;
}

export type RunCommandOptions = RunSpec;
export type RunCommandResult = RunResult;

export interface RunnerShape {
  readonly run: (spec: RunSpec) => Effect.Effect<RunResult, ErisError>;
  readonly runPromise: (spec: RunSpec) => Promise<RunResult>;
}
