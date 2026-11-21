import * as Clock from "effect/Clock";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import {
  broadcastClockAdvance,
  broadcastClockSet,
  durationToMillis,
  isTestClockInstance,
} from "./clock-state.js";

/**
 * Advances Effect v4 `TestClock` and any active test Durable Object SQLite clocks by `duration`
 * (`Duration.Input`, e.g. `"60 seconds"`, `60_000`, `Duration.seconds(60)`).
 */
export function advanceClock(duration: Duration.Input): Effect.Effect<number> {
  return Effect.withFiber((fiber) => {
    const activeClock = fiber.getRef(Clock.Clock);
    if (isTestClockInstance(activeClock)) {
      return activeClock.adjust(duration).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.map((nowMs) => broadcastClockSet(nowMs)),
      );
    }
    const deltaMs = durationToMillis(duration);
    return Effect.sync(() => broadcastClockAdvance(deltaMs));
  });
}

/**
 * Sets Effect v4 `TestClock` and any active test Durable Object SQLite clocks to `timestampMs`.
 */
export function setClock(timestampMs: number): Effect.Effect<number> {
  return Effect.withFiber((fiber) => {
    const activeClock = fiber.getRef(Clock.Clock);
    if (isTestClockInstance(activeClock)) {
      return activeClock
        .setTime(timestampMs)
        .pipe(Effect.map(() => broadcastClockSet(timestampMs)));
    }
    return Effect.sync(() => broadcastClockSet(timestampMs));
  });
}

/**
 * Synchronous helper to advance active test Durable Object clocks by `duration`.
 */
export function advanceClockSync(duration: Duration.Input): number {
  return broadcastClockAdvance(durationToMillis(duration));
}

/**
 * Synchronous helper to set active test Durable Object clocks to `timestampMs`.
 */
export function setClockSync(timestampMs: number): number {
  return broadcastClockSet(timestampMs);
}

/**
 * Reads the current deterministic test timestamp in milliseconds.
 */
export const currentTimeMillis: Effect.Effect<number> = Clock.currentTimeMillis;

/**
 * Executes an Effect with an optional test layer and returns its resolved value as a Promise.
 */
export function runTest<A, E, R = never>(
  effect: Effect.Effect<A, E, R>,
  layer?: Layer.Layer<R>,
): Promise<A> {
  const runnable = (
    layer !== undefined ? Effect.provide(effect, layer) : effect
  ) as Effect.Effect<A, E, never>;
  return Effect.runPromise(runnable);
}

/**
 * Executes an Effect with an optional test layer and returns its `Exit<A, E>` as a Promise.
 */
export function runTestExit<A, E, R = never>(
  effect: Effect.Effect<A, E, R>,
  layer?: Layer.Layer<R>,
): Promise<Exit.Exit<A, E>> {
  const runnable = (
    layer !== undefined ? Effect.provide(effect, layer) : effect
  ) as Effect.Effect<A, E, never>;
  return Effect.runPromiseExit(runnable);
}
