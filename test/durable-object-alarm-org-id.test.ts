import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { Hera, type HeraMigration, type LogEntry, SyncTx } from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

// A tenant DO's own failure lines carry its OrgId in the `org_id` slot,
// not only in a free `orgId` field.
const MIGRATIONS: ReadonlyArray<HeraMigration> = [
  { version: 1, name: "001_items", sql: "CREATE TABLE items (id TEXT NOT NULL PRIMARY KEY)" },
]
const T0 = 1_700_000_000_000

class OrgDO extends Hera.TenantDurableObject.configure({
  service: "org-id-test",
  migrations: MIGRATIONS,
  outboxBackoff: { baseDelayMs: 1_000, maxDelayMs: 60_000, jitterRatio: 0 },
}) {}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function enqueue(tenantDo: OrgDO, id: string): Promise<unknown> {
  return tenantDo.runWithTenantCtx(
    tenantDo.db.transactWithOutbox(function* (tx) {
      return yield* tx.enqueueOutbox({ id, type: "item.created@1", payload: { id } })
    })
  )
}

function logsOf(): { readonly logs: Array<LogEntry>; readonly sink: (line: string, entry: LogEntry) => void } {
  const logs: Array<LogEntry> = []
  return { logs, sink: (_line, entry) => void logs.push(entry) }
}

describe("tenant DO failure lines bind org_id", () => {
  // admits: the arm-failure handler runs on a detached fiber with no tenant ctx; runtime wiring
  it("hera.alarm.arm_failed carries org_id", async () => {
    const { logs, sink } = logsOf()
    const harness = makeTestDurableObjectState({
      initialTimeMs: T0,
      onSetAlarm: () => {
        throw new Error("storage unavailable")
      },
    })
    const tenantDo = new OrgDO(harness.state, {}, { sink })
    await enqueue(tenantDo, "evt_arm")
    await flush()
    const line = logs.find((entry) => entry.msg === "hera.alarm.arm_failed")
    expect(line?.org_id).toBe(tenantDo.orgId)
  })

  // admits: the wake re-arm runs from the constructor, outside any fiber; runtime wiring
  it("hera.alarm.rearm_failed carries org_id", async () => {
    let failArm = false
    const harness = makeTestDurableObjectState({
      initialTimeMs: T0,
      onSetAlarm: () => {
        if (failArm) throw new Error("storage unavailable")
      },
    })
    const first = new OrgDO(harness.state, {})
    await enqueue(first, "evt_rearm")
    await flush()
    // hera-allow: alarm-via-driver
    await harness.state.storage.deleteAlarm()
    failArm = true
    const { logs, sink } = logsOf()
    const woken = new OrgDO(harness.state, {}, { sink })
    await flush()
    await flush()
    const line = logs.find((entry) => entry.msg === "hera.alarm.rearm_failed")
    expect(line?.org_id).toBe(woken.orgId)
  })

  // admits: drainOutbox is RPC-callable with no tenant ctx in the fiber; runtime wiring
  it.each([
    ["an alarm pass", (tenantDo: OrgDO) => tenantDo.alarm()],
    ["a direct drainOutbox call", (tenantDo: OrgDO) => Effect.runPromise(tenantDo.drainOutbox()).then(() => undefined)],
  ])("hera.outbox.flush_failed carries org_id from %s", async (_label, drive) => {
    const { logs, sink } = logsOf()
    const harness = makeTestDurableObjectState({ initialTimeMs: T0 })
    const tenantDo = new OrgDO(harness.state, {}, {
      sink,
      deliverOutboxBatch: () => {
        throw new Error("upstream 503")
      },
    })
    Effect.runSync(tenantDo.db.transactSync(SyncTx.succeed(undefined)))
    await enqueue(tenantDo, "evt_flush")
    await drive(tenantDo)
    const line = logs.find((entry) => entry.msg === "hera.outbox.flush_failed")
    expect(line?.org_id).toBe(tenantDo.orgId)
  })
})
