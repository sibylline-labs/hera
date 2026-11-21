---
name: hera-sdk
description: |
  Build TypeScript services, Cloudflare Workers, Durable Objects, and CLIs using the Hera SDK (`@sibylline-labs/hera`) — the opinionated Effect v4 LTS runtime.
  Use this skill whenever writing or reviewing TypeScript backend, edge Worker, Durable Object, RPC, or CLI code in a repo that depends on `@sibylline-labs/hera`: defining schemas or config with `HeraSchema`/`HeraConfig`, accessing `HeraPublicCtx`/`HeraAuthedCtx`/`HeraTenantCtx` or `ctx.logger`, declaring functions with `Hera.fn` and domain errors with `HeraError.define`, building routes/RPC with `Hera.publicRoute`/`Hera.authedRoute`/`Hera.rpcMethod`/`Hera.rpcClient`, consuming Cloudflare Queues with `Hera.queueConsumer`, writing stateful actors with `Hera.TenantDurableObject`, building CLI verbs with `HeraCli`, calling outbound services with `HeraHttp`, or testing with `HeraTest` (`@sibylline-labs/hera/testing`).
---

# Hera SDK (`@sibylline-labs/hera`)

Hera is the opinionated Effect v4 LTS runtime for Sibylline TypeScript services, Cloudflare Workers, Durable Objects, and CLIs.

Every pattern in Hera rests on five invariants:
1. **Four isolated planes (`src/core/`, `src/server/`, `src/cli/`, `src/testing/`)**: The root `@sibylline-labs/hera` entrypoint exports Core and Server primitives; product wire contracts live in their own package, which takes Hera as a peer; standalone CLIs import from `@sibylline-labs/hera/cli` (zero `cloudflare:workers` imports); test suites import from `@sibylline-labs/hera/testing`. Every source file is ≤ 300 lines with pure leaf helpers extracted into dedicated modules.
2. **Constrained Effect surface**: Service authors use **`Hera.fn("Service.op")(function* () { ... })`** for 100% of effectful logic. Raw `Effect.gen`, raw `Effect.fn`, multi-step `Effect.flatMap` chains, and raw `Effect.runPromise` / `Effect.runSync` / `Effect.runFork` calls in application code are banned by `ast-grep`.
3. **Effect v4 LTS only**: Effect v3 APIs (`Context.GenericTag`, `Effect.Tag`, `Effect.Service`, `Effect.provideService`, `Effect.catchAll`, `Layer.effectContext`, `Schema.struct`, `Schema.TaggedError`, `Data.TaggedError`, `@effect/schema`) are banned by `hera-no-effect-v3`.
4. **Type-level auth & tenancy progression**: Context is split into `HeraPublicCtx`, `HeraAuthedCtx`, and `HeraTenantCtx`. A function requiring `HeraTenantCtx` (`orgId: OrgId`) **cannot compile** when wired to `Hera.publicRoute`.
5. **Single-threaded Durable Object transactions**: Inside `this.db.transactSync(function* (tx) { ... })` and `this.db.transactWithOutbox(function* (tx) { ... })`, `tx` executes synchronously inside `storage.transactionSync` (forbidding async Promise/Effect yields) and `transactWithOutbox` stages outbox messages atomically via `tx.enqueueOutbox(...)` in the same SQLite commit.

---

## Quick Start Skeleton

```typescript
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

export class OrderQuotaExceededError extends HeraError.define(
  "OrderQuotaExceededError",
  {
    code: "quota_exceeded",
    status: 429,
    publicMessage: "Order exceeds tenant limit",
    fields: { orgId: OrgId, limit: Schema.Number },
  },
) {}

export const createOrder = Hera.fn("OrderService.createOrder")(function* (input: {
  readonly orderId: OrderId;
  readonly amountCents: number;
}) {
  const ctx = yield* HeraTenantCtx.current;
  yield* ctx.logger.info("order.creating", {
    orderId: input.orderId,
    amountCents: input.amountCents,
  });

  if (input.amountCents > 100_000_00) {
    return yield* new OrderQuotaExceededError({
      orgId: ctx.orgId,
      limit: 100_000_00,
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

`HeraError.define` takes the catalog `code`, an optional `status` and `publicMessage`, and the schema `fields`. An instance is constructed from the fields alone. An `authedRoute` spec uses `scopes` (all required), `anyOfScopes` (at least one), and `actorKind` (one kind or an array).

---

## Surface 1: `HeraSchema` & `HeraConfig`

Use `effect/Schema` (`Schema.Struct`, `Schema.String`, `Schema.Number`, `Schema.Array`, `Schema.Union`) together with `HeraSchema` branded primitives (`OrgId`, `ActorId`, `RequestId`, `Ulid`, `Srn`, `ServiceName`, `EnvName`, `KeyName`, `GcpProjectId`, `LogfireProject`, `ErrorSlug`, `HeraSchema.brandedId`) and `HeraConfig` 3-state (`Unconfigured` | `Invalid` | `Valid<T>`) secret/hexKey/keyring readers.

```typescript no-check
// # WRONG — raw unbranded strings, process.env reads, and Effect v3 @effect/schema
import { Schema } from "@effect/schema";

