import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { HeraLoggerService } from "../../core/logger/index.js";
import type { HeraCliHookPoint } from "../manifest/types.js";
import type { ErisError } from "../errors/eris-error.js";
import type { Runner } from "../process/runner.js";
import type { HeraCliCtx, HeraCliCtxShape } from "./cli-ctx.js";

/** What a hook function may require: the verb's own ambient services. */
export type HeraCliHookEnv = HeraCliCtx | Runner | HeraLoggerService;

/** One extension's function on one hook point: takes the value, returns the value to pass on. */
export interface HeraCliHookFn<T, A> {
  readonly point: string;
  readonly run: (value: T, args: A, ctx: HeraCliCtxShape) => Effect.Effect<T, ErisError, HeraCliHookEnv>;
}

/** Registers `run` on `point` for an extension whose decoded flags are `A`. */
export function on<T, A>(
  point: HeraCliHookPoint<T>,
  run: (value: T, args: A, ctx: HeraCliCtxShape) => Effect.Effect<T, ErisError, HeraCliHookEnv>,
): HeraCliHookFn<T, A> {
  return { point: point.name, run };
}

export interface HeraCliHooksShape {
  readonly apply: (point: string, value: unknown) => Effect.Effect<unknown, ErisError, HeraCliHookEnv>;
}

/** The hooks the extensions of the running verb registered; absent when nothing extends it. */
export class HeraCliHooks extends Context.Service<HeraCliHooks, HeraCliHooksShape>()(
  "@sibylline-labs/hera/HeraCliHooks",
) {}

/** One loaded extension: its hook functions and its own decoded flags. */
export interface HeraCliBoundExtension {
  readonly hooks: readonly HeraCliHookFn<unknown, unknown>[];
  readonly args: Readonly<Record<string, unknown>>;
}

/** Threads a value through every registered function on a point, in composition order. */
export function makeHooks(extensions: readonly HeraCliBoundExtension[], ctx: HeraCliCtxShape): HeraCliHooksShape {
  return {
    apply: (point, value) => {
      let acc: Effect.Effect<unknown, ErisError, HeraCliHookEnv> = Effect.succeed(value);
      for (const ext of extensions) {
        for (const hook of ext.hooks) {
          if (hook.point !== point) continue;
          acc = Effect.flatMap(acc, (current) => hook.run(current, ext.args, ctx));
        }
      }
      return acc;
    },
  };
}

/**
 * Passes `value` through the extensions registered on `point` and returns what they hand back;
 * with nothing registered (or outside a program run) it returns `value` unchanged. A base handler
 * calls it where an extension may add to a payload or read a receipt.
 */
export function hook<T>(point: HeraCliHookPoint<T>, value: T): Effect.Effect<T, ErisError, HeraCliHookEnv> {
  return Effect.flatMap(Effect.serviceOption(HeraCliHooks), (hooks) =>
    Option.isNone(hooks) ? Effect.succeed(value) : (hooks.value.apply(point.name, value) as Effect.Effect<T, ErisError, HeraCliHookEnv>),
  );
}
