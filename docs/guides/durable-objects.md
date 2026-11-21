# Multi-Tenant Durable Objects (`TenantDurableObject`, `SyncTx`)

`@sibylline-labs/hera/durable-object` (`src/server/durable-object/`) provides the single-tenant Cloudflare Durable Object base class (`TenantDurableObject`), its non-tenant sibling (`KeyedDurableObject`, §6), named jobs on the alarm (`this.jobs`, §7), canonical tenant naming (`orgDoName`, `parseOrgDoName`, `getTenantStub`, and per run `orgRunDoName`, `parseOrgRunDoName`, `getTenantRunStub`), monotonic SQLite migrations under `blockConcurrencyWhile`, synchronous SQLite transactions (`this.db.transactSync` / `this.db.transactWithOutbox` over `SyncTx` effects), an atomic SQLite-backed transactional outbox with composite alarm scheduling, `HeraOutbox.queueSink`, a queue sink that sends in chunks and rejects oversize records, and `HeraStateMachine.define`, a declared state graph whose transitions are compare-and-set writes (§9).

---

## 1. Tenant Naming & Stub Resolution

A tenant Durable Object is named by its `OrgId`, so one instance never mixes state across organizations. `getTenantStub(namespace, orgId, options?)` takes a branded `OrgId` (an unbranded `string` fails to compile), validates it again at runtime, and names the object by the **raw `OrgId`** by default. Pass `useOrgPrefix: true` to name it `org:<orgId>` (`OrgDurableObjectName`, built by `orgDoName`) instead. `options` is `{ jurisdiction?, env?, useOrgPrefix? }`.

```ts
import {
  getTenantStub,
  orgDoName,
  parseOrgDoName,
  OrgId,
} from "@sibylline-labs/hera";

declare const env: { readonly TENANT_DO_NAMESPACE: DurableObjectNamespace };

const orgId = OrgId.make("org_01HZX8VQXZ9K0M1N2P3Q4R5S6T");

// "org:org_01HZX8VQXZ9K0M1N2P3Q4R5S6T"
const name = orgDoName(orgId);

// Parse and validate back into Branded OrgId (or Option.none())
const parsedOrgId = parseOrgDoName(name);

// Named by the raw OrgId, with an optional jurisdiction hint
const stub = getTenantStub(env.TENANT_DO_NAMESPACE, orgId, {
  jurisdiction: "eu",
});

// Named "org:<OrgId>" instead
const prefixedStub = getTenantStub(env.TENANT_DO_NAMESPACE, orgId, {
  useOrgPrefix: true,
});
```

### One object per run (`runKeyed`)

A class configured with `runKeyed: true` is one object per run of an org, named `org:<OrgId>:run:<runKey>` (`OrgRunDurableObjectName`, built by `orgRunDoName`). The org still fills `this.orgId`, the tenant context and the `orgId` log field; `this.runKey` is the run key, and logs carry `doId`, never the run key. Each run has its own SQLite storage and alarm, so `purgeStorage()` on one run leaves every other run of the org intact.

A run key is 1 to 256 printable ASCII characters with no whitespace, and may contain `:`: an `OrgId` holds no `:`, so the first `:run:` after the org ends it. Both are decoded from the object's own name, never from a caller's payload. A run-keyed class refuses `<OrgId>`, `org:<OrgId>`, an empty or invalid run key and a bad org with `TenantIdentityError`; a per-org class refuses a run name the same way, so one class never answers to both forms. `this.runKey` is `undefined` on a per-org object.

```ts
import {
  getTenantRunStub,
  orgRunDoName,
  parseOrgRunDoName,
  OrgId,
  TenantDurableObject,
} from "@sibylline-labs/hera";

export class ResolveRun extends TenantDurableObject.configure({ service: "resolve-run", runKeyed: true }) {}

declare const env: { readonly RUNS: DurableObjectNamespace<ResolveRun> };
const orgId = OrgId.make("org_01HZX8VQXZ9K0M1N2P3Q4R5S6T");

// "org:org_01HZX8VQXZ9K0M1N2P3Q4R5S6T:run:resolve:epic-1:1"
const name = orgRunDoName(orgId, "resolve:epic-1:1");

// Option.some({ orgId, runKey: "resolve:epic-1:1" })
const parsed = parseOrgRunDoName(name);

// The same pair always reaches the same object; the jurisdiction pin works as for getTenantStub
const stub = getTenantRunStub(env.RUNS, orgId, "resolve:epic-1:1", { jurisdiction: "eu" });
```

