# Telemetry (`HeraTelemetry`, `Hera.worker`)

`HeraTelemetry` (`src/core/telemetry/`, exported from `@sibylline-labs/hera`, `@sibylline-labs/hera/core`
and `@sibylline-labs/hera/telemetry`) traces and logs one invocation at a time (a route request, an
RPC call, a queue batch or a Durable Object alarm pass) and exports it to Logfire as OTLP/JSON on
`${baseUrl}/v1/traces` and `${baseUrl}/v1/logs`. It runs on Effect's own `Tracer` and `Logger`, sets
no OpenTelemetry global, needs no `nodejs_compat`, and posts only inside the invocation's
`waitUntil`: there is no background timer.

```ts
import { createHeraLogger, Hera, HeraTelemetry } from "@sibylline-labs/hera"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

declare const env: { readonly LOGFIRE_BASE_URL?: string; readonly LOGFIRE_WRITE_TOKEN?: string }

// One per isolate, at module scope. Construction does no I/O.
const telemetry = HeraTelemetry.make({
  service: "inventory-api",
  environment: "prod",
  sink: {
    baseUrl: env.LOGFIRE_BASE_URL, // required whenever a token is set
    token: env.LOGFIRE_WRITE_TOKEN === undefined ? undefined : Redacted.make(env.LOGFIRE_WRITE_TOKEN),
  },
})
const logger = createHeraLogger({ service: "inventory-api" })

const listItems = Hera.publicRoute({
  method: "GET",
  path: "/v1/items",
  handler: () => logger.info("items.listed").pipe(Effect.as({ items: [] })),
})

export default Hera.worker(
  {
    fetch: (request: Request, _env: unknown, ctx: { waitUntil(promise: Promise<unknown>): void }) =>
      listItems(request, { telemetry: { telemetry, waitUntil: (p) => ctx.waitUntil(p) } }),
  },
  { service: "inventory-api" }
)
```

## What exports

| Invocation | Spans and `info` records | `warn` / `error` records |
|---|---|---|
| Healthy, faster than `slowThresholdMs`, not head-sampled | dropped | — |
| Emits a `warn` | dropped | each exported on its own |
| Emits an `error`, ends 5xx, dies, has an error span, or runs longer than `slowThresholdMs` | the whole buffer exports (promotion) | each exported |
| Head-sampled root (`headRate`), or an `internal` parent with sampled=1 | the whole buffer exports | each exported |

A ring holds the newest `maxBufferedSpans` (48) spans and `maxBufferedLogs` (32) `info` records;
`warn`/`error` records are capped at `maxBufferedLogs` too. `debug` never buffers. Defaults:
`headRate` 0.01, `slowThresholdMs` 1,000. Every POST reports a closed outcome to `onExport`
(`sent`, `rejected` for any non-2xx, `unreachable`), never a body.

