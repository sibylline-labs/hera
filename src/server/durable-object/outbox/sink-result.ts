import * as Effect from "effect/Effect"

/** Lift a sink or hook result (an Effect, a Promise or a plain value) into an Effect. */
export function liftSinkOrHookResult<A>(
  result: Effect.Effect<A, unknown, never> | Promise<A> | A
): Effect.Effect<A, unknown, never> {
  if (Effect.isEffect(result)) {
    return result as Effect.Effect<A, unknown, never>
  }
  if (result instanceof Promise) {
    return Effect.tryPromise({ try: () => result, catch: (err) => err })
  }
  return Effect.succeed(result as A)
}