**Jurisdiction on local workerd.** Local `workerd` throws `Jurisdiction restrictions are not implemented` from `namespace.jurisdiction(...)`. `getTenantStub` and `getTenantRunStub` fall back to the unrestricted namespace only for that error, and only when the `env` you pass holds `HERA_LOCAL_WORKERD` set to exactly `"1"` (a `.dev.vars` line or `wrangler dev --var HERA_LOCAL_WORKERD:1`). Anything else, including the variable unset, rethrows, so a deployed Worker never falls back.

The raw and the `org:`-prefixed name are different Durable Object IDs, so each namespace should use one scheme consistently.

`OrgId` accepts the canonical `org_<ULID>` and a bare `<ULID>` alias, and never rewrites either. The name addresses the object's stored SQLite, so `org:01HZX8…` and `org:org_01HZX8…` are two different objects: a namespace keeps the form it was created with. Tenant objects created with a bare id are named `org:<ULID>`, which `getTenantStub(ns, orgId, { useOrgPrefix: true })` addresses exactly:

```ts
import { getTenantStub, OrgId } from "@sibylline-labs/hera";

declare const env: { readonly Org: DurableObjectNamespace };

const bareOrg = OrgId.make("01HZX8VQXZ9K0M1N2P3Q4R5S6T");

// idFromName("org:01HZX8VQXZ9K0M1N2P3Q4R5S6T")
const bareStub = getTenantStub(env.Org, bareOrg, { useOrgPrefix: true });
```

> **Fail-Closed Identity Guard**: During `new TenantDurableObject(ctx, env)`, `requireTenantDoOrgId(ctx.id.name)` verifies that `ctx.id.name` is either a raw `<OrgId>` or an `org:<OrgId>` name (either `OrgId` form), and throws `TenantIdentityError` before any migration or query can execute if the name is missing or malformed.

---

## 2. Subclassing `TenantDurableObject` & Synchronous `SyncTx`

Subclass `TenantDurableObject` (or `TenantDurableObject.configure({ service, migrations })`) to declare monotonic SQLite migrations and domain methods. `TenantDurableObject` extends `DurableObject` from `cloudflare:workers`, so workerd exposes a subclass's public methods over Workers RPC (`await env.ORG.getByName(name).hello()`); `test/workerd/tenant-do-rpc.test.ts` observes that on workerd. `ctx` and `env` are public and `readonly`. Outside workerd, `cloudflare:workers` must resolve to the Hera stub (see the [testing guide](testing.md#3-testing-tenantdurableobject-in-memory-maketesttenantdoharness)). `this.db` is a `HeraSqlClient`: `exec` and `query` run single statements, and `transactSync` / `transactWithOutbox` run a generator inside one SQLite transaction. `tx.enqueueOutbox({ type, payload, id?, availableAt? })` stages an outbox record in that same transaction.

```ts
import {
  Hera,
  HeraTenantCtx,
  TenantDurableObject,
  type HeraMigration,
  type HeraOutboxRecord,
} from "@sibylline-labs/hera";

const MIGRATIONS: ReadonlyArray<HeraMigration> = [
  {
    version: 1,
    name: "create_orders",
    sql: `
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL
      );
    `,
  },
];

export class OrderTenantDO extends TenantDurableObject.configure({
  service: "orders-do",
  migrations: MIGRATIONS,
}) {
  recordOrder(orderId: string, amountCents: number): Promise<{ id: string; outboxId: string }> {
    const db = this.db;
    return this.runWithTenantCtx(
      Hera.fn("OrderTenantDO.recordOrder")(function* () {
        const ctx = yield* HeraTenantCtx.current;

        // Synchronous SQLite transaction + atomic outbox staging
        return yield* db.transactWithOutbox(function* (tx) {
          yield* tx.exec(
            "INSERT INTO orders (id, org_id, amount_cents) VALUES (?, ?, ?)",
            [orderId, ctx.orgId, amountCents],
          );

          const outboxRecord = yield* tx.enqueueOutbox({
            type: "orders.recorded",
            payload: { orderId, orgId: ctx.orgId, amountCents },
          });

          return { id: orderId, outboxId: outboxRecord.id };
        });
      })(),
    );
  }

  protected override deliverOutboxBatch(records: ReadonlyArray<HeraOutboxRecord>) {
    return Hera.fn("OrderTenantDO.deliverOutboxBatch")(function* () {
      // Deliver batch to downstream queue or RPC sink
      void records;
    })();
  }
}
```

### Lazy storage initialisation & legacy ledgers

