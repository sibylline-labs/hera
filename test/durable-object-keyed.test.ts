import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import {
  DurableObjectKeyError,
  Hera,
  type HeraMigration,
  KeyedDurableObject,
  SyncTx,
  TenantDurableObject,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

const MIGRATIONS: ReadonlyArray<HeraMigration> = [
  { version: 1, name: "001_pointer", sql: "CREATE TABLE pointer (id INTEGER PRIMARY KEY, owner TEXT NOT NULL)" },
]
const T0 = 1_700_000_000_000

class Pointer extends Hera.KeyedDurableObject.configure({ service: "pointer", migrations: MIGRATIONS }) {}

type TokenHashName = `tokhash:${string}`
const tokenHashName = (raw: string | undefined): TokenHashName => {
  if (raw === undefined || !/^tokhash:[0-9a-f]+$/.test(raw)) {
    throw new DurableObjectKeyError({ reason: "not a token-hash name" })
  }
  return raw as TokenHashName
}
class HashPointer extends KeyedDurableObject.configure<Record<string, unknown>, TokenHashName>({
  service: "hash-pointer",
  migrations: MIGRATIONS,
  key: tokenHashName,
}) {}

describe("KeyedDurableObject", () => {
  // admits: a non-tenant DO cannot use Hera's migration runner and SyncTx without an OrgId; runtime storage behaviour
  it("migrates and runs SyncTx on an object named by a non-OrgId key", async () => {
    const harness = makeTestDurableObjectState({ idName: "tokhash:abc123", initialTimeMs: T0 })
    const pointer = new Pointer(harness.state, {})
    expect(pointer.key).toBe("tokhash:abc123")
    expect(pointer.isInitialized()).toBe(false)

    const owner = Effect.runSync(
      pointer.db.transactSync(function* (tx) {
        yield* tx.exec("INSERT INTO pointer (id, owner) VALUES (1, ?)", ["org_a"])
        const rows = yield* tx.query<{ owner: string }>("SELECT owner FROM pointer WHERE id = 1")
        return rows[0]?.owner
      })
    )
    expect(owner).toBe("org_a")
    expect(pointer.getAppliedMigrations().map((m) => m.name)).toEqual(["001_pointer"])
    // @ts-expect-error a keyed DO's db carries no orgId
    expect(pointer.db.orgId).toBeUndefined()
  })

  // admits: the outbox on a keyed DO loses its owner; runtime record shape
  it("stamps outbox records with the object's key", async () => {
    const harness = makeTestDurableObjectState({ idName: "estate", initialTimeMs: T0 })
    const pointer = new Pointer(harness.state, {}, { deliverOutboxBatch: () => undefined })
    const record = Effect.runSync(
      pointer.db.transactWithOutbox(function* (tx) {
        return yield* tx.enqueueOutbox({ type: "estate.touched@1", payload: { n: 1 } })
      })
    )
    expect(record.orgId).toBe("estate")
    expect(pointer.getPendingOutboxRecords()).toHaveLength(1)
    await pointer.alarm()
    expect(pointer.getPendingOutboxRecords()).toHaveLength(0)
  })

  // admits: an anonymous id or a name the codec refuses constructs an object with no identity; runtime ctx.id
  it("refuses an anonymous id and a name its key codec rejects", () => {
    const anonymous = makeTestDurableObjectState({ idName: null })
    expect(() => new Pointer(anonymous.state, {})).toThrow(DurableObjectKeyError)

    const wrong = makeTestDurableObjectState({ idName: "org:01ARZ3NDEKTSV4RRFFQ69G5FAV" })
    expect(() => new HashPointer(wrong.state, {})).toThrow(DurableObjectKeyError)
    const right = makeTestDurableObjectState({ idName: "tokhash:00ff" })
    expect(new HashPointer(right.state, {}).key).toBe("tokhash:00ff")
  })

  // admits: re-basing the tenant DO changes its identity rules; runtime constructor behaviour
  it("leaves TenantDurableObject's OrgId identity unchanged", () => {
    class Org extends TenantDurableObject.configure({ service: "org" }) {}
    const harness = makeTestDurableObjectState({ idName: "tokhash:abc" })
    expect(() => new Org(harness.state, {})).toThrow()
    const ok = new Org(makeTestDurableObjectState({}).state, {})
    expect(ok.orgId).toBe(ok.key)
    const exit = Effect.runSyncExit(ok.db.transactSync(SyncTx.succeed(ok.db.orgId)))
    expect(Exit.isSuccess(exit) && exit.value).toBe(ok.orgId)
  })
})
