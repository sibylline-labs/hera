import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import { createHeraLogger } from "../logger/logger.js"
import { resolveTelemetryConfig } from "./config.js"
import { beginInvocation, NOOP_INVOCATION } from "./invocation.js"
import type {
  HeraTelemetry as HeraTelemetryShape,
  HeraTelemetryBeginOptions,
  HeraTelemetryConfig,
  HeraTelemetryInvocation,
} from "./types.js"

/**
 * The isolate's telemetry. Construction validates the config and does nothing else: no I/O, no
 * timer. Without a token, every invocation is a no-op and the first `begin`
 * writes one `hera.telemetry.unconfigured` warning, so the missing secret shows on the runtime's
 * log backstop while the logger keeps its console sink.
 */
function make(config: HeraTelemetryConfig): HeraTelemetryShape {
  const resolved = resolveTelemetryConfig(config)
  const state = { warned: false }
  const boot = createHeraLogger({ service: resolved.service, events: ["hera.telemetry.unconfigured"] as const })
  return {
    service: resolved.service,
    configured: resolved.target !== undefined,
    begin(options: HeraTelemetryBeginOptions): HeraTelemetryInvocation {
      if (resolved.target !== undefined) return beginInvocation(resolved, options)
      if (!state.warned) {
        state.warned = true
        boot.sync.warn("hera.telemetry.unconfigured")
      }
      return NOOP_INVOCATION
    },
  }
}

/** Begins an invocation for the scope and ends it, with `defect` set from the scope's exit, on close. */
function scoped(
  telemetry: HeraTelemetryShape,
  options: HeraTelemetryBeginOptions
): Effect.Effect<HeraTelemetryInvocation, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => telemetry.begin(options)),
    (invocation, exit) => Effect.sync(() => invocation.end({ defect: Exit.isFailure(exit) }))
  )
}

/**
 * Runs `effect` as one invocation: traced, logged and exported on exit. For code that owns its own
 * runner (a `scheduled` handler, a script); Hera's boundaries do this themselves given a hook.
 */
function run<A, E, R>(
  telemetry: HeraTelemetryShape,
  options: HeraTelemetryBeginOptions,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    const invocation = telemetry.begin(options)
    return invocation.provide(effect).pipe(
      Effect.onExit((exit) => Effect.sync(() => invocation.end({ defect: Exit.isFailure(exit) })))
    )
  })
}

/** A layer whose scope is one invocation: provide it around a program to trace and export it. */
function layer(telemetry: HeraTelemetryShape, options: HeraTelemetryBeginOptions): Layer.Layer<never> {
  return Layer.effectDiscard(scoped(telemetry, options))
}

export const HeraTelemetry = { make, scoped, run, layer } as const
