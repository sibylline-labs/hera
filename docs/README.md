# `@sibylline-labs/hera` Documentation

Welcome to the documentation for `@sibylline-labs/hera`, the shared Effect v4 LTS runtime spine for TypeScript Cloudflare Worker services and Bun/Node CLIs.

## Core Concepts & Architecture

- [**Architecture & Plane Isolation**](ARCHITECTURE.md) — How Hera separates `core`, `server`, `cli`, and `testing` planes, enforces compile-time auth progression (`HeraPublicCtx` -> `HeraAuthedCtx` -> `HeraTenantCtx`), and confines `Effect.run*` to framework boundaries.
- [**Error Catalog, Error Envelope & CLI Exit Codes**](ERRORS.md) — Closed-catalog `HeraError` codes, `HeraError.define`, per-service domain codes (`HeraError.codes`), RFC 7807 `application/problem+json` error responses (`code` as an extension member), value-stripping validation errors, and deterministic `ErisError` exit codes (`1` operational, `2` usage, `3` precondition, `124` timeout).
- [**Repository Layout & Contributor Hygiene**](dev/LAYOUT.md) — Complete `src/` directory map, the ≤300-line file ceiling, leaf-helper extraction rules, and `ast-grep` boundary checks.
- [**Releasing & npm Publishing**](dev/RELEASING.md) — The `0.x` stability policy, tagging releases, the OIDC trusted-publishing workflow, the npm tarball allowlist, and provenance verification.
- [**License, Contributing, Security and Changelog**](../CONTRIBUTING.md) — MIT ([LICENSE](../LICENSE)), the contribution policy, private vulnerability reports ([SECURITY.md](../SECURITY.md)) and the release history ([CHANGELOG.md](../CHANGELOG.md)).

## Ambient Types per Subpath