const OrderInput = Schema.struct({
  orgId: Schema.String,
  apiKey: Schema.String,
});
const apiKey = process.env.BILLING_API_KEY!;
```

```typescript
// # RIGHT — Effect v4 effect/Schema, HeraSchema branded IDs, and HeraConfig 3-state readers
import * as Schema from "effect/Schema";
import { Hera, HeraConfig, HeraSchema, OrgId } from "@sibylline-labs/hera";

export const InvoiceId = HeraSchema.brandedId("InvoiceId", /^inv_[0-9A-HJKMNP-TV-Z]{26}$/);
export type InvoiceId = typeof InvoiceId.Type;

export const OrderInput = Schema.Struct({
  orgId: OrgId,
  invoiceId: InvoiceId,
  service: HeraSchema.ServiceName,
});

// A reader is yielded directly: it reads HeraEnv and fails with HeraConfigError when the
// secret is Unconfigured or Invalid. The value stays Redacted until HeraConfig.unwrap.
export const loadBillingSecrets = Hera.fn("BillingConfig.load")(function* () {
  const apiKey = yield* HeraConfig.secret("BILLING_API_KEY", Schema.String);
  const keyring = yield* HeraConfig.keyring("BILLING_KEYRING");

  return { apiKey, keyring };
});
```

---

## Surface 2: `HeraCtx` & `HeraLogger` (`HeraPublicCtx`, `HeraAuthedCtx`, `HeraTenantCtx`)

Hera provides distinct request/invocation context tags so route auth is verified at compile time:
- **`HeraPublicCtx`**: `{ requestId, service, logger, now }`
- **`HeraAuthedCtx`**: `{ ...HeraPublicCtx, orgId, actorId, actorKind, scopes, productCtx }`
- **`HeraTenantCtx`**: `{ orgId, requestId, actorId, actorKind, scopes, service, db, logger, scheduleDomainAlarm, now }`

`ctx.logger` emits structured JSON logs carrying `ts`, `level`, `service`, `msg`, `request_id`, `org_id`, `actor_id`, and `fields` with automatic recursive secret/PII redaction.

```typescript
// # WRONG — hand-rolled header extraction and console.log(JSON.stringify(...))
export async function handleRequest(request: Request) {
  const requestId = request.headers.get("X-Request-Id") ?? crypto.randomUUID();
  const auth = request.headers.get("Authorization");
  console.log(JSON.stringify({ level: "info", msg: "handling request", requestId, auth }));
}

// # RIGHT — yield* HeraTenantCtx.current (or HeraAuthedCtx.current / HeraPublicCtx.current) and ctx.logger
import { Hera, HeraTenantCtx } from "@sibylline-labs/hera";

export const auditTenantMutation = Hera.fn("AuditService.auditTenantMutation")(
  function* (resourceId: string) {
    const ctx = yield* HeraTenantCtx.current;
    yield* ctx.logger.info("audit.mutation", {
      resourceId,
      orgId: ctx.orgId,
    });
    return { requestId: ctx.requestId, orgId: ctx.orgId };
  },
);
```

---

## Surface 3: `Hera.fn`, `HeraError`, Routes & Cloudflare RPC

### `Hera.fn` & `HeraError`

All effectful functions use `Hera.fn("Service.method")(function* (...) { ... })`. Domain errors use `HeraError.define("Tag", { code, status?, publicMessage?, fields? })` or the status factories (`HeraError.badRequest`, `HeraError.unauthorized`, `HeraError.forbidden`, `HeraError.notFound`, `HeraError.conflict`, `HeraError.rateLimited`, `HeraError.serviceUnavailable`). Route boundaries translate `HeraError` instances into RFC 7807 problem details (`application/problem+json`: `type`, `title`, `status`, `detail`, plus `code` and `request_id` extension members); RPC methods return an `{ ok: false, status, code, … }` POJO instead.

```typescript
// # WRONG — raw Effect.gen, multi-step Effect.flatMap, Data.TaggedError, and Effect.runPromise
import { Data, Effect, pipe } from "effect";

