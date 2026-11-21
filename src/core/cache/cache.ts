import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as MutableHashMap from "effect/MutableHashMap"
import * as Option from "effect/Option"
import { fn } from "../fn/index.js"

/**
 * `HeraCache.make`: a keyed TTL cache held in memory, one per isolate, holding settled answers only.
 *
 * Invariants:
 *  - The cache holds an answer only once its lookup has settled, as a plain `Exit` stamped with its
 *    expiry by the Effect `Clock`. No fiber, deferred or promise is held, so one `get` never waits on
 *    another caller's work: on workerd each request is its own I/O context, and a request that waits
 *    on work another request started is cancelled by the runtime as hung.
 *  - A miss runs `lookup` in the caller's own fiber. Concurrent misses on one key each look up; the
 *    last to settle is held. A hit within the TTL runs no lookup.
 *  - A success is held for `ttlMs`, a typed failure for `negativeTtlMs` (default `ttlMs`; `0` holds
 *    none), each from when its lookup settled. A defect or an interruption is never held.
 *  - At most `maxEntries` entries; a hit refreshes recency, and an insert past the cap evicts the
 *    least recently used.
 *  - A lookup is a function of its key alone: it requires no service (`R` is `never`), because a held
 *    answer is served to every later caller. Put a tenant in the key.
 *  - Keys compare as `effect/Equal` does: by value for strings and numbers, by reference for plain
 *    objects. Nothing is persisted and the cache does no I/O beyond `lookup`.
 */

/** The cap when `maxEntries` is not given, so a per-isolate cache is never unbounded. */
export const HERA_CACHE_DEFAULT_MAX_ENTRIES = 10_000

export interface HeraCacheOptions<K, V, E> {
  /** How long a value is held, in ms: a positive finite number. */
  readonly ttlMs: number
  /** How long a typed failure is held, in ms (default `ttlMs`; `0` holds none). */
  readonly negativeTtlMs?: number | undefined
  /** The most entries held at once: a positive safe integer (default
   *  `HERA_CACHE_DEFAULT_MAX_ENTRIES`). */
  readonly maxEntries?: number | undefined
  /** Answers a key on a miss, in the caller's fiber. It may fail with `E`; it may not require a service. */
  readonly lookup: (key: K) => Effect.Effect<V, E>
}

/** The cache `HeraCache.make` returns. */
export interface HeraCacheInstance<K, V, E> {
  /** `key`'s held answer, or the caller's own lookup of it. */
  readonly get: (key: K) => Effect.Effect<V, E>
  /** Drops `key`; a lookup already running still answers its caller and is held when it settles. */
  readonly invalidate: (key: K) => Effect.Effect<void>
  /** Drops every key. */
  readonly clear: () => Effect.Effect<void>
}

function assertOptions(ttlMs: number, negativeTtlMs: number, maxEntries: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("HeraCache: ttlMs must be a positive finite number")
  }
  if (!Number.isFinite(negativeTtlMs) || negativeTtlMs < 0) {
    throw new RangeError("HeraCache: negativeTtlMs must be a finite number >= 0")
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new RangeError("HeraCache: maxEntries must be a positive safe integer")
  }
}

interface Held<V, E> {
  readonly exit: Exit.Exit<V, E>
  readonly expiresAt: number
}

/** Builds the cache. Synchronous; throws `RangeError` for an option out of range. */
export function makeHeraCache<K, V, E = never>(options: HeraCacheOptions<K, V, E>): HeraCacheInstance<K, V, E> {
  const ttlMs = options.ttlMs
  const negativeTtlMs = options.negativeTtlMs ?? ttlMs
  const maxEntries = options.maxEntries ?? HERA_CACHE_DEFAULT_MAX_ENTRIES
  assertOptions(ttlMs, negativeTtlMs, maxEntries)

  // Insertion order is recency order: a hit re-inserts its key, so the first key is the least recent.
  const held = MutableHashMap.empty<K, Held<V, E>>()

  const timeToLive = (exit: Exit.Exit<V, E>): number => {
    if (Exit.isSuccess(exit)) return ttlMs
    return Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause) ? 0 : negativeTtlMs
  }

  const hold = (key: K, exit: Exit.Exit<V, E>, now: number): void => {
    const ttl = timeToLive(exit)
    if (ttl === 0) return
    MutableHashMap.remove(held, key)
    MutableHashMap.set(held, key, { exit, expiresAt: now + ttl })
    for (const [oldest] of held) {
      if (MutableHashMap.size(held) <= maxEntries) break
      MutableHashMap.remove(held, oldest)
    }
  }

  return {
    get: fn("HeraCache.get")(function* (key: K) {
      const now = yield* Clock.currentTimeMillis
      const hit = MutableHashMap.get(held, key)
      if (Option.isSome(hit)) {
        MutableHashMap.remove(held, key)
        if (hit.value.expiresAt > now) {
          MutableHashMap.set(held, key, hit.value)
          return yield* hit.value.exit
        }
      }
      const exit = yield* Effect.exit(options.lookup(key))
      hold(key, exit, yield* Clock.currentTimeMillis)
      return yield* exit
    }),
    invalidate: fn("HeraCache.invalidate")(function* (key: K) {
      MutableHashMap.remove(held, key)
    }),
    clear: fn("HeraCache.clear")(function* () {
      MutableHashMap.clear(held)
    }),
  }
}