- [**Ambient types per subpath**](../README.md#ambient-types-per-subpath) — which `@sibylline-labs/hera/*` subpaths typecheck with no ambient types, which need `@cloudflare/workers-types`, and which need Node types. `test/consumers/{pure,worker,cli,testing,testing-do}` enforce it in `bun run typecheck`.

## Feature Guides

1. [**Schemas, Branded IDs & 3-State Configuration (`HeraSchema`, `HeraConfig`)**](guides/schema-and-config.md)
   - Branded identifiers (`OrgId`, `ActorId`, `RequestId`, `Ulid`, `Srn`, `EnvName`, `ServiceName`, `KeyName`, `GcpProjectId`, `LogfireProject`, `ErrorSlug`, `HeraSchema.brandedId`)
   - Value-stripping decoders (`HeraSchema.decode`, `HeraSchema.decodeResult`) that never leak rejected input values into logs or error responses, and strict twins (`HeraSchema.decodeResultStrict`) that refuse unknown keys in operator-authored config
   - 3-state (`Unconfigured` / `Invalid` / `Valid`) config readers (`HeraConfig.secret`, `HeraConfig.hexKey`, `HeraConfig.keyring`) with versioned keyrings and a `legacy` single-base64-key fallback while the keyring is unset ([guide](guides/schema-and-config.md#moving-from-one-key-to-a-keyring-legacy)).
   - Operational dials (`HeraConfig.dials`, `HeraConfig.dialReaders`): one JSON-object Logfire managed variable merged over code defaults, key by key; every failure answers all defaults with its reason; one reader per `(base, token)`, no fetch without a base ([guide](guides/schema-and-config.md#dial-groups-heraconfigdials))
   - Product wire contracts live outside the framework, in a package that takes Hera as a peer ([guide](guides/schema-and-config.md#3-wire-contracts-live-outside-the-framework)).
2. [**Worker Routes, Routers, Webhooks, Auth Progression, Typed RPC & Queue Consumers (`Hera.publicRoute`, `Hera.authedRoute`, `Hera.router`, `HeraWebhook`, `Hera.rpcClient`, `Hera.queueConsumer`)**](guides/workers-and-routes.md)
   - Compile-time route capability gates and HTTP boundary builders (`publicRoute`, `authedRoute`, `tenantRoute`)
   - Authority-guarded routes (`authedRoute({ authority: { verb, credential, params?, verifier } })`): the `HeraAuthorityVerifier` port runs before the handler, which receives `HeraAuthorityCtx<V>` on a grant; a refusal is `403` problem+json with the verifier's code ([guide](guides/workers-and-routes.md#authority-guarded-routes-authority))
   - Request-body cap (`maxBodyBytes` → `413 payload_too_large` before decode) and opt-in form-urlencoded bodies (`bodyFormat: "json-or-form"`) ([guide](guides/workers-and-routes.md#capping-and-decoding-the-request-body-maxbodybytes-bodyformat))
   - Method + path routing over a route table (`router`, problem+json `404 route_not_found` / `405 method_not_allowed` with `Allow`) and gateway prefix rows (`prefixRouter`, segment-boundary match, per-method access), plus the pure matchers `matchRoutePath` and `matchPrefixRoute`, and `resolveRequestId(request)` (the boundary's own `req_<ULID>` resolution, for building `invokeOptions.tenant`)
   - Success replies: a returned value is wrapped as `{ ok, data, request_id }`; `HeraHttp.raw(value, { status, cacheControl })` answers the bare JSON value instead (`no-store` by default)
   - Signed-webhook verification (`HeraWebhook.verifyHmac`): constant-time HMAC over the raw body against any key of a secret set (strings or a `Keyring`, for rotation), optional header, signature-header (`parse`) or body timestamp tolerance, the `HeraWebhook.stripe` preset, a body cap, and one fixed `401 invalid_signature` whose reason only `HeraWebhook.refusalReason` reads ([guide](guides/workers-and-routes.md#verifying-signed-webhooks-herawebhookverifyhmac))
   - Scope enforcement (`scopes`, `anyOfScopes`), principal kind checks (`actorKind`), and defect sanitization (`503 internal_unavailable`)
   - Worker-to-Worker RPC (`rpcMethod`, `rpcClient`) with `{ ok }` wire envelopes, `HeraError` rehydration, and `503 <service>_unavailable` transport mapping. Retry is opt-in (`retry: { attempts, backoff, timeoutMs, isRetryable }`); `fields.retryable` is always reported. With `propagate: true` a call carries the caller's request id, org/actor log correlation and W3C `traceparent` / `baggage`, and the callee's span parents under the caller's; the default sends the caller's arguments untouched.
   - Cloudflare Queues consumers (`queueConsumer`): per-message Effect Schema decode (an undecodable message goes to `batch.invalid`, never poisoning the batch), `ackAll` on success, `retryAll({ delaySeconds })` on a `fields.retryable` error, `retryAll` + a class-name-only log line on a defect, and one `SpanLink` per producer trace for bodies sent with `HeraOutbox.queueSink({ trace: true })` ([guide](guides/workers-and-routes.md#3-queue-consumers-heraqueueconsumer)).
3. [**Multi-Tenant Durable Objects (`TenantDurableObject`, `KeyedDurableObject`, `SyncTx`, jobs)**](guides/durable-objects.md)
   - Tenant naming (`getTenantStub` names the object by the raw `OrgId`, or `org:<orgId>` with `useOrgPrefix`; `orgDoName`, `parseOrgDoName`), per-run naming (`runKeyed: true`; `orgRunDoName`, `parseOrgRunDoName`, `getTenantRunStub`) and fail-closed tenant identity verification
   - Monotonic SQLite migrations, applied lazily on the first write (construction and reads write nothing), with legacy-ledger adoption (`legacyMigrationLedger`)
   - One alarm owner per object (`AlarmDriver`, `runCompositePass()` for a host job such as an `agents` `Lifecycle`) and `purgeStorage()`.
   - Synchronous SQLite transactions (`this.db.transactSync` / `this.db.transactWithOutbox` over `SyncTx` effects) with atomic outbox staging (`tx.enqueueOutbox`) and composite alarm draining.
   - Ordered enqueues: `tx.enqueueOutbox({ ordered: true, ... })` takes a persistent per-object sequence number (`record.seq`) in the transaction, and `HeraOutbox.seedSequenceSql` carries an existing counter over ([guide](guides/durable-objects.md#ordered-enqueues-a-per-object-sequence-ordered-true)).
   - Queue delivery for the outbox: `HeraOutbox.queueSink` sends each batch in chunks that fit Cloudflare Queues' limits and rejects a record too large for one message ([guide](guides/durable-objects.md#5-sending-the-outbox-to-a-queue-heraoutboxqueuesink)).
   - Failing records: per-record sink results (`HeraOutboxDeliveryReport`), a dead-letter table after `outboxMaxAttempts` with a `hera.outbox.dead_lettered` error line, inspect and replay (`getDeadLetteredOutboxRecords`, `replayDeadLetteredOutbox`), and `outboxOrdering` (`strict` or `independent`) ([guide](guides/durable-objects.md#4-the-composite-alarm)).
   - Plain-stub doors: `this.runDoor` / `runDoor` run a raw-value door as one telemetry invocation parented under the caller's marked meta, with `within` joining nested runtimes; `propagatingStub` appends that meta on the caller's side (`HeraFilledStub<T>`, `givenOptional`) ([guide](guides/durable-objects.md#10-plain-stub-doors-rundoor-propagatingstub)).
   - State machines: `HeraStateMachine.define` declares a table's lifecycle graph; the compiler refuses unreachable and stranded states, and `transition` is a compare-and-set `UPDATE … RETURNING` that resolves `{ matched, count }` ([guide](guides/durable-objects.md#9-state-machines-herastatemachinedefine)).
4. [**CLI Runtime, Process Runner, Atomic Filesystem & HTTP (`HeraCli`, `HeraHttp`)**](guides/cli-and-http.md)
   - Granular CLI subpaths (`/cli/errors`, `/cli/manifest`, `/cli/fs`, `/cli/process`, `/cli/runtime`), the 13 `scrubFreeText` classes, identity-checked `DirLock` removal (inode + pid, under a `.break` mutex), and seconds-based `forEachBounded` env deadlines ([guide](guides/cli-and-http.md))
   - Typed CLI verbs (`HeraCli.verb`) with `HeraCliCtx` and `ErisError` failure blocks (`ERROR` / `slug:` / `fix:` / `docs:`)
   - A CLI declared once (`HeraCli.program` over `@sibylline-labs/hera/cli/manifest`): each verb's flags, operands and lazy handler in one spec, from which routing, strict argv (exit `2`, slugged), `--help`, `eris-help/1` help-json with flag summaries, docs and deterministic bash/zsh completion derive; `runPure` answers help and completion with no handler loaded; plugins extend another plugin's verb with flags and typed hook points (`HeraCli.hookPoint`, `HeraCli.hook`, `HeraCli.on`) ([guide](guides/cli-and-http.md#declaring-a-cli-once-heracliprogram))
   - Authority-guarded verbs (`authority: { verb, credential, params?, verifier }`): the `HeraAuthorityVerifier` port runs before the handler, which receives `HeraAuthorityCtx<V>` on a grant; a refusal exits `3` with the verifier's code, and `HeraTest.authority(spec)` fakes the verifier ([guide](guides/cli-and-http.md#authority-guarded-verbs-authority))
   - Subprocess supervision (`HeraCli.Runner`) with process-tree inspection and `SIGTERM` -> `SIGKILL` escalation
   - Atomic single-file writes (`writeFileAtomic`), crash- and signal-safe `.env` + `.secret.env` (+ `.dev.vars`) set writes (`AtomicPairWriter`) and stale-PID-aware directory locks (`DirLock`)
   - Whole-exchange timeout HTTP client (`HeraHttp.request`, binary `HeraHttp.requestBytes`, `redirect` passthrough) with bounded body streaming and RFC 9110 `Retry-After` parsing.
   - A gzip decode that stops at a byte limit (`HeraHttp.gunzipBounded`, `HeraHttp.gunzipBase64Bounded`: `null` once the output passes the limit, the decoder cancelled so a gzip bomb costs no memory) ([guide](guides/cli-and-http.md#bounded-gzip-decode-herahttpgunzipbounded))
   - A Server-Sent Events route reply (`HeraHttp.sse`: `data:` frames, idle `:` keepalives on the fiber's clock, an optional `[DONE]` sentinel, a static-message error frame instead of the sentinel on a mid-stream failure, and `disconnect` / body cancel aborting the source's signal) ([guide](guides/cli-and-http.md#server-sent-events-herahttpsse))
   - A handler-callable capped request-body read (`HeraHttp.readBody`: the route cap's own reader, run after the handler's gates, failing with a typed `HeraBodyReadError` `too_large` / `malformed`) ([guide](guides/cli-and-http.md#reading-a-capped-request-body-in-a-handler-herahttpreadbody))
   - GraphQL over the same exchange (`HeraHttp.graphql`: `errors[]` is a typed `GraphqlError`, `data` is schema-decoded) a create under a client-chosen id that never writes twice (`HeraHttp.createOnce`: `Created`, or `Found` by reading the id back after a failed create, `conflict` when another write holds it, the create's own error when nothing does), every page of a GraphQL connection or a typed failure, never a partial list (`HeraHttp.connectionPages`: a per-page hook for a fresh lease, a cap that fails `truncated`, a missing `pageInfo` or `endCursor` rejected), and an OAuth 2.0 client (`HeraOAuth2.client`: `exchangeCode` / `refresh` / `revoke`, typed `invalid_grant` / `invalid_client` / `upstream`).
5. [**Guided Step TUI (`HeraTui`, `@sibylline-labs/hera/tui`)**](guides/tui.md)
   - `prompt` / `select` / `confirm` steps with answers typed from the step list, run over an injected `TuiIo`
   - Lazy (nothing in `src/` imports it) and dependency-free, so public eris vendors it flat
   - Headless driving with `HeraTui.scriptedIo` for tests.
6. [**Structured Logging (`createHeraLogger`, `HeraEventLogger`)**](guides/logging.md)
   - Typed event registries (`createHeraLogger({ service, events })`), with an Effect surface and a `void` `sync` twin
   - Credential redaction by key name and by value shape (`sib_`, `lin_`, `Bearer`, 64-hex) replaced in place, plus consumer `secretKeys` / `secretShapes`; opt-in `errorMessages: "scrubbed"` keeps an error's reason, scrubbed then bounded
   - Never-throw writes: degraded `log_error` lines that keep the event and `org_id`.
7. [**Testing with `HeraTest` (`@sibylline-labs/hera/testing`)**](guides/testing.md)
   - Deterministic Effect test runner (`HeraTest.runTest`, `HeraTest.layer`) and controllable clock (`advanceClock`, `setClock`)
   - Route and RPC test doubles (`makeTestRouteRequest`, `makeTestRpcDouble`, `parseProblemDetailsResponse`)
   - Telemetry capture (`HeraTest.telemetry()`): a real `HeraTelemetry` posting to an in-memory OTLP host, read back with `spans()` and `logs()`
   - In-memory SQLite Durable Object harness (`makeTestTenantDoHarness`, `inspectOutbox`, `triggerAlarm`) from `@sibylline-labs/hera/testing/durable-object`.
   - `cloudflare:workers` stub for vitest and `bun test` (`@sibylline-labs/hera/testing/cloudflare-workers`, `@sibylline-labs/hera/testing/bun-preload`).
8. [**Rate Limiting (`HeraRateLimit`)**](guides/rate-limiting.md)
   - Pure token-bucket arithmetic (`HeraRateLimit.bucket`: `refill`, `waitMs`, `take`, `drained`) and a Clock-timed in-memory bucket (`HeraRateLimit.memory`)
   - A keyed map of in-memory buckets with a hard key cap that reclaims buckets refilled to capacity (`HeraRateLimit.keyed`)
   - A tenant Durable Object bucket spent inside `transactSync` that survives eviction (`HeraRateLimit.sqlStore`)
   - A Cloudflare `RateLimit` binding wrapper (`HeraRateLimit.binding`), fail-open by default or fail-closed with `onUnavailable: "refuse"`; every limiter refuses `rate_limited` with `retryAfter >= 1`.
9. [**Object Store (`HeraObjectStore`, `@sibylline-labs/hera/object-store`)**](guides/object-store.md)
   - R2 over its S3-compatible endpoint (`HeraObjectStore.r2S3`): `get` / `put` / `head` / `list` with unquoted etags, `ifMatch` / `ifNoneMatch: "*"` conditional writes and `customMetadata`, SigV4-signed over `HeraHttp.requestBytes`
   - Credentials derived from a Cloudflare API token (`HeraObjectStore.credentialsFromApiToken`), `Redacted` end to end
   - A failed precondition is the closed `precondition_failed` (412); every other failure is `rate_limited`, `invalid_request` or `upstream_error`
   - `HeraTest.objectStore()`: the in-memory fake, held to the same contract suite as the R2 transport.
10. [**OpenAPI Documents (`HeraOpenApi`, `@sibylline-labs/hera/openapi`)**](guides/openapi.md)
   - `HeraOpenApi.document(spec)`: OpenAPI 3.1.0 from a table of operations whose params, query, body and responses are Effect schemas
   - One `components.schemas` pool; two different schemas under one identifier throw, identical ones dedupe
   - Deterministic output (sorted paths, methods and component names), so a regenerated spec diffs only on a contract change
11. [**Caching (`HeraCache`)**](guides/caching.md)
   - `HeraCache.make({ ttlMs, negativeTtlMs?, maxEntries?, lookup })` → `{ get, invalidate, clear }`: a keyed TTL cache of settled answers per isolate, timed by the Effect `Clock`
   - Each miss looks up in the caller's own fiber (no shared flight); typed failures are held for `negativeTtlMs`, defects and interruptions never; LRU eviction at `maxEntries`
   - A lookup takes no services (the tenant goes in the key); `HeraConfig.managedVariables` runs on it.
12. [**Agent Telemetry (`HeraAgentTelemetry`, `@sibylline-labs/hera/agent/telemetry`)**](guides/agent-telemetry.md)
   - A Pi `TelemetryContext` whose spans are scrubbed on end, filtered to GenAI, and leave as OTLP/JSON to `${baseUrl}/v1/traces` through `HeraTelemetry`'s exporter (no OpenTelemetry package), under `deployment.environment.name`
   - Gitleaks-shaped scrubbing; full GenAI content (instructions, messages with reasoning, tool arguments and results) only for `contentExport: true`; only `invoke_agent`, `chat` and `execute_tool` spans export (at most 17 per 8-turn run)
   - A pipeline built lazily per instance, nothing shared between instances; errored spans carry a scrubbed `exception` and `logfire.exception.fingerprint`; Pi's `pi.ai.block` events are dropped; export failures resolve with a closed outcome.
13. [**Agents (`Hera.agent`, `Hera.agentTool`, `HeraAgentEgress`, `@sibylline-labs/hera/agent`)**](guides/agent.md)
   - `agents` and `@earendil-works/*` are optional peers: a consumer of `/agent`, `/agent/telemetry` or `/testing/agent` installs them itself at the pinned versions ([guide](guides/agent.md))
   - `Hera.agent(def)`: Pi Durable on a `TenantDurableObject`, with Lifecycle installed lazily and Hera's composite pass as its one host job. It has `submit` / `cancel` / `dispose` doors, and `purgeStorage()` runs dispose → deleteAll → abort
   - `Hera.agentTool`: Effect Schema input decoded strictly from the model's raw arguments (Pi coerces), `replay: "safe"` by default, `callId` passed to the handler; lint `hera-agent-tool-via-hera`
   - `HeraAgentEgress`: the Gemini API via the AI Gateway `google-ai-studio` route, a host allowlist, one meter row per request keyed by `cf-aig-log-id`, and `cf-aig-authorization` only when a gateway token is set; `HeraAgentTest` scripts the model in tests.
14. [**Feature Flags (`HeraFlags`, `@sibylline-labs/hera/flags`)**](guides/flags.md)
   - `HeraFlags.ofrep({ token, base, ttlMs?, timeoutMs?, maxContexts? })` → `{ bool, value, evaluate }`: per-org flags from Logfire managed variables over OFREP, the org as `targetingKey` and `org_id`
   - One bulk read per context per TTL in a reader-owned `HeraCache`, revalidated with the context's `ETag`; `base` is required
   - Every failure answers the code fallback with one closed `reason` and one `hera.flags.fallback` warn per cause per window
   - `HeraTest.flags(spec)`: the in-memory reader on the same fallback path, with `set` and `setUnreachable`.
15. [**Telemetry (`HeraTelemetry`, `Hera.worker`, `@sibylline-labs/hera/telemetry`)**](guides/telemetry.md)
   - `HeraTelemetry.make(config)` per isolate, `begin` per invocation: Effect `Tracer` + `Logger` into a 48-span / 32-record ring, OTLP/JSON posted only inside `waitUntil`
   - Tail promotion on an `error` record, 5xx, defect or slow run; `warn`/`error` records always export on their own; `source: "external"` ignores the caller's `traceparent`
   - `scrubExceptionStack` (line 1 `Name: [REDACTED]`) and `logfire.exception.fingerprint`; a token without `baseUrl` is refused
   - Plain-stub Durable Object doors (`runDoor`, `propagatingStub`) trace raw-value calls under the caller's `traceparent` ([guide](guides/durable-objects.md#10-plain-stub-doors-rundoor-propagatingstub))
   - `Hera.worker` guards `fetch` / `queue` / `scheduled` and `ctx.waitUntil` so no raw exception text reaches the runtime.