class UserNotFound extends Data.TaggedError("UserNotFound")<{ readonly id: string }> {}

const loadUser = (id: string) =>
  pipe(
    Effect.succeed(id),
    Effect.flatMap((uid) => Effect.fail(new UserNotFound({ id: uid }))),
    Effect.flatMap((user) => Effect.succeed(user)),
  );

export async function rawEndpoint(id: string) {
  return await Effect.runPromise(loadUser(id));
}

// # RIGHT — Hera.fn generator syntax, HeraError.notFound / HeraError.define, and Hera.authedRoute
import * as Schema from "effect/Schema";
import { Hera, HeraError, HeraTenantCtx } from "@sibylline-labs/hera";

export const getUser = Hera.fn("UserService.getUser")(function* (userId: string) {
  const ctx = yield* HeraTenantCtx.current;
  if (userId === "usr_missing") {
    return yield* HeraError.notFound("Resource not found", {
      code: "resource_not_found",
      fields: { resource: "user", userId },
    });
  }
  return { id: userId, orgId: ctx.orgId };
});

export const getUserRoute = Hera.authedRoute({
  method: "GET",
  path: "/v1/users/:id",
  params: Schema.Struct({ id: Schema.String }),
  handler: ({ params }) => getUser(params.id),
});
```

### Cloudflare Worker RPC (`Hera.rpcMethod`, `Hera.rpcClient`)

`Hera.rpcMethod` spec: `{ name?, service?, input?, layer?, onDefect?, handler: (input, ctx) => Effect }` (no `output` schema; `ctx` is `{ method, service, requestId, heraCtx, tenant? }`). The wire result is `{ ok: true, value }` or `{ ok: false, status, code, error, message, requestId?, retryAfter?, issues?, fields? }`.

`Hera.rpcClient(binding | () => binding, { service?, codes?, onTransportError?, retry? })` turns each method of a service binding or DO stub into an `Effect`. A wire failure is rehydrated into `HeraError`; a rejected call becomes `503 <service>_unavailable` with `fields.retryable`. Retry is opt-in: `retry: { attempts, backoff?, timeoutMs?, isRetryable?, onRetry? }` re-runs a rejected or timed-out call with full-jitter backoff on the Effect `Clock`, a fresh stub per attempt, and never retries an `{ ok: false }` refusal or an `overloaded`/`remote` error (`timeoutMs` only for calls safe to apply twice). It does **not** forward `HeraCtx`: the callee takes its tenant from `input.orgId` or the invoke `meta`.

```typescript
import * as Schema from "effect/Schema";
import { Hera, OrgId } from "@sibylline-labs/hera";

export const VerifyTokenRpc = Hera.rpcMethod({
  name: "verifyToken",
  service: "accounts",
  input: Schema.Struct({ token: Schema.String, orgId: OrgId }),
  handler: (input) =>
    Hera.fn("AccountsRpc.verifyToken")(function* () {
      return { valid: input.token.length > 0, orgId: input.orgId };
    })(),
});

// Caller side: wrap the binding, rehydrate HeraError, and retry only transient transport failures
export const verifyTokenClient = Hera.rpcClient(
  { verifyToken: VerifyTokenRpc },
  { service: "accounts", retry: { attempts: 3, backoff: { baseMs: 50, maxMs: 1000 } } },
);

export const verifyWithRetry = (token: string, orgId: OrgId) =>
  verifyTokenClient.verifyToken({ token, orgId });
