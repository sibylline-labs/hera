# Rate Limiting (`HeraRateLimit`)

`HeraRateLimit` (`src/core/rate-limit/`, `src/server/rate-limit/`, exported from `@sibylline-labs/hera` and `@sibylline-labs/hera/server`) is one token bucket with three places to keep it, plus a keyed, bounded map of them. Every limiter refuses with the catalog code `rate_limited` (HTTP 429) and a `retryAfter` in whole seconds, rounded up and never below 1, so a route boundary answers with `Retry-After` and `retry_after` without extra code ([ERRORS.md](../ERRORS.md)).

| Member | Keeps the bucket | Returns | Use it for |
|---|---|---|---|
| `bucket(limit)` | nowhere: pure arithmetic | plain values | a decision you store yourself, or a multi-bucket rule |
| `memory(limit)` | the isolate's memory, timed by the Effect `Clock` | `Effect<void, HeraError>` | a flood guard that may reset when the object restarts |
| `keyed(limit, { maxKeys })` | the isolate's memory: one bucket per key, at most `maxKeys` keys | plain values | a per-caller flood guard (one bucket per submitting org) whose key space a caller controls |
| `sqlStore(tx, key, { ...limit, now })` | a row in the tenant object's SQLite | `SyncEffect<void, HeraError \| HeraSqlError>` | a budget that must survive eviction |
| `binding(env.X, key, options?)` | Cloudflare's `ratelimits` binding | `Effect<void, HeraError>` | the edge shed before any token work; fails open, or closed with `onUnavailable: "refuse"` |

A limit is `{ capacity, refillPerSecond }`: a bucket holds at most `capacity` tokens and refills continuously. A key never held starts full. A spend larger than `capacity` can never be admitted, so `memory` and `sqlStore` die with a `RangeError` for it rather than refuse.

---

## 1. Pure arithmetic: `bucket`

`refill`, `waitMs`, `take` and `drained` are pure arithmetic. A clock reading earlier than the bucket's stamp neither adds nor removes tokens, and `tokens` may go negative: a drained bucket pays its debt back before it admits again.

```ts
import { HeraRateLimit } from "@sibylline-labs/hera"

const perToken = HeraRateLimit.bucket({ capacity: 600, refillPerSecond: 10 })

const now = Date.now()
const current = perToken.refill(undefined, now) // { tokens: 600, updatedAt: now }
const wait = perToken.waitMs(current) // 0: admitted
const next = perToken.take(current)
const exhausted = perToken.drained(30, now) // next token in exactly 30 s

// The refusal every limiter raises, for a wait you computed yourself.
const refused = HeraRateLimit.refusal(perToken.waitMs(exhausted)) // rate_limited, retryAfter 30
```

## 2. In memory: `memory`

`take(tokens = 1)` reads `Clock.currentTimeMillis`, so `HeraTest.advanceClock` refills it in tests. The read, the decision and the write are one synchronous step, so two fibers never both spend the last token. The bucket is never stored: a restarted object starts it full.

```ts
import * as Effect from "effect/Effect"
import { Hera, HeraRateLimit } from "@sibylline-labs/hera"

const reads = HeraRateLimit.memory({ capacity: 3000, refillPerSecond: 50 })

export const readReceipt = Hera.fn("Yak.readReceipt")(function* () {
  yield* reads.take() // fails rate_limited when the bucket is empty
  return yield* Effect.succeed("receipt")
})
```

## 3. Keyed and bounded: `keyed`

`keyed(limit, { maxKeys })` holds one bucket per key, every bucket bound to the same limit, and never more than `maxKeys` keys. A bucket that has refilled to `capacity` is the same as an absent one, so a new key that meets the cap first drops those; if that frees no room, the new key is refused as `full`, with the wait until the soonest held bucket is full again. A key the map already holds is never refused for room. Like `bucket`, it is plain values with the clock as an argument, and nothing is stored: a restarted object starts every key full.

`spend(key, now, tokens = 1)` decides and takes in one step: `null` admits, otherwise `{ reason: "key" | "full", waitMs }` and nothing is taken.

```ts
import { HeraRateLimit } from "@sibylline-labs/hera"

const perOrg = HeraRateLimit.keyed({ capacity: 600, refillPerSecond: 10 }, { maxKeys: 1024 })

export function admitOrg(orgId: string, now: number) {
  const refused = perOrg.spend(orgId, now)
  if (refused !== null) throw HeraRateLimit.refusal(refused.waitMs)
}
```