While an invocation exports, a Hera logger line goes out as an OTLP log record and the logger's
sink (the default console sink or a consumer's own) is skipped, so one line never ships twice. A
logger made with `teeSinkWhenCaptured: true` keeps writing to its sink too.

An export names only parents that are exported: a log record's `spanId` and a span's
`parentSpanId` are sent when they name a span the same export carries, or a remote parent whose
caller sampled it. Otherwise the field is left out and the `traceId` stays, so a `warn` exported
without its spans, or a promoted run under an unsampled caller, shows as a root in its trace rather
than an orphan.

## Trace context

`source: "external"` (a route's default `trace`) ignores the caller's `traceparent`: a public caller
can neither choose the trace id nor force `sampled=1`. `"internal"` (a trusted service binding; every
`rpcMethod`) parents under a valid `traceparent` and follows its sampled flag. Without one, the
invocation is a fresh root: it drops any span the calling fiber carries (an outer invocation's), so
its spans start their own trace.

A `traceparent` Hera writes from the fiber (an `rpcClient` call with `propagate: true`, an outbox
row) says sampled (`01`) only when something exports the span it names: a span of a capturing
invocation that sampled it, or a remote parent its caller sampled. Effect's default tracer marks
every span sampled, so a span outside any invocation propagates as `00`.

A plain-stub door (`runDoor`) reads only its call's last argument as invoke meta, and only that
meta's `traceparent`, as an `internal` source. Its body's `within` grafts the invocation's tracer,
loggers, log capture and span onto effects it runs on a fresh runtime (`Effect.runPromise`,
`runWithTenantCtx`), so a line logged there exports with the door.

## Exceptions

A span that dies, fails uncatalogued, or fails with a catalogued status ≥ 500 gets status ERROR, an
`exception` event and `logfire.exception.fingerprint`. A catalogued 4xx records `error.code` only.
A catalogued error's `fields` also export, as `error.field.<key>`, for the failures above and the 4xx alike: at most 8, under identifier keys, and only code-shaped strings (letter words joined by `_ . : -`, at most 48 characters, no word over 20 letters), finite numbers and booleans. A free-text value, a bearer token, a JWT, a hex digest, a UUID or any other opaque id is dropped, so neither an upstream's own words nor a credential reaches a span.

| Member | Does |
|---|---|
| `scrubExceptionStack(stack, name, { rules?, message? })` | line 1 becomes `Name: [REDACTED]`; frames lose URL queries and are scrubbed with Hera's shapes, `GITLEAKS_SHAPES` and `rules`; at most 50 frames |
| `exceptionFingerprint({ type, frames, code? })` | 16-hex hash of the type, frame function names and catalogued code: never the message |
| `describeException(value, rules)` | the exported `{ type, message, stacktrace, fingerprint, code? }`; `message` is `[REDACTED]`, a catalogued `publicMessage`, or (`errorMessages: "scrubbed"`) the scrubbed message |

## Boundaries

| Boundary | Option |
|---|---|
| `Hera.publicRoute` / `authedRoute` / `tenantRoute` / `router` | invoke options `telemetry: { telemetry, waitUntil }`, `trace: "external" \| "internal"` |
| `Hera.rpcMethod` | spec `telemetry: { telemetry, waitUntil: (p) => this.ctx.waitUntil(p) }` |
| `Hera.queueConsumer` | spec `telemetry: telemetry \| (env) => telemetry`; `waitUntil` from the handler's `ctx` |
| `TenantDurableObject` / `KeyedDurableObject` alarms | override `protected telemetry()` |
| A plain-stub Durable Object door (raw value, no envelope) | `this.runDoor(name, callArgs, body)` over `telemetry()`, or `runDoor(hook, …)`; the caller wraps its stub in `propagatingStub(stub, traceparent)` ([guide](durable-objects.md#10-plain-stub-doors-rundoor-propagatingstub)) |
| Your own runner | `HeraTelemetry.run(telemetry, options, effect)`, `HeraTelemetry.scoped`, `HeraTelemetry.layer` |

## Configuration and failure

A token without `sink.baseUrl` throws `HeraConfigError` at `make`: a credential is never sent to a
default host. No token is not an error: every invocation is a no-op, loggers keep their console
sink, and the first `begin` writes one `hera.telemetry.unconfigured` warn for that instance.

## `Hera.worker`

`Hera.worker(handler, { service })` guards a Worker's exported handler so raw exception text never
reaches the runtime (and Cloudflare's log backstop):

- a `fetch` that throws answers `503 internal_unavailable` problem+json and logs `hera.worker.defect`;
- a `queue` or `scheduled` handler that throws logs `hera.worker.defect` and rethrows a fixed-message
  `HeraBoundaryDefect`, so the runtime still retries;
- a promise passed to `ctx.waitUntil` that rejects is caught and logged as
  `hera.worker.wait_until_rejected`.

A Durable Object alarm pass that rejects is logged as `hera.alarm.defect` and rethrown as a
`HeraBoundaryDefect` the same way. Each line carries only `defect_name` and
`exception_fingerprint`.
