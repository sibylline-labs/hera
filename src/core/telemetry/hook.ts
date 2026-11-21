import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import { NOOP_INVOCATION } from "./invocation.js"
import type { HeraTelemetryHook, HeraTelemetryInvocation, HeraTelemetrySource } from "./types.js"

/** The invocation a boundary runs under: the hook's, or the no-op one when no hook was given. */
export function beginHooked(
  hook: HeraTelemetryHook | undefined,
  options: { readonly name: string; readonly source: HeraTelemetrySource; readonly traceparent?: string | undefined }
): HeraTelemetryInvocation {
  return hook === undefined ? NOOP_INVOCATION : hook.telemetry.begin({ ...options, waitUntil: hook.waitUntil })
}

/** True when `exit` died or was interrupted: the boundary's defect signal for promotion. */
export function exitIsDefect(exit: Exit.Exit<unknown, unknown>): boolean {
  return Exit.isFailure(exit) && (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
}
