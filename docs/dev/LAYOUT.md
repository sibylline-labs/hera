# Repository Layout & Contributor Hygiene

This document defines the directory structure, module decomposition rules, and automated hygiene checks for `@sibylline-labs/hera`.

---

## Complete Directory Tree (`src/`)

```
src/
├── index.ts                                  # Root barrel (core + server + composite Hera namespace)
├── core/                                     # Plane 1: Runtime-agnostic Effect v4 & Web Standard primitives
│   ├── index.ts
│   ├── schema/
│   │   ├── index.ts                          # HeraSchema namespace + re-exports
│   │   ├── brand/
│   │   │   ├── factory.ts                    # brandedId() nominal brand constructor
│   │   │   └── ids.ts                        # OrgId, ActorId, RequestId, Ulid, KeyHash, YakId, ClusterId, etc.
│   │   ├── decode/
│   │   │   ├── ast-describer.ts              # Expected-type AST description helpers
│   │   │   ├── decoders.ts                   # decode, decodeResult, decodeSync, encodeSync, *Strict twins
│   │   │   ├── error.ts                      # HeraSchemaError & HeraSchemaIssue
│   │   │   └── issue-formatter.ts            # Value-stripping issue formatter (never echoes raw input)
│   │   └── eris/
│   │       ├── index.ts
│   │       ├── primitives.ts                 # ServiceName, EnvName, KeyName, GcpProjectId, LogfireProject, ErrorSlug
│   │       └── srn.ts                        # Srn schema & parseSrn() (srn:sibylline:<service>:<env>:<kind>:<id>)
│   ├── config/
│   │   ├── index.ts                          # HeraConfig namespace + re-exports
│   │   ├── types.ts                          # HeraConfigValue<T> 3-state union, HeraEnv, HeraConfigError
│   │   ├── env-reader.ts                     # stripTrailingNewline, isUnconfigured, isInvalid, isValid, unwrap, match, layer
│   │   ├── secret.ts                         # HeraConfig.secret() Redacted reader
│   │   ├── hex-key.ts                        # HeraConfig.hexKey() 32-byte hex key reader
│   │   ├── keyring.ts                        # Keyring (versioned v<N>:<hex> keys) & HeraConfig.keyring()
│   │   ├── managed-variables.ts              # HeraConfig.managedVariables(): a Logfire managed variable with a code fallback
│   │   ├── dials.ts                          # HeraConfig.dials() / dialReaders(): a JSON-object variable merged over code defaults
│   │   └── primitives.ts                     # Declarative config descriptors
│   ├── errors/
│   │   ├── index.ts
│   │   ├── catalog.ts                        # HERA_ERROR_CATALOG, HeraErrorStatus, status/message resolvers
│   │   ├── types.ts                          # HeraErrorShape, HeraProblemDetails, HeraErrorDefineOptions
│   │   ├── sanitizers.ts                     # sanitizeErrorFields() & secret key scrubbing
│   │   ├── problem-details.ts                # buildProblemDetails() & serializeProblemResponse()
│   │   ├── converters.ts                     # defineHeraErrorClass(), normalizeToHeraError(), schema/config adapters
│   │   └── hera-error.ts                     # HeraError class & status factories
│   ├── logger/
│   │   ├── index.ts
│   │   ├── types.ts                          # HeraLogLevel, HeraLogEntry, HeraLogger interface
│   │   ├── shapes.ts                         # Credential-shaped runs (sib_, lin_, Bearer, 64-hex) redacted in place
│   │   ├── redaction.ts                      # Recursive secret & sensitive-key redaction helpers
│   │   ├── emit.ts                           # Never-throw line writer shared by both logger kinds
│   │   ├── serializer.ts                     # Fiber ambient (clock, span, annotations) -> emit
│   │   ├── event-logger.ts                   # HeraEventLogger<E>: typed event registry + sync twin
│   │   └── logger.ts                         # createHeraLogger() overloads & HeraLoggerService tag
│   ├── context/
│   │   ├── index.ts
│   │   ├── types.ts                          # HeraPublicCtxShape, HeraAuthedCtxShape, HeraTenantCtxShape
│   │   ├── headers.ts                        # Context shape builders & logger binding helpers
│   │   └── context.ts                        # HeraPublicCtx, HeraAuthedCtx, HeraTenantCtx, HeraCtx Service tags
│   ├── fn/
│   │   ├── index.ts
│   │   ├── span-enricher.ts                  # enrichSpanFromHeraCtx() automatic span attribute binding
│   │   └── fn.ts                             # Hera.fn("Service.op") generator & .method() wrapper
│   ├── cache/                                # HeraCache
│   │   ├── index.ts                          # HeraCache namespace
│   │   └── cache.ts                          # makeHeraCache: settled answers only, TTL, negative TTL, LRU cap
│   ├── authority/                            # HeraAuthorityVerifier port
│   │   ├── index.ts                          # barrel (never exports grantAuthorityCtx)
│   │   ├── types.ts                          # HeraAuthorityRequest, HeraAuthorityGrant, HeraAuthorityRefusal, HeraAuthorityVerifier
│   │   └── ctx.ts                            # branded HeraAuthorityCtx<V>, grantAuthorityCtx (boundary-internal)
│   ├── flags/                                # HeraFlags
│   │   ├── index.ts                          # HeraFlags namespace
│   │   ├── types.ts                          # HeraFlagContext, HeraFlagReason, HeraFlagSnapshot, HeraFlagReader, HeraOfrepOptions
│   │   ├── ofrep-wire.ts                     # OFREP bulk wire: contextKey, requestBody (org_id default), decodeBulk
│   │   ├── ofrep.ts                          # HeraFlags.ofrep: per-context HeraCache + ETag revalidation over HeraHttp.request
│   │   └── reader.ts                         # HeraFlags.fromSource: fallback, schema decode, one warn per context and cause per window
│   ├── object-store/                         # HeraObjectStore
│   │   ├── index.ts                          # HeraObjectStore namespace
│   │   ├── types.ts                          # HeraObjectStoreClient, HeraStoredObject, get/head/list results
│   │   ├── r2-s3.ts                          # HeraObjectStore.r2S3: R2 over the S3 endpoint, on HeraHttp.requestBytes
│   │   ├── credentials.ts                    # credentialsFromApiToken (token id + SHA-256 of the token)
│   │   ├── sigv4.ts                          # signSigV4 over WebCrypto
│   │   ├── s3-xml.ts                         # ListObjectsV2 and <Error><Code> parsers
│   │   ├── metadata.ts                       # key / customMetadata checks, x-amz-meta-* mapping, etag quoting
│   │   └── errors.ts                         # upstream failures → precondition_failed / rate_limited / upstream_error
│   ├── openapi/                              # HeraOpenApi
│   │   ├── index.ts                          # HeraOpenApi namespace
│   │   ├── types.ts                          # HeraOpenApiOperation, HeraOpenApiSpec, HeraOpenApiDocument
│   │   ├── components.ts                     # Effect schema → OpenAPI JSON Schema; one components.schemas pool, conflicting names throw
│   │   └── document.ts                       # HeraOpenApi.document(): paths, parameters, request bodies, responses
│   └── http/
│       ├── index.ts
│       ├── errors.ts                         # HeraHttpError & RateLimitedError
│       ├── retry-after.ts                    # parseRetryAfter() (delta-seconds & HTTP-date)
│       ├── body-reader.ts                    # readTextBounded() streaming reader with byte ceiling
│       ├── gunzip.ts                         # gunzipBounded() / gunzipBase64Bounded(): gzip decode cut at a byte limit
│       ├── request-body.ts                   # readBody(): the capped request-body reader (routes + handlers)
│       ├── problem-response.ts               # toProblemResponse() helper
│       ├── raw.ts                            # HeraHttp.raw(): a route success as the bare JSON value
│       ├── graphql-errors.ts                 # extractGraphqlErrors() bounded errors[] reader
│       ├── graphql-body-errors.ts            # graphqlErrorsInBody(): errors[] from a non-2xx body (internal)
│       ├── graphql.ts                        # HeraHttp.graphql (errors[] → GraphqlError, data decode)
│       ├── client.ts                         # HeraHttp.request / get / post / put / patch / delete / graphql
│       └── oauth2/
│           ├── index.ts                      # HeraOAuth2 namespace
│           ├── errors.ts                     # HeraOAuth2Error (invalid_grant / invalid_client / upstream)
│           ├── token-pair.ts                 # HeraOAuth2TokenPair, OAuth code & token-pair parsers
│           └── client.ts                     # HeraOAuth2.client: exchangeCode / refresh / revoke
├── server/                                   # Plane 2: Cloudflare Worker & Durable Object plane
│   ├── index.ts
│   ├── agent/
│   │   ├── index.ts                          # @sibylline-labs/hera/agent: Hera (fn, agent, agentTool), HeraAgentModels, HeraAgentEgress, errors
│   │   ├── errors.ts                         # agent_tool_input_invalid, agent_egress_host_denied, agent_egress_unconfigured
│   │   ├── models/catalog.ts                 # closed HeraAgentModelId catalog (gemma default, argon@low fallback)
│   │   ├── egress/                           # config (gateway route, headers), allowlist, provider-chunk, metered-streams, meter, egress
│   │   ├── tool/                             # agent-tool (Hera.agentTool, branded HeraAgentTool), registration (the only Pi ToolRegistration builder)
│   │   ├── host/                             # agent-host (Hera.agent), lifecycle-driver (LifecycleAlarmDriver, hera:composite)
│   │   └── telemetry/                        # @sibylline-labs/hera/agent/telemetry (not in the root barrel): types, span, content-keys, scrub-span, genai-filter, otlp, pipeline, genai-map, carrier, pi-adapter, agent-telemetry
│   ├── durable-object/
│   │   ├── index.ts
│   │   ├── types.ts                          # HeraMigration, HeraOutboxRecord, HeraSyncTx, SyncEffect
│   │   ├── naming.ts                         # orgDoName, parseOrgDoName, getTenantStub, requireTenantDoOrgId
│   │   ├── run-naming.ts                     # orgRunDoName, parseOrgRunDoName, getTenantRunStub, isRunKey
│   │   ├── base-do.ts                        # HeraDurableObjectBase: migrations, db, outbox, jobs, composite alarm
│   │   ├── keyed-do.ts                       # KeyedDurableObject (non-tenant, key codec)
│   │   ├── jobs/
│   │   │   ├── types.ts                      # HeraJobScheduler, HeraJobRegistry, HeraJobError
│   │   │   ├── store.ts                      # _hera_jobs DDL & row queries (lease, earliest-wins upsert)
│   │   │   ├── cron.ts                       # effect/Cron parse & next tick (UTC)
│   │   │   └── scheduler.ts                  # this.jobs writes & the due-jobs pass
│   │   ├── migrations/
│   │   │   └── runner.ts                     # Monotonic SQLite migration runner under blockConcurrencyWhile
│   │   ├── outbox/
│   │   │   ├── schema.ts                     # Outbox DDL & exponential backoff calculator
│   │   │   ├── sequence.ts                   # _hera_outbox_seq: the ordered enqueue's per-object sequence and its seed
│   │   │   ├── store.ts                      # SQLite outbox enqueue, claim, ack, and dead-letter queries
│   │   │   ├── alarm-slot.ts                 # Composite alarm slot: clamp, sync, wake re-arm, domain schedule
│   │   │   ├── composite-alarm.ts            # One alarm pass: drain, domain hook, due jobs, earliest-wins re-arm
│   │   │   ├── queue-sink.ts                 # HeraOutbox.queueSink: encode, chunked sendBatch, oversize reject
│   │   │   ├── send-chunks.ts                # Queue limits, UTF-8 sizing, pure sendBatch chunk planner
│   │   │   ├── sink-result.ts                # Lift a sink/hook result (Effect | Promise | value) into Effect
│   │   │   └── drainer.ts                    # Outbox due-prefix drainer & default queue sink
│   │   ├── sql/
│   │   │   ├── storage-adapter.ts            # Cloudflare SqlStorage cursor normalizer
│   │   │   └── sync-tx.ts                    # SyncTx synchronous transaction token & async-yield guard
│   │   └── tenant-do.ts                      # TenantDurableObject (OrgId key, tenant ctx)
│   ├── routes/
│   │   ├── index.ts
│   │   ├── types.ts                          # HeraPublicRouteSpec, HeraAuthedRouteSpec, HeraRoute
│   │   ├── headers.ts                        # Method check, path param extraction, scope & tenant auth validation
│   │   ├── path-match.ts                     # matchRoutePath (`:param` and `{param}` segments), joinRoutePath, isUnderPrefix
│   │   ├── body.ts                           # Request params/query/headers/JSON body decoding
│   │   ├── response.ts                       # Exit-to-Response boundary converter & 503 defect handler
│   │   ├── public-route.ts                   # publicRoute() boundary & capability gate
│   │   ├── authed-route.ts                   # authedRoute() & tenantRoute() boundaries & capability gates
│   │   ├── authority.ts                      # authorizeRoute(): authority-guarded route spec, verifier call, refusal → 403, fixed defect
│   │   ├── authority-redact.ts               # exact-credential then shape redaction of verifier text and fields (cycle-safe walk)
│   │   └── webhook/
│   │       ├── index.ts                      # HeraWebhook namespace (verifyHmac, stripe, refusalReason)
│   │       ├── types.ts                      # HeraWebhookOptions (parse), secret/timestamp unions (header, read, signed), HeraWebhookRefusal
│   │       ├── signature.ts                  # Signature decode (exact digest length), key set, timestamp parse/tolerance
│   │       ├── candidates.ts                 # decodeCandidates(): the decoded signature set of a parsed header, capped at 8
│   │       ├── stripe.ts                     # HeraWebhook.stripe preset: Stripe-Signature parse, `${t}.${body}` payload
│   │       └── verify-hmac.ts                # verifyHmac(): body cap, constant-time verify over every key x candidate, fixed 401
│   └── rpc/
│       ├── index.ts
│       ├── types.ts                          # HeraRpcMethodSpec, HeraRpcResult, HeraRpcClientOptions
│       ├── envelope.ts                       # RPC wire envelope helpers & serviceUnavailableCode()
│       ├── method.ts                         # rpcMethod() server boundary
│       ├── client.ts                         # rpcClient() caller: error hydration & 503 transport mapping
│       └── retry.ts                          # isRetryableTransportError, opt-in retry loop, backoff, attempt timeout
├── cli/                                      # Plane 3: Runtime-neutral CLI plane (@sibylline-labs/hera/cli)
│   ├── index.ts
│   ├── hera-cli.ts                           # HeraCli composite namespace
│   ├── errors/
│   │   ├── index.ts
│   │   ├── scrubber.ts                       # scrubFreeText() credential/token scrubber
│   │   ├── scrub-rules.ts                    # REDACTION_CLASSES and the ordered scrub rule table
│   │   ├── eris-error.ts                     # ErisError class & exit code factories (1, 2, 3, 124)
│   │   └── failure-block.ts                  # renderFailureBlock() (ERROR / slug / fix / docs) & resolveErisHome()
│   ├── manifest/                             # @sibylline-labs/hera/cli/manifest: pure, siblings-only (hera-cli-manifest-pure)
│   │   ├── index.ts
│   │   ├── types.ts                          # Verb/group/plugin/extension specs, HeraCliArgsOf, eris-help/1 shapes
│   │   ├── flag.ts                           # flag.boolean/string/number, operand.required/optional/rest
│   │   ├── define.ts                         # defineVerb, defineArgs, defineGroup, definePlugin, defineExtension, hookPoint
│   │   ├── compose.ts                        # composeProgram(): path table, extension merge, HeraCliManifestError
│   │   ├── words.ts                          # Completion word & domain-helper checks
│   │   ├── tokenize.ts                       # Strict argv grammar → raw args or a slugged refusal
│   │   ├── route.ts                          # Global --output/--json pre-pass & command routing
│   │   ├── help.ts                           # Prose help, eris-help/1 help-json, docs
│   │   ├── completion.ts                     # Deterministic bash/zsh completion script
│   │   └── run-pure.ts                       # runPure(): answers help, version, completion, docs without a handler
│   ├── runtime/
│   │   ├── index.ts
│   │   ├── verb.ts                           # HeraCli.verb() overloads (plain / authority-guarded)
│   │   ├── cli-ctx.ts                        # HeraCliCtx Service & ctx shape builders
│   │   ├── authority.ts                      # authorize(): credential read, verifier call, refusal → ErisError
│   │   ├── usage.ts                          # deriveUsageSlug() & summarizeSchemaIssues()
│   │   ├── args-schema.ts                    # Schema derived from a composed verb's flags & operands
│   │   ├── handler.ts                        # HeraCli.handler, HeraCli.extensionHooks (lazy-loaded halves)
│   │   ├── hooks.ts                          # HeraCliHooks service, HeraCli.hook, HeraCli.on
│   │   ├── program.ts                        # HeraCli.program / runProgram: runPure, load, decode, run under verb()
│   │   └── pool.ts                           # forEachBounded(), resolveConcurrency(), resolveDeadlineMs()
│   ├── process/
│   │   ├── index.ts
│   │   ├── types.ts                          # RunnerExecOptions, RunnerExecResult, ProcessEntry
│   │   ├── spawn.ts                          # Process tree snapshot (psSnapshot, subtree, signalTree)
│   │   └── runner.ts                         # Runner subprocess service with timeout & SIGTERM->SIGKILL escalation
│   ├── fs/
│   │   ├── index.ts
│   │   ├── pair-types.ts                     # PairStep, PairOptions, PairResult, PairStage
│   │   ├── pair-signals.ts                   # Stage removal on SIGINT/SIGTERM/SIGHUP
│   │   ├── pair-commit.ts                    # Stage writes, prev/ snapshot, rename set + rollback
│   │   ├── atomic-pair-writer.ts             # AtomicPairWriter: stagePair, writePair, writePairEffect
│   │   ├── write-file-atomic.ts              # writeFileAtomic: one-file temp + rename
│   │   ├── lock-helpers.ts                   # PID liveness, lock snapshots (inode + pid) & identity-checked removal
│   │   ├── break-mutex.ts                    # `<lock>.break` mutex every lock removal runs under
│   │   └── dir-lock.ts                       # DirLock stale-PID-aware directory lock
│   └── tui/                                  # @sibylline-labs/hera/tui: lazy, dependency-free, vendored into public eris
│       ├── index.ts                          # HeraTui namespace & barrel
│       ├── types.ts                          # TuiIo port, step types, TuiAnswers<Steps>
│       ├── steps.ts                          # prompt(), select(), confirm() & askStep()
│       ├── flow.ts                           # run(): asks steps in order, `when` skips, EOF cancels
│       └── io.ts                             # lineReader(), terminalIo(), scriptedIo()
└── testing/                                  # Plane 4: Test harness (@sibylline-labs/hera/testing)
    ├── index.ts
    ├── hera-test.ts                          # HeraTest composite namespace
    ├── fixtures/                             # SAMPLE_IDS, makeTestHexKey, makeTestKeyring
    ├── context/                              # makeTestLayer, makeTestCtx, makeTestTenantCtx, withTestEnv
    ├── runner/                               # runTest, runTestExit, advanceClock, setClock
    ├── http-rpc/                             # makeTestRouteRequest, makeTestRpcDouble, parseProblemDetailsResponse
    ├── authority/                            # makeTestAuthority (HeraTest.authority): fake HeraAuthorityVerifier, fails closed
    ├── flags/                                # makeTestFlags (HeraTest.flags): in-memory HeraFlagReader on HeraFlags.fromSource
    ├── object-store/                         # makeTestObjectStore (HeraTest.objectStore): in-memory HeraObjectStoreClient
    ├── telemetry/                            # makeTestTelemetry (HeraTest.telemetry): real HeraTelemetry over an in-memory OTLP host
    ├── agent/                                # @sibylline-labs/hera/testing/agent: HeraAgentTest, scripted-model (the egress seam's scripted upstream)
    ├── workers-stub/                         # /testing/cloudflare-workers stub & /testing/bun-preload (cloudflare:workers outside workerd)
    └── durable-object/                       # @sibylline-labs/hera/testing/durable-object: in-memory SQLite DO harness, DO-backed layer & HeraTest
```

