# CLAUDE.md — `@sibylline-labs/hera`

Agent and contributor instructions for `@sibylline-labs/hera`, the shared Effect v4 LTS runtime for Sibylline's TypeScript services, Workers, Durable Objects and CLIs.

## Architecture & Plane Isolation (`src/`)

`src/` is strictly partitioned into 4 top-level plane directories. **Never** place flat `.ts` monoliths directly in `src/` (only `src/index.ts` is permitted at the root of `src/`).

```
src/
├── index.ts                 # Root Worker/Server + Core barrel (NEVER exports cli or testing)
├── core/                    # Plane 1: Runtime-agnostic Effect v4 & Web Standard primitives
│   ├── schema/              # HeraSchema, brand/ (factory, ids), decode/ (value-stripping), eris/ (srn, primitives)
│   ├── config/              # HeraConfig 3-state env-reader, secret, hex-key, versioned keyring, primitives
│   ├── errors/              # HeraError closed catalog, problem-details (RFC 7807 `application/problem+json`), converters, sanitizers
│   ├── logger/              # createHeraLogger, HeraLoggerService, redaction, serializer
│   ├── context/             # HeraPublicCtx, HeraAuthedCtx, HeraTenantCtx, HeraCtx, headers
│   ├── fn/                  # Hera.fn traced generator wrapper & span-enricher
│   ├── authority/           # HeraAuthorityVerifier port, HeraAuthorityRefusal, branded HeraAuthorityCtx<V> (constructor never exported)
│   ├── flags/               # HeraFlags: per-org flags over Logfire OFREP (targetingKey + org_id), reader-owned TTL cache, ETag revalidation, code fallback
│   ├── telemetry/           # HeraTelemetry: per-invocation Effect Tracer + Logger, 48/32 ring, tail promotion, OTLP/JSON via waitUntil, scrubExceptionStack + fingerprint
│   ├── object-store/        # HeraObjectStore: R2 over S3 (SigV4), etags, If-Match / If-None-Match, customMetadata
│   ├── openapi/             # HeraOpenApi.document: OpenAPI 3.1.0 from Effect schemas (deterministic, one components pool)
│   └── http/                # HeraHttp whole-exchange timeout client, body-reader, retry-after, problem-response, graphql, oauth2/ (HeraOAuth2)
├── server/                  # Plane 2: Cloudflare Worker & Durable Object plane
│   ├── agent/               # @sibylline-labs/hera/agent: Hera.agent (Pi Durable host), Hera.agentTool, HeraAgentEgress (AI Gateway allowlist + meter), HeraAgentModels
│   ├── agent/telemetry/     # @sibylline-labs/hera/agent/telemetry: HeraAgentTelemetry: Pi adapter, span records, scrub/GenAI-filter/export pipeline on core telemetry (subpath only, never in a barrel)
│   ├── durable-object/      # TenantDurableObject, KeyedDurableObject, base-do, jobs/, naming, migrations/runner, outbox/ (drainer, store, schema), sql/sync-tx
│   ├── worker/              # Hera.worker guard (fetch/queue/scheduled + waitUntil), HeraBoundaryDefect
│   ├── routes/              # publicRoute, authedRoute, tenantRoute, headers, body, response
│   └── rpc/                 # rpcMethod, rpcClient, envelope
├── cli/                     # Plane 3: Runtime-neutral CLI plane (@sibylline-labs/hera/cli)
│   ├── errors/              # ErisError (exit codes 1/2/3/124), failure-block, scrubber
│   ├── manifest/            # @sibylline-labs/hera/cli/manifest: pure verb/group/plugin specs → routing, strict argv, help, eris-help/1, docs, bash/zsh completion (imports only siblings)
│   ├── runtime/             # HeraCli.verb (optional `authority` guard), HeraCli.program (runs a manifest), handler/hook, HeraCliCtx, bounded concurrency pool (forEachBounded)
│   ├── process/             # Runner subprocess supervisor, process tree snapshot & SIGTERM->SIGKILL escalation
│   ├── fs/                  # writeFileAtomic, AtomicPairWriter (atomic env-file set) & PID-aware DirLock
│   ├── tui/                 # @sibylline-labs/hera/tui: lazy guided steps (prompt/select/confirm), imports only siblings
│   └── hera-cli.ts          # HeraCli composite namespace
└── testing/                 # Plane 4: Test harness plane (@sibylline-labs/hera/testing)
    ├── fixtures/            # SAMPLE_IDS, makeTestHexKey, makeTestKeyring
    ├── context/             # makeTestLayer, makeTestCtx, makeTestTenantCtx, withTestEnv
    ├── runner/              # runTest, runTestExit, deterministic test clock (advanceClock, setClock)
    ├── http-rpc/            # makeTestRouteRequest, makeTestRpcDouble, parseProblemDetailsResponse
    ├── authority/           # makeTestAuthority (HeraTest.authority) fake verifier, fails closed
    ├── flags/               # makeTestFlags (HeraTest.flags) in-memory flag reader on HeraFlags.fromSource
    ├── object-store/        # makeTestObjectStore (HeraTest.objectStore) in-memory object store
    ├── telemetry/           # makeTestTelemetry (HeraTest.telemetry): real HeraTelemetry over an in-memory OTLP host
    ├── workers-stub/        # /testing/cloudflare-workers stub & /testing/bun-preload (cloudflare:workers outside workerd)
    ├── agent/               # @sibylline-labs/hera/testing/agent: HeraAgentTest scripted model at the egress seam
    ├── durable-object/      # @sibylline-labs/hera/testing/durable-object: in-memory SQLite DO harness, DO-backed layer & HeraTest
    └── hera-test.ts         # HeraTest composite namespace
```