```

---

## Surface 4: `TenantDurableObject`, `SyncTx` & Transactional Outbox

`Hera.TenantDurableObject` enforces single-threaded actor safety:
- `this.db.transactSync(function* (tx) { ... })` and `this.db.transactWithOutbox(function* (tx) { ... })` execute a synchronous SQLite transaction over `SyncTx` effects (`tx.exec`, `tx.query`, `tx.enqueueOutbox`). Yielding a Promise or async Effect inside is a compile error, and if forced it fails with `SyncTxAsyncViolationError` and rolls back the SQLite transaction.
- `tx.enqueueOutbox({ type, payload, id?, requestId?, availableAt? })` stages an outbox record inside the **same SQLite transaction** as your state write. `transactWithOutbox` arms the composite DO alarm on commit.
- `alarm()` drains due outbox batches through `deliverOutboxBatch(records)` with bounded exponential backoff.
- The platform alarm has one owner, the object's `AlarmDriver` (`StorageAlarmDriver` by default). Never call `ctx.storage.setAlarm`/`getAlarm`/`deleteAlarm` yourself (`hera-alarm-via-driver`): schedule named jobs (`this.jobs`) or the domain slot. A host that hands the alarm to an `agents` `Lifecycle` overrides `createAlarmDriver()` and `alarm()`, and runs `runCompositePass()` from a host job. `purgeStorage()` empties the object (alarm, `beforePurge`, purged mark, `deleteAll`, deferred `ctx.abort`); after the mark `this.db` refuses every statement and nothing re-initialises, and `isPurged()` lets a host answer its own 404/409 first. Guide: `docs/guides/durable-objects.md`.

```typescript
// # WRONG — awaiting async I/O inside a DO storage mutation and publishing to a queue outside the transaction
export class UnsafeTenantDO {
  async mutate(state: DurableObjectState, key: string, value: unknown, queue: Queue) {
    await state.storage.put(key, value);
    await queue.send({ key, value }); // Lost if Worker crashes after put!
  }
}

// # RIGHT — TenantDurableObject.configure with synchronous db.transactWithOutbox + atomic tx.enqueueOutbox
import {
  Hera,
  HeraTenantCtx,
  TenantDurableObject,
  type HeraOutboxRecord,
} from "@sibylline-labs/hera";

export class OrderTenantDO extends TenantDurableObject.configure({
  service: "orders-do",
  migrations: [
    {
      version: 1,
      name: "create_orders",
      sql: "CREATE TABLE orders (id TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL);",
    },
  ],
}) {
  recordOrder(input: { orderId: string; amountCents: number }) {
    const db = this.db;
    return this.runWithTenantCtx(
      Hera.fn("OrderTenantDO.recordOrder")(function* () {
        yield* HeraTenantCtx.current;
        return yield* db.transactWithOutbox(function* (tx) {
          yield* tx.exec("INSERT INTO orders (id, amount_cents) VALUES (?, ?)", [
            input.orderId,
            input.amountCents,
          ]);
          const outbox = yield* tx.enqueueOutbox({
            type: "order.created",
            payload: input,
          });
          return { orderId: input.orderId, outboxId: outbox.id };
        });
      })(),
    );
  }

  protected override deliverOutboxBatch(records: ReadonlyArray<HeraOutboxRecord>) {
    return Hera.fn("OrderTenantDO.deliverOutboxBatch")(function* () {
      void records;
    })();
  }
}
```

### Cloudflare Queues consumer (`Hera.queueConsumer`)

`Hera.queueConsumer({ name, service?, schema?, retryDelaySeconds?, logger?, handler: (batch, env) => Effect })` returns the Worker `queue` handler. Each body is decoded with `schema`; one that fails goes to `batch.invalid` (raw body + `{ path, code }` issues) beside `batch.messages`, so it never fails the batch. The handler's exit settles the batch once: success `ackAll()`; a `HeraError` with `fields.retryable === true` `retryAll({ delaySeconds: retryAfter ?? retryDelaySeconds ?? 30 })`; any other failure, a defect or an interrupt `retryAll()` plus an error log. Never call `ackAll`/`retryAll` or `Effect.runPromise` yourself in a queue handler. Guide: `docs/guides/workers-and-routes.md#3-queue-consumers-heraqueueconsumer`.

---

## Surface 5: `HeraCli` & `HeraHttp` (`@sibylline-labs/hera/cli` & `@sibylline-labs/hera`)

### `HeraCli` (`HeraCli.verb`, `ErisError`, `Runner`, `AtomicPairWriter`, `writeFileAtomic`, `DirLock`)

Standalone CLIs (`eris`, for one) import from `@sibylline-labs/hera/cli` for value-stripping `Schema` arg validation, `ErisError` failure blocks (`ERROR <what>`, `slug:`, `fix:`, `docs:`), and deterministic exit codes (`0` ok, `1` operational, `2` usage, `3` precondition, `124` timeout). `ErisError.operational | usage | precondition | timeout(slug, { what, fix?, docs? })` build the error; `HeraCli.Runner` runs subprocesses with `runner.run({ cmd, args })`. The CLI entrypoint exports `fn` (the same function as `Hera.fn`), not the `Hera` namespace. Replace a file with `HeraCli.writeFileAtomic(file, data, { mode?, mkdir? })`, never a hand-rolled `.tmp` + `renameSync`; write an env-file set with `HeraCli.writePair` / `HeraCli.stagePair`.