When one admission spends two buckets together (an org's own bucket and a backstop every org shares), use `read` and `write`: `read` answers the key's bucket refilled to `now` (or `full`) and stores nothing, and `write` stores the spent bucket once every bucket has admitted. Run them in one synchronous step: a key written in between can fill the cap, and `write` then throws `RangeError` rather than exceed it.

```ts
import { type HeraBucket, HeraRateLimit } from "@sibylline-labs/hera"

const perOrg = HeraRateLimit.keyed({ capacity: 600, refillPerSecond: 10 }, { maxKeys: 1024 })
const backstop = HeraRateLimit.bucket({ capacity: 3000, refillPerSecond: 50 })
let shared: HeraBucket | undefined

/** Zero admits and spends both buckets; otherwise the wait, and neither is spent. */
export function admitForeign(orgId: string, now: number): number {
  const own = perOrg.read(orgId, now)
  if (own.kind === "full") return own.waitMs
  const ownWait = perOrg.waitMs(own.bucket)
  if (ownWait > 0) return ownWait
  const pool = backstop.refill(shared, now)
  const poolWait = backstop.waitMs(pool)
  if (poolWait > 0) return poolWait
  perOrg.write(orgId, perOrg.take(own.bucket))
  shared = backstop.take(pool)
  return 0
}
```

An invalid limit, a `maxKeys` that is not a positive safe integer, or a spend larger than `capacity` throws `RangeError`.

## 4. In the tenant object's SQLite: `sqlStore`

`sqlStore` spends from the row stored under `key`, inside the caller's `transactSync`. A refusal fails the transaction, so it writes nothing, and two keys spent in one transaction are admitted together or not at all. Pass the object's own clock as `now`: the transaction body runs on its own runtime, where `Clock` is wall time.

The default table is `hera_rate_limit_buckets` (`key TEXT PRIMARY KEY, tokens REAL, updated_at INTEGER`), created by the first spend. `table` names another table of that shape, so an existing bucket table keeps its rows.

```ts
import { Hera, HeraRateLimit } from "@sibylline-labs/hera"

class OrgDO extends Hera.TenantDurableObject.configure({ service: "accounts", migrations: [] }) {
  spendBudget(tokenId: string, product: string) {
    const now = this.now()
    return this.db.transactSync((tx) =>
      tx.gen(function* () {
        yield* HeraRateLimit.sqlStore(tx, `token:${tokenId}`, {
          capacity: 600,
          refillPerSecond: 10,
          now,
          table: "buckets",
        })
        yield* HeraRateLimit.sqlStore(tx, `product:${product}`, {
          capacity: 3000,
          refillPerSecond: 50,
          now,
          table: "buckets",
        })
      })
    )
  }
}
```

A refusal carries the wait of the first key that refused; a key after it is not read. The refusal names no key, since keys reach no log or wire field. An invalid limit, a `now` that is not finite, or an unsafe `table` dies with a `RangeError`.

## 5. Cloudflare `RateLimit` binding: `binding`

`binding(limiter, key, options?)` counts `key` against a `ratelimits` binding. A refusal carries `retryAfterSeconds` (default 60, the binding's longest `simple.period`). By default, a binding that throws, or is missing from `env`, fails open: the call is admitted and exactly one error line is written, through the ambient `HeraLoggerService` when the layer provides one. `logEvent` names that line (default `hera.rate_limit.binding_unavailable`). The key is never logged, because it can be a client address or an unauthenticated org claim.

A caller that must not admit on a missing budget passes `onUnavailable: "refuse"`: an unavailable binding writes the same line and then fails with `HeraError.serviceUnavailable` (503). `code` names the refusal (default `service_unavailable`; any catalog code or `<name>_unavailable`) and `publicMessage` its `detail` (default `Service unavailable`). The default, `"admit"`, is the fail-open path above; `code` and `publicMessage` type-check only beside `"refuse"`.

```ts
import { Hera, HeraRateLimit, type HeraRateLimitBinding } from "@sibylline-labs/hera"

declare const env: { readonly EDGE_LIMITER?: HeraRateLimitBinding }

export const shed = Hera.fn("Gateway.shedL1")(function* (key: string) {
  yield* HeraRateLimit.binding(env.EDGE_LIMITER, key, {
    retryAfterSeconds: 60,
    logEvent: "gateway.l1_unavailable",
  })
})
```

```ts
import { Hera, HeraRateLimit, type HeraRateLimitBinding } from "@sibylline-labs/hera"

declare const env: { readonly GATES_LIMITER?: HeraRateLimitBinding }

export const spend = Hera.fn("Gates.spend")(function* (orgId: string) {
  yield* HeraRateLimit.binding(env.GATES_LIMITER, orgId, {
    onUnavailable: "refuse",
    code: "gates_unavailable",
    publicMessage: "The gates budget is unavailable",
    logEvent: "gates.limiter_unavailable",
  })
})
```

## 6. Testing

```ts
import * as Effect from "effect/Effect"
import { HeraRateLimit } from "@sibylline-labs/hera"
import { HeraTest } from "@sibylline-labs/hera/testing"

const limiter = HeraRateLimit.memory({ capacity: 1, refillPerSecond: 1 })

export const refills = HeraTest.runTest(
  Effect.gen(function* () {
    yield* limiter.take()
    yield* HeraTest.advanceClock("1 second")
    yield* limiter.take() // admitted: one token refilled
  }),
  HeraTest.layer()
)
```

For `sqlStore`, reuse one `sqliteDb` across two `makeTestDurableObjectState` calls to model an eviction ([testing guide](testing.md)).