Construction writes nothing to an object that has no state, so a read naming a tenant that was never used (a forged claim, a lookup of a fresh id) leaves `sqlite_master` empty and allocates no database.

- **On wake**, under `blockConcurrencyWhile`, an object that already holds `_hera_migrations` (or the configured legacy ledger) is brought to the end of its migrations before it serves a request, so its reads see the current schema. A fresh object is left untouched. Migration descriptors are still validated at construction, so a duplicate version throws from `new`.
- **The first write** creates `_hera_migrations`, `_hera_outbox` and `_hera_alarm_meta` and applies every migration. `transactSync` and `transactWithOutbox` do this inside their own transaction, before your effect runs, so a rolled-back first write rolls the initialisation back too. `db.exec`, a bare `db.enqueueOutbox` and `scheduleDomainAlarm` are write paths as well. A migration that fails on the first write surfaces as that write's `HeraMigrationError`.
- **Reads on an uninitialised object answer empty.** `getAppliedMigrations()` returns `[]`, the outbox and alarm getters return `[]` / `null`, `drainOutbox()` returns a zero result, `cancelDomainAlarm()` is a no-op, and `alarm()` writes and arms nothing. `db.query` stays a pure read, so guard reads of your own tables with `this.isInitialized()` or `db.isInitialized()`:

```ts
import { TenantDurableObject } from "@sibylline-labs/hera";

export class LookupTenantDO extends TenantDurableObject.configure({ service: "lookup-do" }) {
  hasOrders(): boolean {
    // An object that was never written has no tables: answer without touching storage.
    return this.isInitialized();
  }
}
```

- **Re-entrant after a purge.** Initialisation is probed on every write and never cached, so after `ctx.storage.deleteAll()` the object reads as uninitialised and the next write initialises it again.
- **Adopting a pre-Hera ledger.** An object that kept its own ledger declares it with `legacyMigrationLedger: { table: "yak_migrations", versionColumn: "id" }` (`versionColumn` defaults to `version`). When `_hera_migrations` is first created, every version in that table is recorded under the declared migration of the same version and is never re-run, which matters for non-idempotent statements such as `ALTER TABLE ... ADD COLUMN`. Versions the ledger lacks are then applied. A recorded version with no declared migration fails closed with `HeraMigrationError`. The legacy table is left in place.

---

## 3. Why `SyncTx` Forbids Async Yields

Cloudflare Durable Object SQLite transactions (`storage.transactionSync(...)`) only guarantee atomicity while execution remains synchronous on the single-threaded V8 turn. Yielding an async `Promise` or async `Effect` inside a transaction allows incoming requests to interleave or breaks SQLite rollback guarantees.

`db.transactSync(function* (tx) { ... })` and `db.transactWithOutbox(function* (tx) { ... })` enforce this structurally:
- `tx.exec`, `tx.query`, and `tx.enqueueOutbox` return `SyncEffect` values that execute synchronously inside `storage.transactionSync`. The `SyncTx` namespace (`SyncTx.succeed`, `SyncTx.fail`, `SyncTx.try`, `SyncTx.gen`, ...) builds more of them.
- Yielding an async `Effect` (such as `Effect.promise` or `Effect.sleep`) is a compile-time error, because the generator may only yield `SyncEffect`s. If one is forced through anyway, the transaction rolls back and fails with `SyncTxAsyncViolationError`.
- A failed transaction rolls back every statement and every staged outbox record.
- `transactWithOutbox` is the form to use when the generator enqueues outbox events. When it commits, `TenantDurableObject` automatically multiplexes the next outbox retry timestamp and any domain alarm (`scheduleDomainAlarm`) into Cloudflare's single `storage.setAlarm(...)` slot. `transactSync` commits the same way but does not arm the alarm.

## 4. The Composite Alarm

`TenantDurableObject` and `KeyedDurableObject` multiplex three schedules into Cloudflare's single alarm slot: the outbox, the domain alarm (`scheduleDomainAlarm(atMs)`, `cancelDomainAlarm()`, `protected onDomainAlarm(nowMs)`) and the named jobs (§7). Each `alarm()` pass drains the outbox, runs `onDomainAlarm` when its slot is due, runs the jobs that are due, and re-arms the slot for the earliest next time. A failing `onDomainAlarm` does not stop the due jobs from running in the same pass.

