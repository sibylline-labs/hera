# Caching (`HeraCache`)

`HeraCache` (`src/core/cache/`, exported from `@sibylline-labs/hera` and `@sibylline-labs/hera/core`) is a keyed TTL cache held in memory, one per isolate or Durable Object. It holds settled answers only (an `Exit` and its expiry), never a running lookup, so no caller ever waits on another caller's work; it adds the failure policy, LRU eviction and `Hera.fn` spans. It does no I/O of its own: every value comes from the `lookup` you give it.

```ts
import { HeraCache } from "@sibylline-labs/hera"
import * as Effect from "effect/Effect"

declare const fetchTeamId: (orgAndKey: string) => Effect.Effect<string, "not_found">

const teams = HeraCache.make({
  ttlMs: 5 * 60_000, // a value is held five minutes
  negativeTtlMs: 30_000, // a `not_found` is held thirty seconds (default: ttlMs)
  maxEntries: 1_000, // default HeraCache.DEFAULT_MAX_ENTRIES (10 000)
  lookup: fetchTeamId,
})

// The tenant is part of the key: a lookup may not read the caller's services.
export const teamId = (orgId: string, key: string) => teams.get(`${orgId}:${key}`)
```

| Member | Returns | Does |
|---|---|---|
| `HeraCache.make(options)` | `HeraCacheInstance<K, V, E>` | builds the cache synchronously; throws `RangeError` for an option out of range |
| `get(key)` | `Effect<V, E>` | the held answer, or the caller's own lookup of `key` |
| `invalidate(key)` | `Effect<void>` | drops `key`; a lookup already running still answers its caller and is held when it settles |
| `clear()` | `Effect<void>` | drops every key |

## Semantics

| Case | What the cache does |
|---|---|
| Hit within `ttlMs` | answers the held value; no lookup. The TTL runs from when the lookup **completed** |
| Concurrent misses on one key | each runs `lookup` in its own fiber; the last to settle is held. There is no single flight: on Workers each request is its own I/O context, and a request resumed from another request's lookup keeps running in that request's context, so its later I/O dies with it and the runtime cancels it as hung |
| Typed failure `E` | held for `negativeTtlMs` (default `ttlMs`), then looked up again; `negativeTtlMs: 0` holds none |
| Defect, or the lookup interrupted (its caller interrupted) | never held; the next `get` looks up again |
| At `maxEntries` | a hit refreshes recency; an insert past the cap evicts the least recently used entry |
| Isolate restart | the cache starts empty; nothing is persisted |

Options: `ttlMs` is a positive finite number, `negativeTtlMs` a finite number `>= 0`, and `maxEntries` a positive safe integer.

**A lookup is a function of its key alone.** Its type is `(key: K) => Effect<V, E>` with no services, because a held answer is served to every later caller: a lookup that read `HeraTenantCtx` would hand one tenant's answer to another. An optional read (`Effect.serviceOption`, a `Hera.fn` span inside the lookup) still sees the calling fiber's. Put the tenant (org id) in the key, and close over clients and tokens when you build the cache.

**Keys compare as `effect/Equal` does**: strings and numbers by value, plain objects by reference. Key by a string such as `` `${orgId}:${kind}:${name}` ``.

## Testing

`get` reads the Effect `Clock`, so `HeraTest.advanceClock` expires entries in tests:

```ts
import { HeraCache } from "@sibylline-labs/hera"
import { HeraTest } from "@sibylline-labs/hera/testing"
import * as Effect from "effect/Effect"

let lookups = 0
const cache = HeraCache.make({ ttlMs: 60_000, lookup: (key: string) => Effect.sync(() => (lookups++, key.length)) })

export const expiry = HeraTest.runTest(
  Effect.gen(function* () {
    yield* cache.get("ab") // lookups === 1
    yield* HeraTest.advanceClock("59 seconds")
    yield* cache.get("ab") // still 1: held
    yield* HeraTest.advanceClock("1 second")
    yield* cache.get("ab") // 2: expired and looked up again
  }),
  HeraTest.layer()
)
```

## In Hera

`HeraConfig.managedVariables` holds each variable's read in a `HeraCache` keyed by name ([schema and config](schema-and-config.md)), so a variable costs one Logfire call per TTL once held; misses that overlap each make their own call.
