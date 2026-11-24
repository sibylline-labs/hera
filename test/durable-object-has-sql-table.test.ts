import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { Hera, type HeraMigration } from "../src/index"
import { hasSqlTable, hasSqlTableTx } from "../src/server/durable-object/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"
import { SAMPLE_IDS } from "../src/testing/index"

const MIGRATIONS: ReadonlyArray<HeraMigration> = [
  { version: 1, name: "001_items", sql: "CREATE TABLE items (id TEXT PRIMARY KEY)" },
]

class ItemsDO extends Hera.TenantDurableObject.configure({ service: "items", migrations: MIGRATIONS }) {}

describe("hasSqlTable / hasSqlTableTx", () => {
  // admits: a swapped or inverted probe (present reads false, absent reads true) in either form;
  // no cheaper rung holds the exported surface that consumers' hand-rolled probes are replaced by.
  it("reports a present table true and an absent one false, on raw storage and inside a tx", () => {
    const harness = makeTestDurableObjectState({ idName: SAMPLE_IDS.orgId })
    const tenantDo = new ItemsDO(harness.state, {})
    // hera-allow: raw-effect-run
    Effect.runSync(tenantDo.db.transactSync((tx) => tx.exec("INSERT INTO items (id) VALUES (?)", ["a"])))

    expect(hasSqlTable(harness.state.storage.sql, "items")).toBe(true)
    expect(hasSqlTable(harness.state.storage.sql, "missing")).toBe(false)

    // hera-allow: raw-effect-run
    const inTx = Effect.runSync(
      tenantDo.db.transactSync((tx) =>
        tx.gen(function* () {
          yield* tx.exec("CREATE TABLE made_in_tx (id TEXT)")
          return [yield* hasSqlTableTx(tx, "items"), yield* hasSqlTableTx(tx, "made_in_tx"), yield* hasSqlTableTx(tx, "missing")]
        })
      )
    )
    expect(inTx).toEqual([true, true, false])
    // hera-allow: raw-effect-run
    expect(Effect.runSync(hasSqlTableTx(tenantDo.db, "items"))).toBe(true)
  })
})
