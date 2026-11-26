# Feature Flags (`HeraFlags`)

`HeraFlags` (`src/core/flags/`, exported from `@sibylline-labs/hera`, `@sibylline-labs/hera/core` and `@sibylline-labs/hera/flags`) reads per-org feature flags. It reads them from Logfire managed variables over the OpenFeature Remote Evaluation Protocol (OFREP), with the org as the targeting key. Each read names a code fallback, and a read never fails: when Logfire cannot answer, the caller gets the fallback and one warn line.

```ts
import { HeraFlags } from "@sibylline-labs/hera"
import * as Effect from "effect/Effect"
import { Redacted } from "effect"

declare const token: Redacted.Redacted<string> | undefined
declare const orgId: string

// Build one reader per holder (a Durable Object instance, or a request), never at module scope.
const flags = HeraFlags.ofrep({
  token, // a Logfire API key with project:read_variables; undefined reads every flag as its fallback
  base: "https://logfire-us.pydantic.dev", // required: the token goes only to the host it was minted for
})

export const inferenceEnabled = flags.bool("inference-enabled", { targetingKey: orgId }, false)
```

| Member | Returns | Does |
|---|---|---|
| `HeraFlags.ofrep(options)` | `HeraFlagReader` | builds a reader over Logfire's OFREP bulk endpoint; does no I/O until the first read |
| `bool(name, ctx, fallback)` | `Effect<boolean>` | the flag as a boolean for `ctx`, or `fallback` |
| `value(name, schema, ctx, fallback)` | `Effect<T>` | the flag decoded through `schema`, or `fallback` |
| `evaluate(name, schema, ctx, fallback)` | `Effect<HeraFlagValue<T>>` | as `value`, tagged `source: "flag"` (with the `variant`) or `source: "fallback"` (with the `reason`) |
| `HeraFlags.fromSource(source, options?)` | `HeraFlagReader` | the same reader over any `(ctx) => Effect<HeraFlagSnapshot>` source; `options` is `{ warnWindowMs?, maxContexts? }` |

## Targeting

`ctx` is `{ targetingKey, attributes? }`. Pass the org ULID as `targetingKey`. HeraFlags also sends it as the `org_id` attribute, unless you set `attributes.org_id` yourself. That matters because Logfire matches override conditions on attributes. In Logfire, target an org with a rollout override whose condition is `org_id == <org ulid>`.

## Caching and revalidation

One request answers every flag for a context: `POST {base}/v1/ofrep/v1/evaluate/flags`, with the context in the body. The answer is held for `ttlMs` (default 60 000) in a `HeraCache` the reader owns, keyed by the context. A failed read is held for as long, so an outage costs one call a minute per context, not one per request. When the hold expires, the next read sends the context's last `ETag` as `If-None-Match`. A `304` reuses the flags held with that ETag. Logfire computes the ETag per context.

All state lives in the reader. Hold it in a Durable Object instance or a request. The `hera-no-isolate-state` lint keeps module-scope mutable state out of `src/core`.

## Fallback reasons

| `reason` | When |
|---|---|
| `unconfigured` | no token |
| `unreachable` | a transport failure or timeout (`timeoutMs`, default 5 000) |
| `rejected` | a non-2xx answer, 429 included |
| `unparseable` | the body is not JSON, or not an OFREP bulk answer |
| `absent` | the flag is missing, answered `FLAG_NOT_FOUND`, or has no value |
| `errored` | any other OFREP `errorCode` for the flag |
| `invalid` | the caller's schema refused the value |

Every fallback writes one warn line, `hera.flags.fallback`, with `{ flag, reason }`. It writes through the ambient `HeraLoggerService` when one is provided, else through `Effect.logWarning`. It warns once per context per cause per window, however many reads miss the cache at once: a cause is a whole-read reason, or one flag's per-flag reason. The window is `ttlMs` for `ofrep` and `warnWindowMs` (default 60 000) for `fromSource`. The bound is per reader, so readers in separate isolates or Durable Objects each write their own line. Warn history covers at most `maxContexts` contexts; a dropped context may warn again. No token, response body or context value is logged. Bind `org_id` with your logger's `child` if the line needs it.

## Testing

`HeraTest.flags(spec)` from `@sibylline-labs/hera/testing` is an in-memory reader built on `HeraFlags.fromSource`. It falls back and warns exactly as the OFREP reader does, so tests never fake HTTP:

```ts
import { HeraTest } from "@sibylline-labs/hera/testing"

const flags = HeraTest.flags({ "inference-enabled": { value: false, orgs: { "01ORGA000000000000000000000": true } } })
flags.setUnreachable(true) // every read is an `unreachable` fallback, as an OFREP outage is
flags.set("inference-enabled", { value: true }) // change one flag's rule
```