```typescript
// # WRONG — raw process.argv parsing and unstructured console.error + process.exit
const target = process.argv[2];
if (!target) {
  console.error("Missing target");
  process.exit(1);
}

// # RIGHT — HeraCli.verb with schema-validated args and HeraCliCtx
import * as Schema from "effect/Schema";
import { EnvName, HeraCli, fn } from "@sibylline-labs/hera/cli";

export const verifyVerb = HeraCli.verb({
  name: "eris verify",
  slug: "verify-usage",
  args: Schema.Struct({
    env: EnvName,
  }),
  handler: (args, ctx) =>
    fn("VerifyCli.verify")(function* () {
      ctx.stdout(JSON.stringify({ env: args.env, verified: true }) + "\n");
    })(),
});
```

### `HeraTui` (`@sibylline-labs/hera/tui`)

Guided `prompt` / `select` / `confirm` steps for a CLI verb that asks a human. Load it lazily with `await import("@sibylline-labs/hera/tui")` inside the verb, run `HeraTui.run(steps, HeraTui.terminalIo({ input: process.stdin, output: process.stdout }))`, and drive it headlessly in tests with `HeraTui.scriptedIo(lines)`. See `docs/guides/tui.md`.

### `HeraHttp` (`HeraHttp.request`, `HeraHttp.get`, `HeraHttp.post`)

Use `HeraHttp` for outbound HTTP calls inside `Hera.fn`. It enforces a single whole-exchange timeout (`AbortController` spanning connect, headers, bounded streaming body read via `maxBytes`, and `HeraSchema` decode) and parses RFC 9110 `Retry-After` headers on `429` into `RateLimitedError`.

---

## Surface 6: `HeraTest` (`@sibylline-labs/hera/testing`)

Never construct `Layer.succeed(HeraCtx, ...)` by hand in tests (`hera-no-hand-rolled-ctx`). Use `HeraTest` from `@sibylline-labs/hera/testing`:
- **`HeraTest.layer(options?)`**: Provides `HeraPublicCtx`, `HeraAuthedCtx`, `HeraTenantCtx`, `HeraCtx`, `HeraEnv`, and `HeraLoggerService` with a controllable clock. From `/testing/durable-object` it also backs `HeraTenantCtx.db` with in-memory SQLite (`migrations`, `seedSql`).
- **`HeraTest.runTest(effect, layer?)`**: Runs an `Effect` to a `Promise`, providing `layer` (usually `HeraTest.layer(options)`) when given. An effect that yields `HeraTenantCtx` needs the layer.
- **`HeraTest.makeTestRpcDouble(serviceName, impl)`**: Wraps an object of service methods. It returns those methods plus `client` (a pre-bound `Hera.rpcClient`), `calls`, `clearCalls()`, `unreachable` / `setUnreachable(unreachable?, { mode })`, `rateLimited(retryAfterSeconds?)` / `clearRateLimit()`, `defectOnNextCall(error?, opts?)`, and `resetFaults()`.
- **`HeraTest.makeTestTenantDoHarness(DoClass, options?)`** (import `HeraTest` from `@sibylline-labs/hera/testing/durable-object`; `/testing` needs no ambient types and omits the DO members): Instantiates a `TenantDurableObject` subclass over in-memory SQLite with an outbox and alarm harness: `harness.instance`, `harness.inspectOutbox()`, and `harness.triggerAlarm()`.

```typescript no-check
// # WRONG — raw Layer.succeed(HeraTenantCtx, ...) mock and manual Effect.runPromise
import { Effect, Layer } from "effect";
import { HeraTenantCtx } from "@sibylline-labs/hera";

const fakeLayer = Layer.succeed(HeraTenantCtx, { orgId: "org_1" } as any);
await Effect.runPromise(Effect.provide(createOrder(input), fakeLayer));
```

