# @sibylline-labs/hera

Opinionated Effect v4 LTS runtime for Sibylline TypeScript services, Cloudflare Workers, Durable Objects, and CLIs.

`@sibylline-labs/hera` standardizes how Cloudflare Worker services and Bun/Node CLIs validate wire contracts, load 3-state environment secrets and keyrings, propagate request and tenant context, emit structured redacted logs, translate typed `HeraError`s into RFC 7807 `application/problem+json` error responses or deterministic CLI exit codes, expose Worker HTTP routes and RPC methods, run single-threaded SQLite Durable Objects with transactional outboxes, and execute in-memory tests.

---

## Architectural Invariants

1. **Four Isolated Planes (`src/`)**:
   - **`src/core/`**: Runtime-agnostic primitives (`HeraSchema`, `HeraConfig`, `HeraError`, `HeraLogger`, `HeraCtx` / `HeraPublicCtx` / `HeraAuthedCtx` / `HeraTenantCtx`, `Hera.fn`, `HeraHttp`).
   - **`src/server/`**: Cloudflare Worker & Durable Object plane (`publicRoute`, `authedRoute`, `tenantRoute`, `rpcMethod`, `rpcClient`, `queueConsumer`, `TenantDurableObject`, `KeyedDurableObject`, `SyncTx`, `HeraStateMachine`).
   - **`src/cli/`**: Runtime-neutral CLI host adapter (`@sibylline-labs/hera/cli`: `HeraCli.verb`, the single-declaration verb/group/plugin host `HeraCli.program`, `ErisError`, `Runner`, `AtomicPairWriter`, `writeFileAtomic`, `DirLock`) with zero `cloudflare:workers` dependencies for `bun build --compile` binaries. `src/cli/tui/` is the separate, lazy-loaded `@sibylline-labs/hera/tui` subpath.
   - **`src/testing/`**: Deterministic test harness (`@sibylline-labs/hera/testing`: `HeraTest`, RPC fault doubles, controllable test clock; `@sibylline-labs/hera/testing/durable-object`: in-memory SQLite DO harness).
2. **Constrained Effect v4 Surface**:
   - Service and CLI logic uses `Hera.fn("Service.op")(function* () { ... })`.
   - Raw `Effect.runPromise` / `Effect.runSync` / `Effect.runFork`, Effect v3 legacy APIs, and hand-rolled context layers are banned by `rules/ast-grep/`.
3. **Compile-Time Auth & Tenancy Progression**:
   - Context progresses from `HeraPublicCtx` -> `HeraAuthedCtx` -> `HeraTenantCtx`. A handler yielding `HeraTenantCtx` cannot compile when passed to `Hera.publicRoute`.
4. **Synchronous SQLite Durable Object Transactions**:
   - `this.db.transactSync(function* (tx) { ... })` and `this.db.transactWithOutbox(function* (tx) { ... })` run a generator of synchronous `SyncTx` effects (`tx.exec`, `tx.query`, `tx.enqueueOutbox`) inside `storage.transactionSync`. `transactWithOutbox` stages outbox events atomically in the same SQLite commit and arms the DO alarm.
   - `HeraOutbox.queueSink({ binding, encode, limits, onOversize, trace })` is a `deliverOutboxBatch` sink for a Cloudflare Queue. Outbox rows record the enqueuing span's W3C `traceparent`; `trace: true` sends it (with the request id) in a body `Hera.queueConsumer` unwraps and links to the producer trace. It splits each drained batch into `sendBatch` calls that fit Cloudflare Queues' limits. A record too large for one message is rejected: Hera logs it as `hera.outbox.event_rejected` and passes it to `onOversize`, and the other records are still sent.
   - A sink may resolve a `HeraOutboxDeliveryReport` naming the records it failed; the rest are acknowledged. A record that fails `outboxMaxAttempts` times (default 20) moves to `_hera_outbox_dead_letter` with one `hera.outbox.dead_lettered` error line; `getDeadLetteredOutboxRecords()` and `replayDeadLetteredOutbox(ids?)` inspect and replay it. `outboxOrdering: "independent"` stops a backed-off record from holding the ones behind it (the default, `"strict"`, keeps written order).

---

## Installation

```bash
bun add @sibylline-labs/hera effect
```