---

## Code Hygiene Standards

### 1. Maximum 300 Lines per File

Every `.ts` file under `src/` must be **≤ 300 lines** (enforced by [`test/hygiene/repo-layout.test.ts`](../../test/hygiene/repo-layout.test.ts)). When a module grows beyond ~220 lines, split it along domain responsibilities:
- Separate **types/schemas** (`types.ts`, `schema.ts`) from **core operations** (`client.ts`, `runner.ts`, `tenant-do.ts`) and **pure leaf helpers** (`headers.ts`, `sanitizers.ts`, `retry-after.ts`, `pair-types.ts`).

### 2. No Inline Trivial Helpers Inside Core Functions

Do **not** define pure helper functions (header normalizers, AST walkers, retry-after parsers, secret scrubbers, SQLite row normalizers) inside the body of a route builder, Effect generator, or class method. Extract them to a dedicated leaf module so they can be unit-tested directly and keep core control flow concise.

### 3. No Private References in the Public Tree

Every file `git archive` ships (all tracked files except the `export-ignore` paths in [`.gitattributes`](../../.gitattributes)) carries no tracker key, private register label, private-org URL or internal product name (enforced by [`test/hygiene/public-tree.test.ts`](../../test/hygiene/public-tree.test.ts)), and no secret-shaped string outside a fixture that [`.gitleaks.toml`](../../.gitleaks.toml) names (enforced by the CI `secrets` job). Write what the code does and why; leave the ticket that asked for it to the PR.

### 4. Adding a New Module or Subpath

When adding a new capability:
1. Place it in the appropriate plane (`src/core/`, `src/server/`, `src/cli/`, or `src/testing/`). A product wire contract is not framework code: it belongs in the contracts package that consumes Hera as a peer.
2. Re-export its public API from the domain's `index.ts` barrel and the plane's `index.ts` barrel.
3. If it belongs on the Worker/Server surface, re-export it from `src/index.ts`. If it is CLI-only, re-export it **only** from `src/cli/index.ts`.
4. Add unit tests under `test/` and update the relevant guide under `docs/guides/`.
5. Run `bun run typecheck`, `bun run lint`, and `bun run test`.

### 5. The Posture-Check Surface Registry

`.claude/surfaces.yml` registers the `secrets` surface (redaction, secret readers, scrubbers) that `/posture-check` grades a diff against, and `thoughts/vocabulary/secrets.md` holds its defect classes. The registry, its taxonomy and its guard test are maintainer-only and are not part of the public tree. When you move or rename a listed file, update the registry in the same change: `test/hygiene/surfaces.test.ts` fails on a path that no longer resolves or a missing taxonomy file. Entries are exact files or `dir/**`.