```typescript
// # RIGHT — HeraTest.runTest with HeraTest.layer
import { Hera, HeraSchema, HeraTenantCtx } from "@sibylline-labs/hera";
import { HeraTest } from "@sibylline-labs/hera/testing";

const OrderId = HeraSchema.brandedId("OrderId", /^ord_[0-9A-HJKMNP-TV-Z]{26}$/);

const createOrder = Hera.fn("OrderService.createOrder")(function* (input: {
  readonly orderId: typeof OrderId.Type;
  readonly amountCents: number;
}) {
  const ctx = yield* HeraTenantCtx.current;
  return { orderId: input.orderId, orgId: ctx.orgId, amountCents: input.amountCents };
});

const result = await HeraTest.runTest(
  createOrder({
    orderId: OrderId.make("ord_01HZX8VQXZ9K0M1N2P3Q4R5S6T"),
    amountCents: 2500,
  }),
  HeraTest.layer(),
);
```

---

## Surface 7: `Hera.agent` & `Hera.agentTool` (`@sibylline-labs/hera/agent`)

A Pi Durable agent runs on a `TenantDurableObject` through `Hera.agent(def)`, never through a hand-wired `PiHarness` and `Lifecycle` (see the [agent guide](../../docs/guides/agent.md)):
- **`Hera.agent<Env>({ service, agent, instructions, tools, egress, model?, fallback?, telemetry? })`**: an abstract class with `submit({ operationId, prompt })`, `cancel({ operationId })` and `dispose()`. Lifecycle is installed on first use and owns the alarm, and Hera's composite pass is its `hera:composite` host job. `purgeStorage()` runs dispose → deleteAll → abort.
- **`Hera.agentTool({ name, description, input, execute })`**: the model's raw arguments are decoded strictly against `input` before Pi coerces them. `replay` defaults to `"safe"`, so key side effects on `callId`. The lint `hera-agent-tool-via-hera` bans raw Pi registrations elsewhere.
- **Egress**: Gemini API via the AI Gateway `google-ai-studio` route only (an allowlist), one `_hera_agent_meter` row per request, and `cf-aig-authorization` only when `gatewayToken` is set. The models are `HeraAgentModels.default` (Gemma) and `.fallback` (Argon at `low`). `gemini-2.5-flash` is not selectable.
- **Tests**: override `createEgressUpstream()` with `HeraAgentTest.script([...])` from `@sibylline-labs/hera/testing/agent`.

```typescript no-check
// # WRONG — a raw Pi tool: Pi coerces {key:3} to "3" before execute, and replay defaults to "unsafe"
import { type ToolRegistration } from "@earendil-works/pi-durable";

const lookup: ToolRegistration = {
  name: "lookup", description: "Look up a key.", parameters: Type.Object({ key: Type.String() }),
  execute: async ({ key }) => ({ output: [{ type: "text", text: read(key) }] }),
};
```

```typescript
// # RIGHT — Hera.agentTool: strict decode of the raw args, replay "safe", callId for idempotency
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Hera } from "@sibylline-labs/hera/agent";

const lookup = Hera.agentTool({
  name: "lookup",
  description: "Look up a key.",
  input: Schema.Struct({ key: Schema.String }),
  execute: ({ key }, { callId }) => Effect.succeed(`${key} (call ${callId})`),
});
```

---

## Why Raw `Effect` Combinators and Effect v3 APIs Are Banned

Hera enforces a zero-drift AST-grep ruleset (`ast-grep scan` & `ast-grep test` in `rules/ast-grep/`):

