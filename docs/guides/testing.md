# Testing with `HeraTest` (`@sibylline-labs/hera/testing`)

`@sibylline-labs/hera/testing` (`src/testing/`) provides deterministic Effect test runners, pre-populated context layers, sample branded IDs and cryptographic fixtures, and HTTP/RPC fault-injection doubles for `vitest`. It needs no ambient types, so a CLI (eris) or a pure package can import it.

The in-memory SQLite Durable Object harness lives at `@sibylline-labs/hera/testing/durable-object`, because it needs `@cloudflare/workers-types` and Node types. That subpath exports its own `HeraTest`: the `/testing` one plus the DO members (`makeTestTenantDoHarness`, `inspectOutbox`, `triggerAlarm`, `makeTestDurableObjectState`; its harness records `setAlarmCalls` and `abortCalls`, the latter from `purgeStorage()`'s deferred reset), with `layer` backing `HeraTenantCtx.db` by in-memory SQLite. A Worker test that needs the DO harness changes only its import path.

---

## 1. Running Effects & Controlling Time (`HeraTest.runTest`, `HeraTest.layer`)

Raw `Effect.runPromise` and hand-rolled `Layer.succeed(HeraCtx, ...)` mocks are banned by `rules/ast-grep/`. Use `HeraTest.runTest(effect, layer?)` (or `HeraTest.runTestExit`) with `HeraTest.layer(options?)`. The layer provides `HeraPublicCtx`, `HeraAuthedCtx`, `HeraTenantCtx`, `HeraCtx`, `HeraEnv`, `HeraLoggerService`, and a `TestClock`; its options include `orgId`, `actorId`, `actorKind`, `scopes`, `requestId`, `service`, `initialTimeMs`, `env`, and an optional tenant `db` (omitted, `HeraTenantCtx.db` runs no-op `exec` / `query`). `HeraTest.layer` from `@sibylline-labs/hera/testing/durable-object` instead backs `HeraTenantCtx.db` with in-memory SQLite and adds `migrations`, `seedSql`, and `deliverOutboxBatch`.

```ts
import { describe, expect, it } from "vitest";
import { Hera, HeraTenantCtx } from "@sibylline-labs/hera";
import { HeraTest } from "@sibylline-labs/hera/testing";

const readTenantAndTime = Hera.fn("Demo.readTenantAndTime")(function* () {
  const ctx = yield* HeraTenantCtx.current;
  const now = yield* HeraTest.currentTimeMillis;
  yield* HeraTest.advanceClock(5_000);
  const later = yield* HeraTest.currentTimeMillis;
  return { orgId: ctx.orgId, elapsed: later - now };
});

describe("HeraTest.runTest", () => {
  it("provides deterministic tenant context and controllable clock", async () => {
    const res = await HeraTest.runTest(
      readTenantAndTime(),
      HeraTest.layer({ initialTimeMs: HeraTest.DEFAULT_TEST_TIME_MS }),
    );

    expect(res.orgId).toBe(HeraTest.SAMPLE_IDS.orgId);
    expect(res.elapsed).toBe(5_000);
  });
});
```

---

## 2. Testing HTTP Routes & Worker RPC Doubles (`makeTestRouteRequest`, `makeTestRpcDouble`)

Use `HeraTest.makeTestRouteRequest` and `HeraTest.parseProblemDetailsResponse` to test HTTP route boundaries.

`HeraTest.makeTestRpcDouble(serviceName, impl)` wraps an object of service methods and returns those methods plus fault injection and call recording:

- `client`: a pre-bound `Hera.rpcClient` over the double, so a test can run `double.client.<method>(input)` as an `Effect`.
- `calls` / `clearCalls()`: every recorded invocation.
- `unreachable` / `setUnreachable(unreachable?, { mode })`: a service-wide `503 <service>_unavailable`. `mode` is `"envelope"` (the default, a wire failure) or `"transport"` (the call rejects, exercising the client's transport mapping).
- `rateLimited(retryAfterSeconds?)` / `clearRateLimit()`: a `429 rate_limited` carrying `retryAfter`.
- `defectOnNextCall(error?, { mode })`: a one-shot defect, scrubbed into `503 <service>_unavailable`.
- `resetFaults()`: clears every fault toggle and the call history.

```ts
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Hera } from "@sibylline-labs/hera";
import { HeraTest } from "@sibylline-labs/hera/testing";

const EchoRoute = Hera.publicRoute({
  method: "POST",
  path: "/echo",
  body: Schema.Struct({ message: Schema.NonEmptyString }),
  handler: ({ body }) =>
    Hera.fn("Echo.say")(function* () {
      return { echoed: body.message };
    })(),
});

describe("HeraTest route and RPC helpers", () => {
  it("rejects an invalid body with a value-stripped 400", async () => {
    const res = await EchoRoute.handle(
      HeraTest.makeTestRouteRequest({ method: "POST", path: "/echo", body: { message: "" } }),
    );

    expect(res.status).toBe(400);
    const problem = await HeraTest.parseProblemDetailsResponse(res);
    expect(problem.code).toBe("invalid_request_body");
  });

  it("scripts an RPC success, then injects an outage and a rate limit", async () => {
    const accounts = HeraTest.makeTestRpcDouble("accounts", {
      getQuota: (_input: { readonly orgId: string }) => Effect.succeed({ limit: 500 }),
    });
    const input = { orgId: HeraTest.SAMPLE_IDS.orgId };

    const quota = await HeraTest.runTest(accounts.client.getQuota(input));
    expect(quota.limit).toBe(500);
    expect(accounts.calls).toHaveLength(1);

    accounts.setUnreachable(true, { mode: "transport" });
    const outage = await HeraTest.runTest(Effect.flip(accounts.client.getQuota(input)));
    expect(outage.code).toBe("accounts_unavailable");
    expect(outage.fields?.retryable).toBe(true);

    accounts.resetFaults();
    accounts.rateLimited(30);
    const limited = await HeraTest.runTest(Effect.flip(accounts.client.getQuota(input)));
    expect(limited.code).toBe("rate_limited");
    expect(limited.retryAfter).toBe(30);
  });
});
```

---

## 3. Testing `TenantDurableObject` In-Memory (`makeTestTenantDoHarness`)

Import `HeraTest` from `@sibylline-labs/hera/testing/durable-object` (workers-types + Node types). `HeraTest.makeTestTenantDoHarness(DoClass, options?)` instantiates a `TenantDurableObject` subclass (pass the class itself) over an in-memory SQLite storage engine with a deterministic test clock. Its `options` are the Durable Object options (`deliverOutboxBatch`, `outboxBackoff`, ...) plus `orgId`, `env`, `seedSql`, and `initialTimeMs`. The harness exposes `instance`, `state`, `sqliteDb`, `advanceClock`, `setClock`, an outbox inspector (`inspectOutbox`), and a manual alarm trigger (`triggerAlarm`).

`TenantDurableObject` imports `cloudflare:workers`, which exists only inside workerd. Outside it, resolve the module to `@sibylline-labs/hera/testing/cloudflare-workers`, a stub that has a `DurableObject` base (and `WorkerEntrypoint`, `RpcTarget`, `env`):

- vitest: `resolve.alias: { "cloudflare:workers": "@sibylline-labs/hera/testing/cloudflare-workers" }` (Hera's own `vitest.config.ts` does this).
- `bun test`: `bunfig.toml` `[test] preload = ["@sibylline-labs/hera/testing/bun-preload"]`. A preload that already stubs `cloudflare:workers` with a `DurableObject` that keeps `ctx` and `env` works as well.


```ts
import { describe, expect, it } from "vitest";
import {
  Hera,
  HeraTenantCtx,
  TenantDurableObject,
  type HeraOutboxRecord,
} from "@sibylline-labs/hera";
import { HeraTest } from "@sibylline-labs/hera/testing/durable-object";

class OrderTenantDO extends TenantDurableObject.configure({
  service: "orders-do",
  migrations: [
    {
      version: 1,
      name: "create_orders",
      sql: "CREATE TABLE orders (id TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL);",
    },
  ],
}) {
  recordOrder(id: string, amountCents: number): Promise<{ id: string; outboxId: string }> {
    const db = this.db;
    return this.runWithTenantCtx(
      Hera.fn("OrderTenantDO.recordOrder")(function* () {
        const ctx = yield* HeraTenantCtx.current;
        return yield* db.transactWithOutbox(function* (tx) {
          yield* tx.exec("INSERT INTO orders (id, amount_cents) VALUES (?, ?)", [id, amountCents]);
          const record = yield* tx.enqueueOutbox({
            type: "orders.recorded",
            payload: { id, orgId: ctx.orgId, amountCents },
          });
          return { id, outboxId: record.id };
        });
      })(),
    );
  }
}

describe("OrderTenantDO", () => {
  it("commits SQLite state and stages outbox records atomically", async () => {
    const delivered: Array<ReadonlyArray<HeraOutboxRecord>> = [];
    const harness = HeraTest.makeTestTenantDoHarness(OrderTenantDO, {
      orgId: HeraTest.SAMPLE_IDS.orgId,
      deliverOutboxBatch: (batch) => {
        delivered.push(batch);
      },
    });

    const res = await harness.instance.recordOrder("ord_1", 2500);
    expect(res.id).toBe("ord_1");

    const pending = harness.inspectOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.type).toBe("orders.recorded");

    const afterAlarm = await harness.triggerAlarm();
    expect(delivered).toHaveLength(1);
    expect(afterAlarm.outbox).toHaveLength(0);
  });
});
```

---

## 4. Faking the Authority Verifier (`HeraTest.authority`)

`HeraTest.authority(spec?)` (`makeTestAuthority`) returns `{ layer, requests, grant, refuse }`. Pass `layer` as a verb's or a route's `authority.verifier`. `spec.verbs` maps an authority verb to `{ grant: { id } }` or `{ refuse: { slug, what? } }`; a verb with no rule is refused `authority-not-granted`, so the fake fails closed. With `spec.credential` set, any other credential is refused `authority-credential-rejected`. `requests` logs each `verify` call as `{ verb, params, command }`, never the credential. `grant(verb, grant?)` and `refuse(verb, slug, what?)` change a verb's answer mid-test.

```ts
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { HeraCli } from "@sibylline-labs/hera/cli";
import { HeraTest } from "@sibylline-labs/hera/testing";

it("runs only on a grant", async () => {
  const fake = HeraTest.authority({ verbs: { "gate:skip": { grant: { id: "use-1" } } } });
  const skip = HeraCli.verb({
    name: "tool gate skip",
    authority: { verb: "gate:skip", credential: () => "a-grant", verifier: fake.layer },
    handler: (_args, ctx, authority) => Effect.sync(() => ctx.stdout(`${authority.grant.id}\n`)),
  });
  expect(await skip.run(undefined, { stdout: () => {} })).toBe(0);
  fake.refuse("gate:skip", "grant-revoked");
  expect(await skip.run(undefined, { stderr: () => {} })).toBe(3);
  expect(fake.requests).toHaveLength(2);
});
```

The same fake guards a route: pass `fake.layer` as `Hera.authedRoute`'s `authority.verifier`, and each `requests` entry's `command` is the route's operation name.

```ts
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { Hera } from "@sibylline-labs/hera";
import { HeraTest, makeTestTenantCtx } from "@sibylline-labs/hera/testing";

it("refuses a guarded route with 403 problem+json", async () => {
  const fake = HeraTest.authority({ verbs: { "gate:skip": { refuse: { slug: "grant-revoked" } } } });
  const skip = Hera.authedRoute({
    name: "Gates.skip",
    method: "POST",
    authority: { verb: "gate:skip", credential: ({ request }) => request.headers.get("x-grant") ?? undefined, verifier: fake.layer },
    handler: (_ctx, authority) => Effect.succeed(authority.grant.id),
  });
  const res = await skip(new Request("http://t/", { method: "POST", headers: { "x-grant": "g" } }), { tenant: makeTestTenantCtx() });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ code: "forbidden", slug: "grant-revoked" });
  expect(fake.requests[0]?.command).toBe("Gates.skip");
});
```

## 5. Capturing Telemetry (`HeraTest.telemetry`)

`HeraTest.telemetry(options?)` (`makeTestTelemetry`) builds a real `HeraTelemetry` wired to an in-memory OTLP host. Everything a production export runs still runs: scrubbing, tail-promotion, OTLP encoding and the POST through `HeraHttp`; only the network is replaced, so a test needs no fetch mock. It returns `{ telemetry, sink, fetch, waitUntil, hook, reports, posts, spans(), logs(), settle() }`. `spans()` and `logs()` decode what was posted, with attributes and the batch's `resource` as plain records. Defaults are `environment: "test"` and `sampling.headRate: 1`; pass `sampling: { headRate: 0 }` to see only what tail-promotion keeps. Any other `HeraTelemetryConfig` field overrides. Pass `hook` to a Hera boundary, or `sink`, `fetch` and `waitUntil` to `HeraAgentTelemetry.make` to capture agent spans through the same host.

It lives only under `@sibylline-labs/hera/testing`: no root, `/core` or `/server` barrel exports it.

```ts
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";
import { HeraTelemetry } from "@sibylline-labs/hera/telemetry";
import { HeraTest } from "@sibylline-labs/hera/testing";

it("exports the failing invocation, scrubbed", async () => {
  const t = HeraTest.telemetry({ sampling: { headRate: 0 } });
  const program = Effect.die(new Error("boom")).pipe(Effect.withSpan("charge"));
  await Effect.runPromiseExit(
    HeraTelemetry.run(t.telemetry, { name: "charge", source: "external", waitUntil: t.waitUntil }, program),
  );
  await t.settle();
  const [span] = t.spans();
  expect(span?.name).toBe("charge");
  expect(span?.resource["deployment.environment.name"]).toBe("test");
  expect(span?.attributes["logfire.exception.fingerprint"]).toMatch(/^[0-9a-f]{16}$/);
});
```
