import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import {
  Hera,
  type HeraMigration,
  HeraMigrationError,
  SyncTx,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"
import { SAMPLE_IDS } from "../src/testing/index"

const MIGRATIONS: ReadonlyArray<HeraMigration> = [
  { version: 1, name: "001_items", sql: "CREATE TABLE items (id TEXT PRIMARY KEY)" },
  { version: 2, name: "002_item_note", sql: "ALTER TABLE items ADD COLUMN note TEXT" },
]

class ItemsDO extends Hera.TenantDurableObject.configure({
  service: "items",
  migrations: MIGRATIONS,
}) {}

type Harness = ReturnType<typeof makeTestDurableObjectState>

function tables(harness: Harness): ReadonlyArray<string> {
  return (
    harness.sqliteDb
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name)
}

const insertItem = (tenantDo: ItemsDO, id: string) =>
  // hera-allow: raw-effect-run
  Effect.runSync(
    tenantDo.db.transactSync((tx) => tx.exec("INSERT INTO items (id) VALUES (?)", [id]))
  )

describe("TenantDurableObject lazy storage initialisation", () => {
  it("construction and every read helper leave sqlite_master empty", async () => {
    const harness = makeTestDurableObjectState({ idName: SAMPLE_IDS.orgId })
    const tenantDo = new ItemsDO(harness.state, {})

    expect(tenantDo.isInitialized()).toBe(false)
    expect(tenantDo.db.isInitialized()).toBe(false)
    expect(tenantDo.getAppliedMigrations()).toEqual([])
    expect(tenantDo.getPendingOutboxRecords()).toEqual([])
    expect(tenantDo.getNextOutboxRetryAt()).toBeNull()
    expect(tenantDo.getDomainAlarmAt()).toBeNull()
    expect(tenantDo.getNextCompositeAlarmAt()).toBeNull()
    // hera-allow: raw-effect-run
    expect(await Effect.runPromise(tenantDo.drainOutbox())).toEqual({
      drained: 0,
      failed: 0,
      remaining: 0,
      nextRetryAt: null,
    })
    // hera-allow: raw-effect-run
    Effect.runSync(tenantDo.cancelDomainAlarm())

    expect(tables(harness)).toEqual([])
  })

  it("alarm() on an uninitialised object writes nothing and arms nothing", async () => {
    const harness = makeTestDurableObjectState()
    const tenantDo = new ItemsDO(harness.state, {})
    await tenantDo.alarm()
    expect(tables(harness)).toEqual([])
    expect(harness.getScheduledAlarm()).toBeNull()
    expect(harness.setAlarmCalls).toEqual([])
  })

  it("the first write creates the internal tables and applies migrations in its own transaction", () => {
    const harness = makeTestDurableObjectState()
    const tenantDo = new ItemsDO(harness.state, {})
    insertItem(tenantDo, "a")

    expect(tables(harness)).toEqual([
      "_hera_alarm_meta",
      "_hera_jobs",
      "_hera_migrations",
      "_hera_outbox",
      "_hera_outbox_dead_letter",
      "items",
    ])
    expect(tenantDo.getAppliedMigrations().map((m) => m.version)).toEqual([1, 2])
    expect(harness.transactionCount()).toBe(1)
  })

  it("a rolled-back first write rolls the initialisation back with it", () => {
    const harness = makeTestDurableObjectState()
    const tenantDo = new ItemsDO(harness.state, {})
    // hera-allow: raw-effect-run
    const exit = Effect.runSyncExit(tenantDo.db.transactSync(SyncTx.fail("nope")))
    expect(exit._tag).toBe("Failure")
    expect(tables(harness)).toEqual([])
  })

  it("scheduleDomainAlarm and a bare exec are write paths", () => {
    const scheduled = makeTestDurableObjectState()
    const alarmDo = new ItemsDO(scheduled.state, {})
    // hera-allow: raw-effect-run
    Effect.runSync(alarmDo.scheduleDomainAlarm(scheduled.nowMs() + 1_000))
    expect(alarmDo.isInitialized()).toBe(true)
    expect(alarmDo.getDomainAlarmAt()).toBe(scheduled.nowMs() + 1_000)

    const execd = makeTestDurableObjectState()
    const execDo = new ItemsDO(execd.state, {})
    // hera-allow: raw-effect-run
    Effect.runSync(execDo.db.exec("INSERT INTO items (id) VALUES (?)", ["x"]))
    expect(execDo.getAppliedMigrations()).toHaveLength(2)
  })

  it("re-initialises on the next write after ctx.storage.deleteAll()", async () => {
    const harness = makeTestDurableObjectState()
    const tenantDo = new ItemsDO(harness.state, {})
    insertItem(tenantDo, "a")

    await harness.state.storage.deleteAll()
    expect(tenantDo.isInitialized()).toBe(false)
    expect(tenantDo.getPendingOutboxRecords()).toEqual([])
    await tenantDo.alarm()
    expect(tables(harness)).toEqual([])

    insertItem(tenantDo, "b")
    expect(tenantDo.getAppliedMigrations().map((m) => m.version)).toEqual([1, 2])
  })

  it("a woken object that already holds state is migrated on construction", () => {
    const harness = makeTestDurableObjectState()
    insertItem(new ItemsDO(harness.state, {}), "a")

    class ItemsV3 extends Hera.TenantDurableObject.configure({
      migrations: [...MIGRATIONS, { version: 3, name: "003_tag", sql: "ALTER TABLE items ADD COLUMN tag TEXT" }],
    }) {}
    const woken = new ItemsV3(harness.state, {})
    expect(woken.getAppliedMigrations().map((m) => m.version)).toEqual([1, 2, 3])
  })

  describe("legacy migration ledger adoption", () => {
    const seedLegacy = (harness: Harness, applied: ReadonlyArray<number>) => {
      harness.sqliteDb.exec("CREATE TABLE yak_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
      harness.sqliteDb.exec("CREATE TABLE items (id TEXT PRIMARY KEY)")
      if (applied.includes(2)) {
        harness.sqliteDb.exec("ALTER TABLE items ADD COLUMN note TEXT")
      }
      for (const id of applied) {
        harness.sqliteDb.exec(`INSERT INTO yak_migrations (id, applied_at) VALUES (${id}, '2026-10-01T00:00:00Z')`)
      }
    }

    class LegacyItemsDO extends Hera.TenantDurableObject.configure({
      migrations: [...MIGRATIONS, { version: 3, name: "003_tag", sql: "ALTER TABLE items ADD COLUMN tag TEXT" }],
      legacyMigrationLedger: { table: "yak_migrations", versionColumn: "id" },
    }) {}

    it("adopts the legacy versions on wake and applies only the rest, never re-running an ALTER", () => {
      const harness = makeTestDurableObjectState()
      seedLegacy(harness, [1, 2])
      const tenantDo = new LegacyItemsDO(harness.state, {})

      expect(tenantDo.getAppliedMigrations().map((m) => [m.version, m.name])).toEqual([
        [1, "001_items"],
        [2, "002_item_note"],
        [3, "003_tag"],
      ])
      const columns = (harness.sqliteDb.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>).map((c) => c.name)
      expect(columns).toEqual(["id", "note", "tag"])
      expect(() => new LegacyItemsDO(harness.state, {})).not.toThrow()
    })

    it("fails closed when the legacy ledger names a version no migration declares", () => {
      const harness = makeTestDurableObjectState()
      seedLegacy(harness, [1, 2])
      harness.sqliteDb.exec("INSERT INTO yak_migrations (id, applied_at) VALUES (9, 'x')")
      expect(() => new LegacyItemsDO(harness.state, {})).toThrowError(HeraMigrationError)
      expect(tables(harness)).not.toContain("_hera_migrations")
    })

    it("rejects a ledger table or column that is not a plain identifier", () => {
      const harness = makeTestDurableObjectState()
      expect(
        () => new ItemsDO(harness.state, {}, { legacyMigrationLedger: { table: "x; DROP TABLE items" } })
      ).toThrowError(HeraMigrationError)
    })
  })
})