| Rule ID | What It Bans | What to Use Instead |
|---|---|---|
| `hera-no-raw-effect-run` | `Effect.runPromise`, `Effect.runSync`, `Effect.runFork`, `Effect.runCallback`, `Effect.runPromiseExit`, `Effect.runSyncExit` outside Hera boundaries | `Hera.publicRoute`, `Hera.authedRoute`, `Hera.rpcMethod`, `Hera.TenantDurableObject`, `HeraCli.verb`, or `HeraTest.runTest` in tests |
| `hera-no-effect-v3` | `Context.GenericTag`, `Context.Tag`, `Effect.Tag`, `Effect.Service`, `Effect.provideService`, `Effect.catchAll`, `Layer.effectContext`, `Schema.struct`, `Schema.TaggedError`, `Data.TaggedError`, `@effect/schema` | Effect v4 `Context.Service<Self, Shape>()("id")`, `HeraError.define`, `Effect.provide(Service.layer(...))`, `Effect.catch` / `Effect.catchTag`, `Layer.effect`, `import * as Schema from "effect/Schema"` with `Schema.Struct` |
| `hera-single-fn-syntax` | Raw `Effect.gen`, raw `Effect.fn`, `Effect.fnUntraced`, and multi-step `Effect.flatMap` pipelines in application code | `Hera.fn("Service.operation")(function* () { ... })` |
| `hera-no-hand-rolled-ctx` | `headers.get("X-Request-Id")`, `headers.get("Authorization")`, `console.log(JSON.stringify({ level, ... }))`, and `Layer.succeed(HeraCtx \| HeraTenantCtx \| HeraAuthedCtx \| HeraPublicCtx, ...)` | `yield* HeraTenantCtx.current` (`HeraAuthedCtx.current` / `HeraPublicCtx.current`), `ctx.logger.info(...)`, and `HeraTest.layer(...)` |
| `hera-tui-vendorable` | Any import in `src/cli/tui/` other than a same-directory sibling (`effect`, `node:*`, another plane, a subdirectory), static or dynamic | The `TuiIo` port; keep `hera/tui` dependency-free so public eris vendors it flat |
| `hera-alarm-via-driver` | `setAlarm`, `getAlarm`, `deleteAlarm` in any literal spelling (member, subscript, destructure, string key) in `src/` outside `alarm-driver.ts` and `src/testing/` | The object's `AlarmDriver` (`createAlarmDriver()`), named jobs, or `scheduleDomainAlarm` |
| `hera-no-isolate-state` | A module-scope `let` / `var`, or an argument-less `new Map()` / `Set()` / `WeakMap()` / `WeakSet()` at module scope, in `src/core/**` (a seeded `new Set([...])` lookup is allowed) | State held in the object a factory returns (`HeraCache.make`, `HeraFlags.ofrep`) |
| `hera-tui-lazy` | Importing or re-exporting `tui/` from any other `src/` module | `await import("@sibylline-labs/hera/tui")` inside the consuming verb |
| `hera-agent-tool-via-hera` | A Pi `ToolRegistration` type, `defineTool` / `defineExtension` / `wrapTool` / `toolExtension`, a `createRegistry` or `create*Tool` import from `@earendil-works/pi-durable`, or a `parameters` + `execute` literal, outside `src/server/agent/` | `Hera.agentTool({ name, description, input: <Effect Schema>, execute })` |
| `hera-cli-manifest-pure` | Any import in `src/cli/manifest/` other than a same-directory sibling (`effect`, `node:*`, another plane, a handler module) | Runtime work in `src/cli/runtime/`, reached through a verb's lazy `load` thunk |
| `hera-no-global-fetch-mutation` | Assigning `globalThis.fetch` / `global.fetch` / `window.fetch` / `self.fetch` (plain, computed, `||=`, `Object.assign`, `Object.defineProperty`) in production code | A hook point the owning verb declares: `HeraCli.hookPoint` + `HeraCli.hook`, registered with `HeraCli.on` |
| `hera-no-global-otel` | `setGlobalTracerProvider`, `setGlobalContextManager`, `setGlobalPropagator`, `trace.getTracer` in `src/` | A provider built per instance: `HeraAgentTelemetry.make(...)` and its own `provider.getTracer(...)` |

---

## Migration Guide: Hand-Rolled Worker / DO / CLI → Hera

