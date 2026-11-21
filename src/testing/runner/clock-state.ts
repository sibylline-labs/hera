import * as Duration from "effect/Duration";
import type * as TestClock from "effect/testing/TestClock";
import { DEFAULT_TEST_TIME_MS } from "../fixtures/sample-ids.js";

export interface ActiveClockSubscriber {
  getTimeMs: () => number;
  setTimeMs: (timestampMs: number) => void;
}

const activeClockSubscribers = new Set<ActiveClockSubscriber>();
let sharedFallbackClockMs = DEFAULT_TEST_TIME_MS;

export function registerClockSubscriber(sub: ActiveClockSubscriber): void {
  activeClockSubscribers.add(sub);
}

export function getSharedFallbackClockMs(): number {
  return sharedFallbackClockMs;
}

export function setSharedFallbackClockMs(timestampMs: number): void {
  sharedFallbackClockMs = Math.round(timestampMs);
}

export function durationToMillis(input: Duration.Input): number {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  const duration = Duration.fromInputUnsafe(input);
  const ms = Duration.toMillis(duration);
  return Number.isFinite(ms) ? ms : 0;
}

export function broadcastClockSet(timestampMs: number): number {
  const normalized = Math.round(timestampMs);
  sharedFallbackClockMs = normalized;
  for (const sub of activeClockSubscribers) {
    sub.setTimeMs(normalized);
  }
  return normalized;
}

export function broadcastClockAdvance(deltaMs: number): number {
  const roundedDelta = Math.round(deltaMs);
  let nextMs = sharedFallbackClockMs + roundedDelta;
  sharedFallbackClockMs = nextMs;
  for (const sub of activeClockSubscribers) {
    const updated = sub.getTimeMs() + roundedDelta;
    sub.setTimeMs(updated);
    nextMs = updated;
  }
  return nextMs;
}

export function isTestClockInstance(
  clock: unknown,
): clock is TestClock.TestClock {
  return (
    typeof clock === "object" &&
    clock !== null &&
    typeof (clock as { readonly adjust?: unknown }).adjust === "function" &&
    typeof (clock as { readonly setTime?: unknown }).setTime === "function"
  );
}
