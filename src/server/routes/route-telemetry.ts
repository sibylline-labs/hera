import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import { beginHooked, exitIsDefect } from "../../core/telemetry/hook.js"
import type { HeraTelemetryHook, HeraTelemetrySource } from "../../core/telemetry/types.js"

/**
 * Runs one route request as a telemetry invocation: begun before the effect, ended with the
 * response's status (a 5xx or defect promotes the buffer). Without a hook it is a plain run.
 * The caller's `traceparent` is read only for `trace: "internal"`.
 */
export async function runRouteInvocation<A>(
  request: Request,
  name: string,
  options: { readonly telemetry?: HeraTelemetryHook | undefined; readonly trace?: HeraTelemetrySource | undefined } | undefined,
  effect: Effect.Effect<A, unknown, never>,
  respond: (exit: Exit.Exit<A, unknown>) => Response
): Promise<Response> {
  const invocation = beginHooked(options?.telemetry, {
    name,
    source: options?.trace ?? "external",
    traceparent: request.headers.get("traceparent") ?? undefined,
  })
  // hera-allow: raw-effect-run
  const exit = await Effect.runPromiseExit(invocation.provide(effect))
  const response = respond(exit)
  invocation.end({ status: response.status, defect: exitIsDefect(exit) })
  return response
}
