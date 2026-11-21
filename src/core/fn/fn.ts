import * as Effect from "effect/Effect"
import type { SpanOptionsNoTrace } from "effect/Tracer"
import { enrichSpanFromHeraCtx } from "./span-enricher.js"

export type HeraFnHandler<Args extends ReadonlyArray<unknown>, A, E, R> = (
  ...args: Args
) => Effect.Effect<A, E, R>

/**
 * Wraps an Effect-returning function or generator in a named tracing span.
 *
 * Automatically annotates the span with `requestId`/`request_id`, `orgId`/`org_id`,
 * `actorId`/`actor_id`, and `service` whenever `HeraTenantCtx` or `HeraCtx` is present in fiber context,
 * while preserving generator stack-frame capture and pipeable composition.
 *
 * Supports both curried `Hera.fn("Service.op")(function*(...) { ... })` /
 * `Hera.fn("Service.op")((...) => Effect)` and direct `Hera.fn("Service.op", (...) => Effect)`.
 */
export function fn<Args extends ReadonlyArray<unknown>, A, E, R>(
  name: string,
  body: (...args: Args) => Effect.Effect<A, E, R>
): (...args: Args) => Effect.Effect<A, E, R>
export function fn(
  name: string,
  options?: SpanOptionsNoTrace
): Effect.fn.Traced
export function fn(
  name: string,
  bodyOrOptions?:
    | ((
        ...args: ReadonlyArray<never>
      ) => Effect.Effect<unknown, unknown, unknown>)
    | SpanOptionsNoTrace
): unknown {
  if (typeof bodyOrOptions === "function") {
    return (...args: ReadonlyArray<never>) =>
      Effect.withSpan(enrichSpanFromHeraCtx(bodyOrOptions(...args)), name)
  }
  const baseTraced =
    bodyOrOptions !== undefined
      ? Effect.fn(name, bodyOrOptions)
      : Effect.fn(name)
  const callable = baseTraced as unknown as (
    ...callArgs: ReadonlyArray<unknown>
  ) => unknown

  return ((firstArg: unknown, ...rest: ReadonlyArray<unknown>) => {
    if (typeof firstArg === "function") {
      return callable(firstArg, enrichSpanFromHeraCtx, ...rest)
    }
    const [methodBody, ...pipeables] = rest
    return callable(firstArg, methodBody, enrichSpanFromHeraCtx, ...pipeables)
  }) as Effect.fn.Traced
}