- **The outbox drains in order by default.** With `outboxOrdering: "strict"` (the default), a pass sends only the due prefix of `_hera_outbox` in `(created_at, id)` order. A backed-off row holds back every row written after it, so a stream is delivered in the order it was written. `getNextOutboxRetryAt()` reports the head row's time, since nothing behind it can go first.
- **Independent records.** With `outboxOrdering: "independent"`, a pass sends every due row, still oldest first, so a backed-off row holds nothing behind it, and `getNextOutboxRetryAt()` reports the earliest row's time. Use it when no sink depends on the order the records were written in.
- **Per-record results.** A sink (or a `deliverOutboxBatch` override) may resolve a `HeraOutboxDeliveryReport`, `{ failed: [{ id, reason }] }`. Hera acknowledges every record of the batch the report does not name, and backs off each named one on its own. An id outside the batch is ignored. A sink that resolves nothing acknowledges the whole batch; a sink that fails fails the whole batch.
- **A record that keeps failing is dead-lettered.** Each failed record's `attempts` grows by one. When it reaches `outboxMaxAttempts` (default 20, about an hour of capped backoff at the default delays), the record moves from `_hera_outbox` to `_hera_outbox_dead_letter` and the rows behind it drain. Each move writes one `hera.outbox.dead_lettered` line at error, with the object's `orgId`, the `outboxId`, `type`, `attempts` and the redacted `lastError`, never the payload: alert on it. A failed attempt also writes `hera.outbox.flush_failed` at warn. A row that another drain acknowledged or moved while this one awaited is left alone.
- **Inspect and replay.** `getDeadLetteredOutboxRecords()` lists the dead letters (`HeraOutboxDeadLetter`, a record plus `deadLetteredAt`). `replayDeadLetteredOutbox(ids?)` moves the named ones, or all of them, back into the outbox with zero attempts, due now and with their original `created_at`, arms the alarm and returns how many it moved. Both are public methods, so an operator can call them over the object's stub. Nothing else removes a dead letter except `purgeStorage()`. A replayed record keeps its id, so consumers that dedupe on it see one delivery.
- **A failing hook stays due.** If `onDomainAlarm` throws, rejects or fails, the pass logs `hera.alarm.defect` and re-arms the domain slot at `now + alarmErrorBackoffMs`, so the next alarm calls the hook again.
- **The earlier time wins.** When the hook returns a time, a `scheduleDomainAlarm` made while the hook awaited (by a request interleaving with the alarm, say) is never moved later: the slot keeps the earlier of the two.
- **A wake re-arms a lost alarm.** On construction, under `blockConcurrencyWhile`, an initialised object with pending outbox rows or a domain slot arms the platform alarm unless one is already set for then or earlier. A failure logs `hera.alarm.rearm_failed`.
- **Every alarm time is at least `now + 1`.** workerd refuses `setAlarm(t <= 0)`, so a row due at 0 (from a data migration, for example) still arms a positive alarm.
- **A lost `setAlarm` is logged.** The slot sync after a `transactWithOutbox` commit or a slot change runs inside a `SyncEffect` and cannot await `setAlarm`. A rejection logs `hera.alarm.arm_failed` with the `orgId`, and the next wake re-arms the alarm.
- **A purge ends the pass.** If the hook or the delivery calls `ctx.storage.deleteAll()`, the pass touches storage no further and arms nothing. While the alarm is in flight, a write on the purged object (a `transactWithOutbox` from the hook, or a request that interleaves with it) fails with `HeraSqlError` (`operation: "initialize"`) rather than re-creating every table. Once the alarm returns, the next write initialises the object as usual.

## 5. Sending the Outbox to a Queue (`HeraOutbox.queueSink`)

Each drain pass hands its batch to the `deliverOutboxBatch` sink and acknowledges the batch when the sink succeeds (less any records its report names), or backs it off when it fails (§4). `HeraOutbox.queueSink(options)` builds a sink for a Cloudflare Queue. Pass it as the `deliverOutboxBatch` option, so you don't need to override the method:

```typescript
import * as Effect from "effect/Effect";
import { Hera, HeraOutbox, type OutboxQueueBinding } from "@sibylline-labs/hera";

interface Env {
  readonly EVENTS: OutboxQueueBinding;
}

export class OrgDO extends Hera.TenantDurableObject.configure<Env>({
  service: "accounts",
  migrations: [],
  outboxBatchSize: HeraOutbox.QUEUE_LIMITS.maxMessages,
  deliverOutboxBatch: HeraOutbox.queueSink({
    binding: (env) => (env as Env).EVENTS, // the default is env.EVENTS
    encode: (record) =>
      Effect.succeed({
        body: record.payload,
        bytes: HeraOutbox.utf8Bytes(record.payloadJson),
        contentType: "json" as const,
      }),
    onOversize: ({ record, bytes, limit }) =>
      Effect.logError("events.append_rejected", { type: record.type, bytes, limit }),
  }),
}) {}
```