| Legacy Pattern | Hera Replacement |
|---|---|
| `new Response(JSON.stringify(err), { status })` | `Hera.publicRoute` / `Hera.authedRoute` + `HeraError.define` (emits `application/problem+json` with `request_id` and `code`) |
| A local `reply(status, value)` / `Response.json(value, { headers: { "cache-control": "no-store" } })` to skip the `{ ok, data }` wrapper | `return HeraHttp.raw(value, { status: 201 })` from the route handler (bare JSON value, `no-store` by default, `x-request-id` added by the boundary) |
| `request.headers.get("X-Request-Id")` / `request.headers.get("Authorization")` | `yield* HeraTenantCtx.current` (`HeraAuthedCtx.current` / `HeraPublicCtx.current`) |
| `console.log(JSON.stringify({ level, msg, ... }))` | `yield* ctx.logger.info("event.name", { ... })` (auto-correlates `request_id`, `org_id`, `actor_id` and redacts secrets) |
| `process.env.SECRET_KEY!` / `env.SECRET_KEY` | `HeraConfig.unwrap(yield* HeraConfig.secret("SECRET_KEY", Schema.String))` |
| `await state.storage.put(...)` + `await queue.send(...)` | `TenantDurableObject.configure` + `this.db.transactWithOutbox(function* (tx) { yield* tx.exec(...); yield* tx.enqueueOutbox(...); })` |
| `process.argv` + `console.error` + `process.exit(1)` | `HeraCli.verb({ name, slug, args, handler })` + `ErisError.operational(slug, { what, fix })` from `@sibylline-labs/hera/cli` |
| `fetch(url)` with manual `AbortController` | `HeraHttp.request({ method, url, timeoutMs, maxBytes, schema })` |
| A module-level `Map` of `{ at, value }` read against `Date.now()` as a TTL cache | `HeraCache.make({ ttlMs, negativeTtlMs?, maxEntries?, lookup })` then `yield* cache.get(key)`: Clock-timed, settled answers only (no shared flight), failures held for `negativeTtlMs`, LRU-bounded; the tenant goes in the key ([guide](../../docs/guides/caching.md)) |
| A CLI whose verbs restate their surface (a flag table + a `USAGE` string + a `Schema.Struct` + glue), hand-written completion, or help patched by string replace | One spec per verb: `HeraCli.verb({ summary, ...HeraCli.args({ flags, operands }), json, load: () => import("./x.js").then((m) => m.handler) })`, composed with `HeraCli.plugin` / `HeraCli.compose` and run by `HeraCli.program`; routing, strict argv, `--help`, `eris-help/1`, docs and completion derive from it; an extension adds flags and `HeraCli.on(hookPoint, fn)` ([guide](../../docs/guides/cli-and-http.md#declaring-a-cli-once-heracliprogram)) |
| A CLI verb that checks a grant or token by hand before doing a privileged act, or a handler that can run without the check | `HeraCli.verb({ name, args, authority: { verb: "domain:action", credential, params, verifier }, handler: (args, ctx, authority) => ... })`: the `HeraAuthorityVerifier` port runs first, the handler gets `HeraAuthorityCtx<"domain:action">` only on a grant, a refusal exits 3 with the verifier's code; `HeraTest.authority(spec)` in tests ([guide](../../docs/guides/cli-and-http.md#authority-guarded-verbs-authority)) |
| A Worker route that checks a grant or token by hand before a privileged act, or a handler that can run without the check | `Hera.authedRoute({ method, path, authority: { verb: "domain:action", credential: (ctx) => ..., params, verifier }, handler: (ctx, authority) => ... })`: the verifier runs after tenant auth and decode, the handler gets `HeraAuthorityCtx<"domain:action">` only on a grant, a refusal is `403` problem+json with the verifier's code; `HeraTest.authority(spec).layer` in tests ([guide](../../docs/guides/workers-and-routes.md#authority-guarded-routes-authority)) |
| An org allowlist in code, or a flag read with no targeting context, to gate a feature per org | `HeraFlags.ofrep({ token, base })` held per DO or request, then `yield* flags.bool(name, { targetingKey: orgId }, false)`: Logfire OFREP, per-org overrides on `org_id`, code fallback plus one warn on failure; `HeraTest.flags(spec)` in tests ([guide](../../docs/guides/flags.md)) |
| A module-scope OTel tracer or `trace.setGlobalTracerProvider` to export agent spans from a Durable Object | `HeraAgentTelemetry.make({ service, environment, tenant, sink, waitUntil, contentExport })` from `@sibylline-labs/hera/agent/telemetry`: per-instance lazy pipeline on `HeraTelemetry`'s exporter, scrubbing, GenAI filter and fingerprinted exceptions built in, content off by default; capture it in tests with `HeraTest.telemetry()` ([guide](../../docs/guides/agent-telemetry.md)) |
| A raw Pi `ToolRegistration` / `PiHarness` / `Lifecycle.install` wired by hand on a Durable Object, or a Gemini call straight to `generativelanguage.googleapis.com` | `class X extends Hera.agent<Env>({ service, agent, instructions, tools, egress })` with `Hera.agentTool({ name, description, input, execute })` from `@sibylline-labs/hera/agent`: Pi Durable on a `TenantDurableObject` (Lifecycle owns the alarm, Hera's composite pass is its host job, `purgeStorage()` disposes first), strict decode of raw tool args, `replay: "safe"` by default, AI Gateway egress with an allowlist and per-request meter; tests use `HeraAgentTest.script([...])` from `/testing/agent` ([guide](../../docs/guides/agent.md)) |
| `Layer.succeed(HeraCtx, ...)` + `Effect.runPromise(...)` | `HeraTest.runTest(effect, HeraTest.layer(options))` from `@sibylline-labs/hera/testing` |