## Non-Negotiable Hygiene Rules

1. **File Size Cap (≤ 300 lines)**:
   - Every `.ts` file under `src/` is enforced at **≤ 300 lines** by `test/hygiene/repo-layout.test.ts` (target 60–250 lines).
   - Pure helpers (AST describers, issue formatters, header parsers, retry-after parsers, error sanitizers, SQLite adapters, lockfile helpers) must live in dedicated leaf modules, **never** nested inside large functions or class methods.
2. **Strict Plane Boundaries**:
   - `src/core/**` must **never** import from `src/server/**`, `src/cli/**`, or `src/testing/**`.
   - `src/server/**` must **never** import from `src/cli/**` or `src/testing/**` (nor Node-only modules like `node:child_process`, `node:fs`).
   - `src/cli/**` must **never** import from `src/server/**` or `src/testing/**` (nor `cloudflare:workers`).
   - `src/index.ts` must **never** re-export `src/cli/**` or `src/testing/**`.
3. **AST-Grep Guardrails (`rules/ast-grep/`)**:
   - `hera-no-raw-effect-run`: `Effect.runPromise` / `Effect.runSync` / `Effect.runFork` are forbidden outside the designated boundary files (`src/server/routes/`, `src/server/durable-object/`, `src/cli/runtime/`, `src/testing/runner/`, plus `src/core/telemetry/export.ts` and `src/server/worker/`, the `waitUntil` Promise boundaries, and the agent plane's Promise boundaries `src/server/agent/tool/registration.ts` and `src/server/agent/host/`).
   - `hera-agent-tool-via-hera`: Pi tool registrations (`ToolRegistration`, `defineTool`, `defineExtension`, `createRegistry`, raw `parameters` + `execute` literals) are built only in `src/server/agent/`; elsewhere use `Hera.agentTool`.
   - `hera-no-global-otel`: `setGlobalTracerProvider` / `setGlobalContextManager` / `setGlobalPropagator` and `trace.getTracer` are forbidden in `src/`; build the provider per instance and use `provider.getTracer`.
   - `hera-no-effect-v3`: Legacy Effect v3 APIs (`Context.GenericTag`, `Effect.Service`, `Data.TaggedError`, `Schema.struct`, `@effect/schema`) are forbidden.
   - `hera-single-fn-syntax`: Application code must use `Hera.fn("Service.op")(function* () { ... })` instead of raw `Effect.gen` or multi-step `Effect.flatMap` chains.
   - `hera-tui-vendorable` / `hera-tui-lazy`: `src/cli/tui/` imports only its own siblings (it is vendored into public eris), and nothing else in `src/` imports it (it stays out of the `hera/cli` cold start).
   - `hera-cli-manifest-pure`: `src/cli/manifest/` imports only its own siblings, so `--help` and completion load no handler and no `effect`.
   - `hera-no-global-fetch-mutation`: no assignment to `globalThis.fetch` / `global.fetch` / `window.fetch` / `self.fetch` (or `Object.assign` / `Object.defineProperty` onto the global) in production code; thread payload changes through `HeraCli.hookPoint` + `HeraCli.hook`.
   - `hera-alarm-via-driver`: `setAlarm` / `getAlarm` / `deleteAlarm` (any literal spelling) are forbidden in `src/` outside `src/server/durable-object/alarm-driver.ts` and `src/testing/`; every alarm arm, read and clear goes through the object's `AlarmDriver`.
   - `hera-no-isolate-state`: no module-scope `let` / `var` or empty `Map` / `Set` / `WeakMap` / `WeakSet` accumulator in `src/core/**`; hold state in the object a factory returns.
   - `hera-no-hand-rolled-ctx`: Do not construct manual `Layer.succeed(HeraCtx, ...)` mocks in tests; use `HeraTest.layer(...)`.
4. **Documentation Parity**:
   - Any new public export or subpath must update `README.md`, `docs/README.md`, and the corresponding guide under `docs/guides/`.
   - `test/hygiene/repo-layout.test.ts` verifies that all required docs exist and every relative markdown link resolves.
5. **Public Tree**:
   - The public tree is `git archive <ref>`: every tracked file except the `export-ignore` paths in `.gitattributes` (write them in the `/dir/**` form). Shipped files carry no tracker key (`ABC-123` shape outside public standards), no private register label (`PRD-…`, `NFR-…`), no private-org URL and no internal product name. Provenance belongs in the tracker and the PR, not in code prose.
   - `test/hygiene/public-tree.test.ts` scans every shipped file and prints `path:line [rule]`. Internal names and private tracker prefixes are held as SHA-256 digests; add one with `printf '%s' <name> | shasum -a 256`.
   - `.gitleaks.toml` is the default rules with no allowlist: every scanner-shaped test fixture is assembled at run time (`test/fixtures/provider-tokens.ts` or a `join`), so no source line holds a whole token; CI runs gitleaks over the archived tree.

## Verification Commands

Always run all three gates before committing or opening a PR:

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # tsc --noEmit && ast-grep scan && ast-grep test --skip-snapshot-tests
bun run test        # vitest run
```
