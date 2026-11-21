import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { ErrorSlug } from "../../core/schema/index.js";
import { ErisError } from "../errors/eris-error.js";

export const DEFAULT_POOL_CONCURRENCY = 8;
export const MAX_POOL_CONCURRENCY = 64;
export const DEFAULT_POOL_DEADLINE_MS = 60_000;

export interface ForEachBoundedOptions<
  Mode extends "failFast" | "validate" = "failFast",
> {
  readonly concurrency?: number | undefined;
  readonly envVar?: string | undefined;
  readonly defaultConcurrency?: number | undefined;
  readonly maxConcurrency?: number | undefined;
  readonly deadlineMs?: number | undefined;
  readonly deadlineEnvVar?: string | undefined;
  readonly defaultDeadlineMs?: number | undefined;
  readonly mode?: Mode | undefined;
}

export interface BoundedPoolItemSuccess<R> {
  readonly status: "fulfilled";
  readonly value: R;
  readonly index: number;
}

export interface BoundedPoolItemFailure<E> {
  readonly status: "rejected";
  readonly error: E;
  readonly index: number;
}

export type BoundedPoolItemOutcome<R, E> =
  | BoundedPoolItemSuccess<R>
  | BoundedPoolItemFailure<E>;

export interface BoundedPoolValidateReport<R, E> {
  readonly outcomes: ReadonlyArray<BoundedPoolItemOutcome<R, E>>;
  readonly successes: ReadonlyArray<R>;
  readonly failures: ReadonlyArray<BoundedPoolItemFailure<E>>;
}

function parsePositiveInt(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : null;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isSafeInteger(n) && n >= 1 ? n : null;
  }
  return null;
}

/**
 * Resolves bounded pool concurrency (`opts.concurrency` -> `env[opts.envVar]` -> `defaultConcurrency ?? 8`),
 * clamped to `[1, maxConcurrency ?? 64]`.
 */
export function resolveConcurrency(
  opts: {
    readonly concurrency?: number | undefined;
    readonly envVar?: string | undefined;
    readonly defaultConcurrency?: number | undefined;
    readonly maxConcurrency?: number | undefined;
  } = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const cap = parsePositiveInt(opts.maxConcurrency) ?? MAX_POOL_CONCURRENCY;
  const fallback = Math.min(
    cap,
    parsePositiveInt(opts.defaultConcurrency) ?? DEFAULT_POOL_CONCURRENCY,
  );
  const direct = parsePositiveInt(opts.concurrency);
  if (direct !== null) {
    return Math.min(cap, Math.max(1, direct));
  }
  if (opts.envVar) {
    const fromEnv = parsePositiveInt(env[opts.envVar]);
    if (fromEnv !== null) {
      return Math.min(cap, Math.max(1, fromEnv));
    }
  }
  return Math.max(1, fallback);
}

/**
 * Resolves a whole-pool deadline in milliseconds (`opts.deadlineMs` -> `env[opts.deadlineEnvVar]` -> `defaultDeadlineMs ?? 60_000`).
 *
 * `deadlineMs` and `defaultDeadlineMs` are milliseconds. The env var is integer seconds, as eris's
 * `ERIS_BATCH_TIMEOUT` is (`60` -> `60_000` ms); an unset, non-integer, zero or negative value falls
 * back to the default, never to "no deadline".
 */
export function resolveDeadlineMs(
  opts: {
    readonly deadlineMs?: number | undefined;
    readonly deadlineEnvVar?: string | undefined;
    readonly defaultDeadlineMs?: number | undefined;
  } = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const fallback =
    parsePositiveInt(opts.defaultDeadlineMs) ?? DEFAULT_POOL_DEADLINE_MS;
  const direct = parsePositiveInt(opts.deadlineMs);
  if (direct !== null) return direct;
  if (opts.deadlineEnvVar) {
    const fromEnvSeconds = parsePositiveInt(env[opts.deadlineEnvVar]);
    if (fromEnvSeconds !== null) return fromEnvSeconds * 1000;
  }
  return fallback;
}

