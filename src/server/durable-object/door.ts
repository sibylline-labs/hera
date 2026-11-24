import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { beginHooked } from "../../core/telemetry/hook.js"
import type { HeraTelemetryHook } from "../../core/telemetry/types.js"
import { isHeraRpcInvokeMeta } from "../rpc/invoke-meta.js"

/**
 * Grafts a door invocation's context (its tracer, loggers, log capture and span) onto an effect, so
 * the effect logs and spans inside the door wherever it runs: `Effect.runPromise`, `runSync` or a
 * Durable Object's `runWithTenantCtx`.
 */
export type HeraDoorWithin = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

/** The `traceparent` of a call's trailing marked invoke meta; `undefined` when its last argument is not one. */
function doorTraceparent(callArgs: ReadonlyArray<unknown>): string | undefined {
  const last = callArgs[callArgs.length - 1]
  return isHeraRpcInvokeMeta(last) && typeof last.traceparent === "string" ? last.traceparent : undefined
}

function graft(door: Context.Context<never>): HeraDoorWithin {
  return (effect) => Effect.updateContext(effect, (current) => Context.merge(current, door))
}

/**
 * One door as an invocation `name` of `hook` (the no-op invocation when `undefined`), inside a span
 * of that name, ended with `defect` set from its exit. The body runs with `within` bound to the
 * span's context, which holds only the invocation's references and the span.
 */
function traced<A>(
  hook: HeraTelemetryHook | undefined,
  name: string,
  callArgs: ReadonlyArray<unknown>,
  run: (within: HeraDoorWithin) => Effect.Effect<A>
): Effect.Effect<A> {
  return Effect.suspend(() => {
    const invocation = beginHooked(hook, { name, source: "internal", traceparent: doorTraceparent(callArgs) })
    const body = Effect.flatMap(Effect.context<never>(), (door) => run(graft(door)))
    return invocation
      .provide(Effect.withSpan(body, name))
      .pipe(Effect.onExit((exit) => Effect.sync(() => invocation.end({ defect: Exit.isFailure(exit) }))))
  })
}

/**
 * Runs one Durable Object door, a public method its Worker reaches through a plain stub, as the
 * invocation `name` of `hook`'s telemetry. `callArgs` are the door's trailing arguments: a marked
 * invoke meta last parents the invocation under its `traceparent`; with none it is a fresh root.
 * The promise settles with the body's own value or rejection (no envelope). Every effect the body
 * runs on a fresh runtime goes through `within`, or its lines fall back to the console.
 */
export function runDoor<A>(
  hook: HeraTelemetryHook | undefined,
  name: string,
  callArgs: ReadonlyArray<unknown>,
  body: (within: HeraDoorWithin) => Promise<A>
): Promise<A> {
  // hera-allow: raw-effect-run
  return Effect.runPromise(traced(hook, name, callArgs, (within) => Effect.promise(() => body(within))))
}

/** {@link runDoor} for a synchronous body whose caller needs its value synchronously; a throw is
 *  rethrown as is. The export still settles through `hook.waitUntil`. */
export function runDoorSync<A>(
  hook: HeraTelemetryHook | undefined,
  name: string,
  callArgs: ReadonlyArray<unknown>,
  body: (within: HeraDoorWithin) => A
): A {
  // hera-allow: raw-effect-run
  return Effect.runSync(traced(hook, name, callArgs, (within) => Effect.sync(() => body(within))))
}