---

## Package Exports Matrix

| Export Path | Plane | Primary Symbols | Description |
|---|---|---|---|
| `@sibylline-labs/hera` | Core + Server | `Hera`, `HeraSchema`, `HeraConfig`, `HeraError`, `HeraPublicCtx`, `HeraAuthedCtx`, `HeraTenantCtx`, `HeraLogger`, `HeraHttp`, `HeraWebhook`, `TenantDurableObject`, `KeyedDurableObject`, `SyncTx`, `HeraStateMachine` | Default Worker/Server + Core entrypoint (never exports CLI or Testing) |
| `@sibylline-labs/hera/core` | Core | All `src/core/**` exports | Runtime-agnostic core barrel |
| `@sibylline-labs/hera/schema` | Core | `HeraSchema`, `OrgId`, `ActorId`, `RequestId`, `Ulid`, `Srn`, `parseSrn`, `EnvName`, `ServiceName`, `KeyName`, `GcpProjectId`, `LogfireProject`, `ErrorSlug`, `decode`, `decodeResult`, `decodeResultStrict` | Branded IDs and value-stripping `Schema` decoders |
| `@sibylline-labs/hera/config` | Core | `HeraConfig`, `HeraEnv`, `HeraConfigError`, `Keyring`, `secret`, `hexKey`, `keyring`, `managedVariables` | 3-state (`Unconfigured` / `Invalid` / `Valid`) secret, hex-key, and versioned keyring readers (with a `legacy` single-key fallback while a keyring is unset), and a Logfire managed-variable reader with a code fallback |
| `@sibylline-labs/hera/context` (`./ctx`) | Core | `HeraPublicCtx`, `HeraAuthedCtx`, `HeraTenantCtx`, `HeraCtx` | Ambient request, auth, and tenant `Context.Service` tags |
| `@sibylline-labs/hera/errors` (`./error`) | Core | `HeraError`, `HERA_ERROR_CATALOG`, `HeraError.codes` (`HeraErrorCodeRegistry`, `HeraDomainErrorCode`), `buildProblemDetails`, `serializeProblemResponse` | Closed-catalog yieldable errors, per-service domain code registries & RFC 7807 problem details serialization (`code` as an extension member) |
| `@sibylline-labs/hera/fn` | Core | `fn`, `enrichSpanFromHeraCtx` | Traced Effect v4 generator function wrapper (`Hera.fn`) |
| `@sibylline-labs/hera/logger` | Core | `HeraLogger`, `HeraLoggerService`, `createHeraLogger`, `HeraEventLogger`, `HeraEventLoggerSync`, `HeraLogFields`, `scrubLogValue`, `scrubLogString`, `CREDENTIAL_SHAPES`, `GITLEAKS_RULES`, `GITLEAKS_SHAPES`, `ERROR_MESSAGE_LIMIT`, `ErrorMessageMode` | Structured JSON logger: typed event registries (`events`), in-place credential-shape and key redaction, opt-in scrubbed error messages (`errorMessages`), ambient org/actor/request slots and W3C `trace_id`/`span_id` from the fiber, never-throw writes ([guide](docs/guides/logging.md)) |
| `@sibylline-labs/hera/http` | Core | `HeraHttp` (`request`, `requestBytes`, `graphql`, `raw`, `sse`), `HeraHttpError`, `RateLimitedError`, `HeraOAuth2` (`client`), `HeraOAuth2Error`, `parseRetryAfter`, `readBytesBounded`, `gunzipBounded`, `gunzipBase64Bounded`, `readBody`, `HeraBodyReadError`, `toProblemResponse` | Whole-exchange timeout HTTP client (text or exact-bytes bodies, `redirect` passthrough), GraphQL with typed `errors[]`, OAuth 2.0 code exchange / refresh / revoke, bounded body reader, a gzip decode that stops at a byte limit (`gunzipBounded`, `gunzipBase64Bounded`: `null` past the limit, the decoder cancelled), a handler-callable capped request-body read (`HeraHttp.readBody`, typed `too_large` / `malformed` failure, the same reader as the route's `maxBodyBytes`), RFC 9110 `Retry-After` parser, `toProblemResponse` (the same serializer as `HeraError.toResponse`), `HeraHttp.raw` (a route success answered as the bare JSON value, `no-store` by default), and `HeraHttp.sse` (a `text/event-stream` route reply: data frames, idle keepalives, an optional sentinel, a static-message error frame, disconnect → source abort; frame helpers `sseDataFrame`, `sseCommentFrame`, `sseSentinelFrame`, `sseErrorFrame`) |
| `@sibylline-labs/hera/object-store` | Core | `HeraObjectStore` (`r2S3`, `credentialsFromApiToken`), `HeraObjectStoreClient`, `HeraStoredObject`, `HeraS3Credentials` | Object store with etags, `ifMatch` / `ifNoneMatch: "*"` conditional writes and `customMetadata`: R2 over its S3-compatible endpoint (SigV4 over WebCrypto, `Redacted` credentials, token-derived keys); a failed precondition is `precondition_failed` (412) ([guide](docs/guides/object-store.md)) |
| `@sibylline-labs/hera/openapi` | Core | `HeraOpenApi` (`document`), `HeraOpenApiOperation`, `HeraOpenApiSpec`, `HeraOpenApiDocument` | OpenAPI 3.1.0 from Effect schemas: a table of operations becomes one deterministic document whose `$ref`s resolve inside `components.schemas` ([guide](docs/guides/openapi.md)) |
| `@sibylline-labs/hera` (`HeraRateLimit`) | Core + Server | `HeraRateLimit` (`bucket`, `memory`, `keyed`, `sqlStore`, `binding`, `refusal`), `HeraBucketLimit`, `HeraKeyedBuckets`, `HeraRateLimitBinding` | Token-bucket rate limiting: pure arithmetic, Clock-timed in-memory bucket, keyed bucket map with a hard key cap, SyncTx-backed tenant-DO bucket, Cloudflare `RateLimit` wrapper (fail-open by default, `onUnavailable: "refuse"` fails closed); all refuse `rate_limited` with `retryAfter >= 1` ([guide](docs/guides/rate-limiting.md)) |
| `@sibylline-labs/hera` (`HeraCache`) | Core | `HeraCache` (`make`, `DEFAULT_MAX_ENTRIES`), `HeraCacheOptions`, `HeraCacheInstance` | A keyed TTL cache of settled answers per isolate: Clock-timed, each miss looked up in the caller's own fiber (no shared flight, safe across workerd requests), typed failures held for `negativeTtlMs`, defects never held, LRU-bounded by `maxEntries`; `HeraConfig.managedVariables` runs on it ([guide](docs/guides/caching.md)) |
| `@sibylline-labs/hera/authority` | Core | `HeraAuthorityVerifier`, `HeraAuthorityRefusal`, `refuseAuthority`, `HeraAuthorityCtx`, `HeraAuthorityRequest`, `HeraAuthorityGrant` | Product-neutral authority port: a boundary asks the verifier whether a credential may perform a verb and hands the guarded handler a branded `HeraAuthorityCtx<V>` only on a grant; a refusal carries the verifier's own code (wire code `forbidden`) ([CLI guide](docs/guides/cli-and-http.md#authority-guarded-verbs-authority), [route guide](docs/guides/workers-and-routes.md#authority-guarded-routes-authority)) |
| `@sibylline-labs/hera/flags` (`HeraFlags`) | Core | `HeraFlags` (`ofrep`, `fromSource`, `contextKey`, `FALLBACK_EVENT`), `HeraFlagReader`, `HeraFlagContext`, `HeraFlagValue`, `HeraFlagReason`, `HeraOfrepOptions` | Per-org feature flags from Logfire managed variables over OFREP: the org is the targeting key (and the `org_id` attribute); one bulk read per context per TTL in a reader-owned `HeraCache`, `If-None-Match` revalidation; every failure answers the code fallback with one `hera.flags.fallback` warn ([guide](docs/guides/flags.md)) |
| `@sibylline-labs/hera/telemetry` (`HeraTelemetry`) | Core | `HeraTelemetry` (`make`, `run`, `scoped`, `layer`), `scrubExceptionStack`, `exceptionFingerprint`, `describeException`, `resolveTraceContext`, `HeraTelemetryHook`, `HeraTelemetryConfig` | Per-invocation OTLP/JSON traces and logs to Logfire on Effect's `Tracer` / `Logger`: a 48-span / 32-record ring promoted on error, 5xx, defect or slow; `warn`/`error` records always export; posts only inside `waitUntil`; no OTel global; `Hera.worker` guards a Worker's handlers ([guide](docs/guides/telemetry.md)) |
| `@sibylline-labs/hera/server` | Server | `publicRoute`, `authedRoute`, `tenantRoute`, `HeraAuthorityRouteSpec`, `HeraAuthorityVerifierDefect`, `router`, `prefixRouter`, `HeraWebhook`, `rpcMethod`, `rpcClient`, `queueConsumer`, `TenantDurableObject`, `KeyedDurableObject`, `SyncTx` | Full Cloudflare Worker & Durable Object server barrel; `queueConsumer` decodes a Queues batch and settles it from the handler's exit (`ackAll` on success, delayed `retryAll` on a `fields.retryable` error, `retryAll` + log on a defect) |
| `@sibylline-labs/hera/routes` | Server | `publicRoute`, `authedRoute`, `tenantRoute`, `HeraAuthorityRouteSpec`, `HeraAuthorityVerifierDefect`, `router`, `prefixRouter`, `matchRoutePath`, `matchPrefixRoute`, `extractPathParams`, `resolveRequestId`, `hasGrantedScope`, `HeraWebhook` | HTTP route boundary builders (an opt-in `authority` guard on `authedRoute` that runs the `HeraAuthorityVerifier` port before the handler and refuses `403` with the verifier's code, [guide](docs/guides/workers-and-routes.md#authority-guarded-routes-authority); an optional request-body cap, `maxBodyBytes` → `413`, and opt-in form-urlencoded decode, `bodyFormat: "json-or-form"`), compile-time auth capability gates, a method + path router (problem+json `404`/`405` with `Allow`), gateway prefix rows (segment-boundary match, per-method access) and a signed-webhook verifier (`HeraWebhook.verifyHmac`: constant-time HMAC over any key of a secret set or `Keyring`, a combined signature header via `parse` with a signed timestamp, timestamp tolerance, one fixed `401`) and its Stripe preset (`HeraWebhook.stripe`) |
| `@sibylline-labs/hera/agent/telemetry` | Server | `HeraAgentTelemetry` (`make`), `scrubAttributes`, `redactSpan`, `isContentKey`, `InvokeAgentInput`, `EndedSpan`, `HeraExportReport` | Scrubbed GenAI OTLP/JSON export of a Pi agent's spans to Logfire from a Durable Object, on `HeraTelemetry`'s exporter (no OpenTelemetry package): a per-instance lazy pipeline, `deployment.environment.name` on the resource, gitleaks-shaped scrubbing on span end, fingerprinted exceptions, content attributes only for `contentExport: true`, only `invoke_agent` / `chat` / `execute_tool` spans leave ([guide](docs/guides/agent-telemetry.md)) |
| `@sibylline-labs/hera/agent` | Server | `Hera` (`fn`, `agent`, `agentTool`), `HeraAgentModels`, `HeraAgentEgress`, `HeraAgentMeter`, `HERA_AGENT_EGRESS_HOSTS`, `HeraAgentTool`, `HeraAgentUpstream`, the `agent_*` errors | A Pi Durable agent host on a `TenantDurableObject` (lazy `Lifecycle`, composite pass as its host job, `dispose` in `purgeStorage`), Schema-typed tools decoded strictly from the raw arguments (`replay: "safe"` by default), and Gemini egress through the AI Gateway `google-ai-studio` route with a host allowlist and one meter row per request ([guide](docs/guides/agent.md)) |
| `@sibylline-labs/hera/rpc` | Server | `rpcMethod`, `rpcClient`, `isHeraRpcResult`, `extractTrailingRpcMeta`, `parseTraceparent`, `formatTraceparent` | Typed Worker-to-Worker RPC boundaries: `{ ok }` wire envelopes, error rehydration into `HeraError` (from `{ ok: false }` or problem details), and `503 <service>_unavailable` transport mapping, with an opt-in `retry` policy (attempts, full-jitter backoff on the Effect `Clock`, per-attempt timeout, `isRetryable`); `rpcClient` appends the caller's correlation and W3C `traceparent` / `baggage` to every call (`propagate: false` opts out) and `rpcMethod` parents its span under the caller's ([guide](docs/guides/workers-and-routes.md)) |
| `@sibylline-labs/hera/durable-object` (`./worker`) | Server | `TenantDurableObject`, `KeyedDurableObject`, `SyncTx`, `HeraJobScheduler`, `HeraOutbox`, `AlarmDriver`, `StorageAlarmDriver`, `orgDoName`, `parseOrgDoName`, `getTenantStub`, `orgRunDoName`, `parseOrgRunDoName`, `getTenantRunStub`, `HeraStateMachine` | Per-org or, with `runKeyed: true`, per-run (`org:<OrgId>:run:<runKey>`) (`TenantDurableObject`) and non-tenant keyed (`KeyedDurableObject`) SQLite Durable Object bases: lazily applied migrations (construction and reads write nothing), transactional outbox (with `HeraOutbox.queueSink` for Cloudflare Queues), and named jobs with cron (`this.jobs`) on the composite alarm, whose owner is an `AlarmDriver` (a Lifecycle host job can run it through `runCompositePass()`); `purgeStorage()` empties the object; `HeraStateMachine.define` declares a table's lifecycle graph (compile-time reachability and totality, compare-and-set `transition`) ([guide](docs/guides/durable-objects.md#9-state-machines-herastatemachinedefine)) |
| `@sibylline-labs/hera/cli` | CLI | `HeraCli`, `HeraCliCtx`, `HeraCliAuthority`, `ErisError`, `Runner`, `AtomicPairWriter`, `writeFileAtomic`, `DirLock`, `forEachBounded` | Standalone CLI host adapter for `bun build --compile` and Node/Bun CLIs; `HeraCli.verb`'s `authority` option runs a verifier before the handler ([guide](docs/guides/cli-and-http.md#authority-guarded-verbs-authority)) |
| `@sibylline-labs/hera/cli/errors`, `/cli/fs`, `/cli/process`, `/cli/runtime` | CLI | one CLI plane module each (`ErisError` + `scrubFreeText`, `DirLock` + `AtomicPairWriter` + `writeFileAtomic`, `Runner`, verb runtime + `program` + `handler` + `hook` + `forEachBounded`) | Granular imports for a CLI that does not want the whole `/cli` barrel ([guide](docs/guides/cli-and-http.md)) |
| `@sibylline-labs/hera/cli/manifest` | CLI | `defineVerb`, `defineArgs`, `defineGroup`, `definePlugin`, `defineExtension`, `flag`, `operand`, `hookPoint`, `composeProgram`, `runPure`, `helpText`, `helpJson`, `docsJson`, `completionScript`, `tokenize`, `route` | The pure half of the CLI host: one declaration per verb, from which routing, strict argv, `--help`, `eris-help/1` help-json, docs and bash/zsh completion derive with no handler and no `effect` loaded ([guide](docs/guides/cli-and-http.md#declaring-a-cli-once-heracliprogram)) |
| `@sibylline-labs/hera/tui` | CLI | `HeraTui`, `run`, `prompt`, `select`, `confirm`, `terminalIo`, `scriptedIo`, `TuiIo` | Host-agnostic, lazy-loaded guided-step TUI; dependency-free so public eris vendors it ([guide](docs/guides/tui.md)) |
| `@sibylline-labs/hera/testing` | Testing | `HeraTest`, `runTest`, `makeTestLayer`, `makeTestRpcDouble`, `makeTestObjectStore`, `makeTestAuthority`, `makeTestTelemetry`, `SAMPLE_IDS` | Deterministic test runner, context layers, fixtures, RPC doubles, the in-memory object store (`HeraTest.objectStore()`), the fake authority verifier (`HeraTest.authority(spec)`) and the telemetry capture (`HeraTest.telemetry()`: real scrubbing and tail-promotion, posts kept in memory; [guide](docs/guides/testing.md#5-capturing-telemetry-heratesttelemetry)) |
| `@sibylline-labs/hera/testing/cloudflare-workers`, `/testing/bun-preload` | Testing | `DurableObject`, `WorkerEntrypoint`, `RpcTarget`, `env` | `cloudflare:workers` stub for vitest (`resolve.alias`) and `bun test` (preload), so a `TenantDurableObject` subclass loads outside workerd |
| `@sibylline-labs/hera/testing/agent` | Testing | `HeraAgentTest` (`script`, `toolCall`, `toolCalls`, `text`, `fail`, `meterRows`) | A scripted model served at the agent egress seam, so a consumer's agent tests never import Pi ([guide](docs/guides/agent.md#5-testing-without-pi)) |
| `@sibylline-labs/hera/testing/durable-object` | Testing | `HeraTest` (with the DO members), `makeTestLayer` (SQLite-backed), `makeTestTenantDoHarness`, `inspectOutbox`, `triggerAlarm` | In-memory SQLite Durable Object harness; its `HeraTest` is a superset of the `/testing` one |

### Optional peer dependencies

`effect` is Hera's only hard dependency. `/agent`, `/agent/telemetry` and `/testing/agent` also need `agents` and `@earendil-works/{chord,pi-ai,pi-durable,pi-telemetry}`, declared as optional peers: a consumer of those subpaths installs them itself, at the versions `package.json` names, and a CLI-only consumer never downloads them.

### Ambient types per subpath

A consumer typechecks Hera's `.ts` source under its own `tsconfig` (strict, `moduleResolution: "bundler"`), so each subpath needs the ambient types its source touches. Observed with `bun check` and no ambient types loaded:

| Subpath | Ambient types it needs |
|---|---|
| `/core`, `/schema`, `/config`, `/context` (`/ctx`), `/errors` (`/error`), `/fn`, `/logger`, `/http`, `/object-store`, `/openapi`, `/routes`, `/rpc` | None. These are pure packages. |
| `.` (the root barrel re-exports the server plane), `/server`, `/durable-object` (`/worker`), `/agent`, `/agent/telemetry` | `@cloudflare/workers-types` |
| `/cli`, `/cli/errors`, `/cli/fs`, `/cli/process`, `/cli/runtime` | Node types (`@types/node` or `bun-types`) |
| `/cli/manifest` | None. It imports only its own siblings. |
| `/tui` | None. It reaches the host only through `TuiIo`. |
| `/testing` | None. A CLI or pure package (eris) imports `HeraTest` without workers-types. |
| `/testing/cloudflare-workers`, `/testing/bun-preload` | None |
| `/testing/durable-object` | `@cloudflare/workers-types` and Node types: the in-memory SQLite DO harness loads `node:sqlite` through `node:module` |

The server plane (`.`, `/server`, `/durable-object`) also imports `cloudflare:workers` at runtime, because `TenantDurableObject` extends its `DurableObject`. A Worker bundle resolves it. A test runner outside workerd resolves it to `/testing/cloudflare-workers` ([testing guide](docs/guides/testing.md)).

`test/consumers/{pure,worker,cli,testing,testing-do}` are one fixture per row. `bun run typecheck` compiles each with a consumer-style `tsconfig`, so a subpath that starts needing an ambient type it did not need before fails the gate. Hera also compiles under `@total-typescript/ts-reset`, which some consumers load.

---

## Quickstarts

### 1. Cloudflare Worker Route (`@sibylline-labs/hera`)

```ts
import * as Schema from "effect/Schema";
import {
  Hera,
  HeraError,
  HeraSchema,
  HeraTenantCtx,
  OrgId,
} from "@sibylline-labs/hera";

export const OrderId = HeraSchema.brandedId("OrderId", /^ord_[0-9A-HJKMNP-TV-Z]{26}$/);
export type OrderId = typeof OrderId.Type;

export class QuotaExceededError extends HeraError.define("QuotaExceededError", {
  code: "quota_exceeded",
  status: 429,
  publicMessage: "Order exceeds tenant quota",
  fields: { orgId: OrgId, limitCents: Schema.Number },
}) {}

export const createOrder = Hera.fn("Orders.create")(function* (input: {
  readonly orderId: OrderId;
  readonly amountCents: number;
}) {
  const ctx = yield* HeraTenantCtx.current;
  yield* ctx.logger.info("orders.creating", { orderId: input.orderId });

  if (input.amountCents > 100_000_00) {
    return yield* new QuotaExceededError({
      orgId: ctx.orgId,
      limitCents: 100_000_00,
    });
  }

  return {
    orderId: input.orderId,
    orgId: ctx.orgId,
    amountCents: input.amountCents,
  };
});

export const createOrderRoute = Hera.authedRoute({
  method: "POST",
  path: "/v1/orders",
  scopes: ["orders:write"],
  body: Schema.Struct({
    orderId: OrderId,
    amountCents: Schema.Number,
  }),
  handler: ({ body }) => createOrder(body),
});
```

Every entry in `scopes` must be granted (`anyOfScopes` needs only one), and `actorKind` takes a single kind or an array. The auth source is `resolveAuth` on the spec, or the `tenant` passed in the invoke options.

### 2. Standalone CLI Verb (`@sibylline-labs/hera/cli`)

```ts
import * as Schema from "effect/Schema";
import { EnvName, HeraCli, fn } from "@sibylline-labs/hera/cli";

export const pullVerb = HeraCli.verb({
  name: "eris pull",
  slug: "pull-usage",
  args: Schema.Struct({
    env: EnvName,
  }),
  handler: (args, ctx) =>
    fn("PullCli.pull")(function* () {
      const runner = yield* HeraCli.Runner;
      const res = yield* runner.run({
        cmd: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd: ctx.cwd,
      });
      ctx.stdout(JSON.stringify({ env: args.env, root: res.stdout.trim() }) + "\n");
    })(),
});
```

The handler's error channel is `ErisError` (a subprocess spawn failure surfaces as one), and calling the verb resolves to the process exit code.

---

## Documentation

- [Documentation Index](docs/README.md)
- [Architecture & Plane Isolation](docs/ARCHITECTURE.md)
- [Error Catalog, Error Envelope & CLI Exit Codes](docs/ERRORS.md)
- [Repository Layout & Contributor Hygiene](docs/dev/LAYOUT.md)
- **Guides**:
  - [Schemas, Branded IDs & 3-State Configuration (`HeraSchema`, `HeraConfig`)](docs/guides/schema-and-config.md)
  - [Worker Routes, Routers, Auth Progression & Typed RPC & Queue Consumers (`Hera.publicRoute`, `Hera.authedRoute`, `Hera.router`, `Hera.rpcClient`, `Hera.queueConsumer`)](docs/guides/workers-and-routes.md)
  - [Multi-Tenant Durable Objects (`TenantDurableObject`, `KeyedDurableObject`, `SyncTx`, jobs)](docs/guides/durable-objects.md)
  - [CLI Runtime, Process Runner, Atomic FS & HTTP (`HeraCli`, `HeraHttp`)](docs/guides/cli-and-http.md)
  - [Guided Step TUI (`HeraTui`, `@sibylline-labs/hera/tui`)](docs/guides/tui.md)
  - [Structured Logging (`createHeraLogger`, `HeraEventLogger`)](docs/guides/logging.md)
  - [Testing with `HeraTest` (`@sibylline-labs/hera/testing`)](docs/guides/testing.md)
  - [Rate Limiting (`HeraRateLimit`)](docs/guides/rate-limiting.md)
  - [Caching (`HeraCache`)](docs/guides/caching.md)
  - [Agent Telemetry (`HeraAgentTelemetry`)](docs/guides/agent-telemetry.md)
  - [Agents (`Hera.agent`, `Hera.agentTool`, `HeraAgentEgress`)](docs/guides/agent.md)
  - [Telemetry (`HeraTelemetry`, `Hera.worker`)](docs/guides/telemetry.md)

---

## Verification Gates

```bash
bun run typecheck   # tsc --noEmit, the 4 consumer-shape fixtures, and every ts code block in README/docs/skills compiled against src
bun run lint        # tsc --noEmit && ast-grep scan && ast-grep test --skip-snapshot-tests
bun run test        # vitest run (all unit, property, cold-start, and repo-layout hygiene suites)
```

---

## License, Contributing and Security

Hera is released under the [MIT License](LICENSE). Changes are recorded in [CHANGELOG.md](CHANGELOG.md). Hera does not accept outside contributions; forks are welcome ([CONTRIBUTING.md](CONTRIBUTING.md)). Report vulnerabilities privately as [SECURITY.md](SECURITY.md) describes.