/**
 * Structured concurrency helper wrapping `Effect.forEach(items, fn, { concurrency })`.
 *
 * - `mode: "failFast"` (default): fails on the first item error and automatically
 *   interrupts sibling in-flight fibers via Effect structured concurrency.
 * - `mode: "validate"`: runs all items up to `concurrency` and collects both
 *   `successes` and `failures` without short-circuiting.
 */
export function forEachBounded<T, A, E, R>(
  items: Iterable<T>,
  fn: (item: T, index: number) => Effect.Effect<A, E, R>,
  options?: ForEachBoundedOptions<"failFast">,
): Effect.Effect<Array<A>, E | ErisError, R>;
export function forEachBounded<T, A, E, R>(
  items: Iterable<T>,
  fn: (item: T, index: number) => Effect.Effect<A, E, R>,
  options: ForEachBoundedOptions<"validate">,
): Effect.Effect<BoundedPoolValidateReport<A, E>, ErisError, R>;
export function forEachBounded<
  T,
  A,
  E,
  R,
  Mode extends "failFast" | "validate" = "failFast",
>(
  items: Iterable<T>,
  fn: (item: T, index: number) => Effect.Effect<A, E, R>,
  options: ForEachBoundedOptions<Mode> = {},
): Effect.Effect<
  Mode extends "validate" ? BoundedPoolValidateReport<A, E> : Array<A>,
  E | ErisError,
  R
> {
  const concurrency = resolveConcurrency(options);
  const mode = options.mode ?? "failFast";
  const arr = Array.from(items);

  const applyDeadline = <Out, Err>(
    eff: Effect.Effect<Out, Err, R>,
  ): Effect.Effect<Out, Err | ErisError, R> => {
    if (
      options.deadlineMs === undefined &&
      options.deadlineEnvVar === undefined
    ) {
      return eff;
    }
    const deadlineMs = resolveDeadlineMs(options);
    return eff.pipe(
      Effect.timeoutOption(deadlineMs),
      Effect.flatMap((opt) =>
        Option.isSome(opt)
          ? Effect.succeed(opt.value)
          : Effect.fail(
              ErisError.timeout(ErrorSlug.make("pool-deadline-exceeded"), {
                what: `Concurrent pool timed out after ${deadlineMs}ms`,
                fix: "Retry the command or increase the pool deadline.",
              }),
            ),
      ),
    );
  };

  if (mode === "validate") {
    const validateEffect = Effect.forEach(
      arr,
      (item, index) =>
        Effect.exit(fn(item, index)).pipe(
          Effect.map((exit): BoundedPoolItemOutcome<A, E> => {
            if (Exit.isSuccess(exit)) {
              return { status: "fulfilled", value: exit.value, index };
            }
            const errOpt = Cause.findErrorOption(exit.cause);
            if (Option.isSome(errOpt)) {
              return { status: "rejected", error: errOpt.value, index };
            }
            return {
              status: "rejected",
              error: ErisError.operational(
                ErrorSlug.make("pool-item-defect"),
                {
                  what: "Concurrent pool item terminated with an unexpected defect",
                },
              ) as unknown as E,
              index,
            };
          }),
        ),
      { concurrency },
    ).pipe(
      Effect.map((outcomes): BoundedPoolValidateReport<A, E> => {
        const successes: A[] = [];
        const failures: BoundedPoolItemFailure<E>[] = [];
        for (const outcome of outcomes) {
          if (outcome.status === "fulfilled") {
            successes.push(outcome.value);
          } else {
            failures.push(outcome);
          }
        }
        return { outcomes, successes, failures };
      }),
    );

    return applyDeadline(validateEffect) as Effect.Effect<
      Mode extends "validate" ? BoundedPoolValidateReport<A, E> : Array<A>,
      E | ErisError,
      R
    >;
  }

  const failFastEffect = Effect.forEach(arr, (item, index) => fn(item, index), {
    concurrency,
  });

  return applyDeadline(failFastEffect) as Effect.Effect<
    Mode extends "validate" ? BoundedPoolValidateReport<A, E> : Array<A>,
    E | ErisError,
    R
  >;
}