- **Encoding.** `encode(record)` returns the message `body`, its UTF-8 `bytes` and an optional `contentType`. By default the sink sends `record.payload`, sized from `record.payloadJson`. If `encode` fails, the whole batch fails and backs off.
- **Chunking.** The sink sends records in drain order. It splits them into `sendBatch` calls inside `limits`, and waits for each call to finish before it starts the next. `limits` defaults to `HeraOutbox.QUEUE_LIMITS`, which holds Cloudflare Queues' published limits: 100 messages, 256,000 bytes per batch, 128,000 bytes per message, and 100 bytes of metadata counted against each message. The sink measures size in UTF-8 bytes (`HeraOutbox.utf8Bytes`) because the queue counts bytes, not UTF-16 units.
- **Oversize records.** When a single record is larger than one message can hold, the sink rejects it. The other records are still sent. The rejected record is acknowledged with its batch: the event is dropped, and the state change that wrote it stays. Hera logs `hera.outbox.event_rejected` at error, with the `orgId`, `outboxId`, `type`, `bytes` and `limit` but never the payload, and then calls `onOversize`. If `onOversize` fails, Hera logs `hera.outbox.on_oversize_failed` and the batch still goes ahead. `onOversize` can run more than once for the same record: when a later send in its batch fails, the whole batch is retried.
- **Failures.** If the binding is missing, or if any `sendBatch` call rejects, the batch fails and backs off. Chunks that went out before the failure are sent again on the retry, so delivery is at-least-once and consumers dedupe on the event id.
- **Trace context (`trace: true`).** Every outbox row stores the W3C `traceparent` of the span that enqueued it (`record.traceparent`, absent outside a span), and its `requestId` falls back to the request id of the Hera ctx in scope when the event names none; a write inside `transactWithOutbox` sees the caller's span and ctx. With `trace: true`, the sink sends a record that carries either as `{ __heraTrace: { v: 1, traceparent?, requestId? }, payload }`, which `Hera.queueConsumer` unwraps and links to the producer's trace ([guide](workers-and-routes.md#3-queue-consumers-heraqueueconsumer)). Leave it off while any consumer of the queue is not `Hera.queueConsumer`: the default sends the bare payload. `trace` is ignored when you pass `encode`. Objects created before the column existed gain it on their next wake; their earlier rows keep no `traceparent`.
- **The default sink.** A `TenantDurableObject` with no `deliverOutboxBatch` uses the same sink against `env.EVENTS`. It sends Hera's record body, `{ id, orgId, type, payload, requestId, createdAt }`.
- **Org on every line.** A `TenantDurableObject`'s `this.logger` is bound to `this.orgId`, so every line it writes (alarm and outbox failures such as `hera.alarm.arm_failed`, `hera.alarm.rearm_failed` and `hera.outbox.flush_failed` included) carries it in `org_id`, even off a request. A `KeyedDurableObject` binds none.
- **Sink context.** Every sink receives `(records, { env, orgId, logger })`, so a sink you write yourself can reach the object's `env` and logger.

---

## 6. Keyed Durable Objects (`KeyedDurableObject`)

A Durable Object that is not per-org (a token pointer, a device code, an estate-wide registry) extends `KeyedDurableObject` instead. It has the same lazy migrations, `this.db`/`SyncTx`, logger, outbox, composite alarm and jobs as `TenantDurableObject`, without the `orgId` requirement: its identity is `this.key`, `ctx.id.name` decoded by the `key` option.

- The default codec accepts any non-empty name and throws `DurableObjectKeyError` (`invalid_subject`) for an anonymous id. Pass `key` to narrow it to a branded or template-literal type, throwing `DurableObjectKeyError` to refuse a name.
- `this.db` is a `HeraKeyedSqlClient` and its tx handle a `HeraKeyedSyncTx`: the tenant shapes without `orgId`.
- An outbox record's `orgId` field holds the object's key.
- Log lines carry `doId` (`ctx.id.toString()`), never the key, since a key can be a token hash.
- Both bases extend `HeraDurableObjectBase`, so `HeraTest.triggerAlarm` and `HeraTest.inspectOutbox` drive either one.

```ts
import { DurableObjectKeyError, Hera, KeyedDurableObject } from "@sibylline-labs/hera";

class EstateRegistry extends Hera.KeyedDurableObject.configure({
  service: "events-registry",
  migrations: [{ version: 1, name: "001_orgs", sql: "CREATE TABLE orgs (org_id TEXT PRIMARY KEY)" }],
}) {}

type TokenHashName = `tokhash:${string}`;

class TokenPointer extends KeyedDurableObject.configure<Record<string, unknown>, TokenHashName>({
  service: "token-pointer",
  key: (rawName) => {
    if (rawName === undefined || !rawName.startsWith("tokhash:")) {
      throw new DurableObjectKeyError({ reason: "not a token-hash name" });
    }
    return rawName as TokenHashName;
  },
}) {}
```

## 7. Named Jobs (`this.jobs`, `static jobs`)

A class declares its timed jobs as `static jobs`, and `this.jobs` schedules them by name. Rows live in `_hera_jobs` in the object's own SQLite, and they share the composite alarm (§4). A handler takes `(nowMs, self)` and answers the next time it is due, or `null` when it is done. It may return an `Effect`, a `Promise` or a plain value.

| Call | Effect |
|---|---|
| `jobs.schedule(name, atMs \| cron)` | Due at the earlier of the stored time and the new one. A cron string (5 or 6 fields, UTC) also re-arms the job to its next tick after every run. |
| `jobs.ensure(name, atMs \| cron)` | Writes only when the job holds no row, so a waiting or backed-off job keeps its time. |
| `jobs.cancel(name)` | Drops the row. |
| `jobs.adoptDomainAlarm(name)` | Moves the domain-alarm slot (`scheduleDomainAlarm`) onto the job: due at the earlier of the slot and the stored time, and the slot cleared, in one transaction. With no slot it writes nothing and does not initialise an empty object. |
| `jobs.nextAt(name)`, `jobs.earliestAt()` | Read the due times. |

`schedule`, `ensure`, `adoptDomainAlarm` and `cancel` return `SyncEffect`s, so they compose inside `db.transactSync` and roll back with it. An unregistered name, a cron that does not parse, or a non-finite time fails with `HeraJobError` and writes nothing.

**Moving off `onDomainAlarm`.** A live object can still hold a domain slot the previous build armed. Once the new build no longer overrides `onDomainAlarm`, that slot would fire into the empty default hook and the work would wait until something else armed the job. Call `this.jobs.adoptDomainAlarm("<job>")` on wake (or inside the first `transactSync` of the new code path) so the slot's time becomes the job's. It is idempotent: a second call finds no slot.

The semantics:

- **A run holds a lease.** Before a job runs, its row is set due at `now + alarmErrorBackoffMs` with its generation marked leased. A handler that fails is logged as `hera.jobs.failed` and comes back after the backoff, and the jobs after it still run. An object that stops mid-job brings the job back the same way.
- **A schedule during a run is kept.** A `schedule` that lands while the handler awaits moves the generation off the lease, and the handler's answer is merged with it (the earlier time wins). A `cancel` during the run stays cancelled.
- **Jobs due together run in order** of due time, then name. One pass runs the jobs that were due when it started.
- **A row no handler is registered for** (written by another build) is logged as `hera.jobs.unknown` and deleted.
- **A purge during a job** ends the pass. Nothing is written and no alarm is armed.

```ts
import * as Effect from "effect/Effect";
import { Hera, type HeraJobRegistry, type HeraJobScheduler } from "@sibylline-labs/hera";

class DeviceCode extends Hera.KeyedDurableObject.configure({ service: "device-code" }) {
  static readonly jobs = {
    expire: (_nowMs: number, self: DeviceCode) =>
      Effect.sync(() => {
        self.expired = true;
        return null;
      }),
    sweep: () => Effect.succeed(null),
  } satisfies HeraJobRegistry<DeviceCode>;
  declare readonly jobs: HeraJobScheduler<keyof typeof DeviceCode.jobs>;

  expired = false;

  start(expiresAt: number) {
    return this.db.transactSync(function* (tx) {
      yield* tx.exec("SELECT 1");
    }).pipe(
      Effect.andThen(this.jobs.schedule("expire", expiresAt)),
      Effect.andThen(this.jobs.ensure("sweep", "0 * * * *")),
    );
  }
}
```

## 8. The Alarm Owner (`AlarmDriver`) and Purging (`purgeStorage`)

Every arm, read and clear Hera makes on the platform alarm goes through the object's `AlarmDriver`
(`set(atMs)`, `get()`, `clear()`). The default, `StorageAlarmDriver`, is the platform alarm itself, so
a DO that does not override anything behaves exactly as §4 describes. The `hera-alarm-via-driver` lint
rule keeps every other module in `src/` off `ctx.storage.setAlarm` / `getAlarm` / `deleteAlarm`. In a
consumer, schedule work with `this.jobs` or `scheduleDomainAlarm`, never the platform alarm.

### Handing the alarm to another owner (an `agents` `Lifecycle`)

A host whose platform alarm belongs to something else, such as an `agents` `Lifecycle` that re-arms the
alarm from its own job queue, runs Hera's composite pass as one host job:

1. Override `createAlarmDriver()` with a driver over that owner. For a Lifecycle, it keeps a single host
   job (`push({ id, fn, time })`, `get(id)?.time`, `cancel(id)`). The base resolves the driver once, on
   first use after construction, so it may read the subclass's own fields.
2. Override `alarm()` to delegate (`await this.lifecycle.alarm()`). `Lifecycle.install(this)` keeps a
   handler the host already has, and Hera's `alarm()` is on the prototype.
3. From the host job, call `runCompositePass()` and return its answer: `{ rescheduleAt: nextAt }`, or
   nothing when it is `null`.

```typescript
import { Lifecycle } from "agents/lifecycle";
import { type AlarmDriver, TenantDurableObject } from "@sibylline-labs/hera";

const COMPOSITE_JOB = "hera:composite";

export class AgentsTenant extends TenantDurableObject.configure({ service: "agents", migrations: [] }) {
  readonly lifecycle = Lifecycle.install(this);

  protected override createAlarmDriver(): AlarmDriver {
    const jobs = () => this.lifecycle.jobs;
    return {
      set: async (atMs) => {
        await jobs().push({ id: COMPOSITE_JOB, fn: COMPOSITE_JOB, time: atMs });
      },
      get: async () => jobs().get(COMPOSITE_JOB)?.time ?? null,
      clear: async () => {
        await jobs().cancel(COMPOSITE_JOB);
      },
    };
  }

  override async alarm(): Promise<void> {
    await this.lifecycle.alarm();
  }

  async onJob({ job }: { readonly job: { readonly fn: string } }) {
    if (job.fn !== COMPOSITE_JOB) return undefined;
    const nextAt = await this.runCompositePass();
    return nextAt === null ? undefined : { rescheduleAt: nextAt };
  }

  protected override async beforePurge(): Promise<void> {
    await this.lifecycle.dispose();
    await this.lifecycle.disableAlarms();
  }
}
```

`runCompositePass()` is `protected`, so Workers RPC never reaches it. It runs the pass `alarm()` runs
at the object's own clock, with the same invariants, tenant context and lazy-init guard. It arms
nothing. It answers the next wake: the earlier of the time the pass would have armed and the composite
time still pending once it settles. It answers `null` when nothing is pending, or when storage was
purged during the pass. Slot syncs are deferred while it runs, and the answer covers them.
This matters because a Lifecycle discards a job's `{ rescheduleAt }` when the same job is pushed again
during its dispatch.

Reverting is dropping the override: on its next wake, an object re-arms the platform alarm from
SQLite, because the composite time lives there and not in the driver.

### `purgeStorage()`

`purgeStorage()` empties the object, in order:

1. it clears the driver's alarm, so a failure after this point leaves nothing to wake and a retry finishes;
2. it runs `protected beforePurge()` (an Effect, a Promise or nothing), the host's teardown. A failure
   rejects the purge with the data intact and no alarm armed, so the caller must retry;
3. it marks the object purged, with no await before the next step: from here `this.db` refuses every
   statement (`exec`, `query`, `enqueueOutbox`, `transactSync`, `transactWithOutbox`) with a
   `HeraSqlError`, the transaction check running inside `transactionSync`, and nothing re-initialises
   the storage. A request that awaited across the purge (a `fetch`, a cross-DO RPC) so cannot
   re-create the tables the purge empties. `beforePurge` runs before the mark, so a host draining its
   in-flight writes there still writes. A host with its own refusal (a 404 or 409) reads the
   protected `isPurged()` before touching `this.db`;
4. it calls `ctx.storage.deleteAll()`;
5. it calls `ctx.abort("hera.purge")` on the next macrotask.

The reset waits because a synchronous `ctx.abort()` rejects the RPC caller, and a purge door that
retries on failure would then never settle. The next call reaches a fresh, uninitialised instance.

## 9. State Machines (`HeraStateMachine.define`)

A table whose rows move through a lifecycle (`open` → `answered`) declares that graph once, and every
write to its state column goes through the machine. Exported from `@sibylline-labs/hera` and
`@sibylline-labs/hera/durable-object`.

```ts
import { Hera, HeraStateMachine } from "@sibylline-labs/hera";

export const TICKETS = HeraStateMachine.define({
  table: "tickets",
  pk: "id",
  column: "state",
  states: ["open", "snoozed", "answered", "withdrawn"],
  initial: ["open"],
  terminal: ["answered", "withdrawn"],
  transitions: { open: ["snoozed", "answered", "withdrawn"], snoozed: ["open", "withdrawn"] },
});

class TicketDesk extends Hera.KeyedDurableObject.configure({
  service: "ticket-desk",
  migrations: [
    {
      version: 1,
      name: "001_tickets",
      sql: "CREATE TABLE tickets (id TEXT PRIMARY KEY, state TEXT NOT NULL, notice TEXT, version INTEGER NOT NULL DEFAULT 0)",
    },
  ],
}) {
  open(id: string) {
    return this.db.transactSync((tx) => TICKETS.insert(tx, { id, state: "open" }));
  }

  answer(id: string) {
    return this.db.transactWithOutbox(function* (tx) {
      const moved = yield* TICKETS.transition(tx, id, {
        from: ["open"],
        to: "answered",
        set: { notice: "pending" },
      });
      if (moved.matched) {
        yield* tx.enqueueOutbox({ type: "ticket.answered@1", payload: { id } });
      }
      return moved.matched;
    });
  }
}
```

**What the compiler refuses.** `define` fails `tsc --noEmit`, with the error on `transitions` naming
the state, when:

- a state is neither initial nor the target of a transition (`HeraStateMachine: unreachable state`);
- a non-terminal state has no outgoing transition, or an empty one (`HeraStateMachine: non-terminal state with no exit`);
- `initial`, `terminal`, a transition key or a target names a state outside `states`.

On the machine, `transition` refuses a `from → to` pair the graph lacks, an empty `from`, a `set` that
names the state column or a key column (in any case: SQLite resolves `STATE` to `state`), a `set`
whose keys are not known at compile time (a `Record<string, …>`), a composite key of the wrong
length, a `where` that is empty or carries a runtime value (`string` or a template literal type such
as `` `${string} OR 1=1` ``), and a `db` passed where a transaction handle is expected. `insert`
refuses a row whose state is not initial, or that spells the state column twice. `define` refuses
a state column that is also a key column.

**What runs.** `transition(tx, key, { from, to, where?, params?, set? })` is one statement inside
the caller's transaction:

```sql no-check
UPDATE "tickets" SET "state" = ?, "notice" = ? WHERE "id" = ? AND "state" IN (?) RETURNING "id"
```

It resolves `{ matched, count }`, the rows it moved, counted from `RETURNING` (on workerd, a
cursor's `rowsWritten` also counts index writes). A row that already left `from` is not touched and
the result is `{ matched: false, count: 0 }`: the caller lost the race and decides what that means.
`insert(tx, row)` is `INSERT INTO "<table>" (…) VALUES (…)`. Identifiers are checked against
`[A-Za-z_][A-Za-z0-9_]*`, compared case-insensitively and quoted; every value is a bound parameter.
`where` is a literal SQL fragment ANDed into the `WHERE` as `(<where>)`; it must be one balanced
predicate (no `;`, comments, or a `)` that closes the wrapper) whose only placeholders are bare `?`
(no `?1`, `:name`, `@name` or `$name`), and its `?` values go in `params`, which bind only with a
`where`.

**Composite keys.** `pk: ["team_id", "slot"]` addresses a row by every key column, and `key` is a
tuple of the same length: `MACHINE.transition(tx, ["team_1", "default"], { … })`.

**Cycles and stale callers.** A graph with a cycle (`open → snoozed → open`) can bring a row back to
a `from` state. A caller that read the row before an `await` and transitions after it should guard on
a version column, so its stale write matches nothing:

```ts no-check
TICKETS.transition(tx, id, {
  from: ["open"],
  to: "snoozed",
  where: "version = ?",
  params: [readVersion],
  set: { version: readVersion + 1 },
});
```

**Untyped callers.** `define` repeats every declaration check at run time and throws
`HeraStateMachineError` (`internal_error`) when the module loads. A call that bypassed the types (an
illegal pair, a bad key, a non-initial insert, a case-variant spelling of the state or key
column, an unbalanced `where`) dies with `HeraStateMachineError` inside the
transaction, which rolls back everything the transaction wrote.

The declared graph stays readable on the machine (`table`, `pk`, `column`, `states`, `initial`,
`terminal`, `transitions`, all frozen), and the `define({ … })` literal is what static tooling reads.
