import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { HeraAgentEgress } from "../src/server/agent/egress/egress.js"
import { HERA_AGENT_METER_TABLE, HeraAgentMeter, type MeterSql } from "../src/server/agent/egress/meter.js"
import { makeOperationResolver } from "../src/server/agent/host/operation-resolver.js"
import { HeraAgentModels } from "../src/server/agent/models/catalog.js"
import { agentTool } from "../src/server/agent/tool/agent-tool.js"
import { toRegistration } from "../src/server/agent/tool/registration.js"
import { HeraAgentTest } from "../src/testing/agent/index.js"

const ctx = BACKGROUND_CONTEXT

function sqliteOf(db: DatabaseSync): MeterSql {
  // Eager, as the Durable Object cursor is: a write is never followed by `toArray()`.
  return {
    exec: (query, ...bindings) => {
      const rows = db.prepare(query).all(...(bindings as never[])) as Array<Record<string, unknown>>
      return { toArray: () => rows }
    },
  }
}

const row = { atMs: 1, model: "m", inputTokens: 1, candidatesTokens: 1, thoughtsTokens: 0, cachedTokens: 0, totalTokens: 2 }

describe("HeraAgentMeter operationId", () => {
  // admits: a row losing its operation on the SQLite round trip, or an unattributed row reading as an empty string.
  it("round-trips operationId, and reads a row written without one as undefined", () => {
    const meter = HeraAgentMeter.sqlite(sqliteOf(new DatabaseSync(":memory:")))
    meter.record({ ...row, logId: "a", operationId: "op-a" })
    meter.record({ ...row, logId: "b" })
    expect(meter.rows().map((r) => [r.logId, r.operationId])).toEqual([["a", "op-a"], ["b", undefined]])
  })

  // admits: a deployed object's pre-existing table (no operation_id) refusing the new INSERT.
  it("adds operation_id to a table created before the column and keeps its rows", () => {
    const db = new DatabaseSync(":memory:")
    db.exec(`CREATE TABLE ${HERA_AGENT_METER_TABLE} (log_id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, candidates_tokens INTEGER NOT NULL, thoughts_tokens INTEGER NOT NULL,
      cached_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL)`)
    db.exec(`INSERT INTO ${HERA_AGENT_METER_TABLE} VALUES ('old', 1, 'm', 1, 1, 0, 0, 2)`)
    const meter = HeraAgentMeter.sqlite(sqliteOf(db))
    meter.record({ ...row, atMs: 2, logId: "new", operationId: "op-n" })
    expect(meter.rows().map((r) => [r.logId, r.operationId])).toEqual([["old", undefined], ["new", "op-n"]])
  })
})

describe("operation resolver and tool context", () => {
  const tool = (seen: Array<{ session: string; operationId: string | undefined }>) =>
    agentTool({
      name: "lookup",
      description: "Look up a value.",
      input: Schema.Struct({ key: Schema.String }),
      execute: (_input, { session, operationId }) => Effect.sync(() => (seen.push({ session, operationId }), "v")),
    })

  async function run(withResolver: boolean) {
    const storage = new MemoryStorage()
    const seen: Array<{ session: string; operationId: string | undefined }> = []
    const models = HeraAgentEgress.make({
      config: { accountId: "acct", gateway: "gw", apiKey: "k" },
      metadata: { tenant: "org_t", agent: "probe", service: "test" },
      model: HeraAgentModels.default,
      meter: HeraAgentMeter.memory(),
      upstream: HeraAgentTest.script([HeraAgentTest.toolCall("lookup", { key: "a" }), HeraAgentTest.text("done")]),
    })
    const registry = createRegistry()
    const resolver = withResolver ? makeOperationResolver(storage, ctx) : undefined
    registry.install({ name: "probe", sections: [], tools: [toRegistration(tool(seen), resolver)] })
    const harness = await Harness.open(storage, { models, registry }, ctx)
    const root = await harness.root(ctx, { agent: { model: { provider: "google", modelId: "gemma-4-26b-a4b-it" } } })
    await (await root.submit({ type: "input", content: "go", requestId: "op-x" }, ctx)).wait(ctx)
    await harness.close(ctx)
    return { seen, root: String(root.id) }
  }

  // admits: the resolver reading the wrong submission state (queued or settled instead of placed).
  it("hands the handler the running operation's id and session", async () => {
    const { seen, root } = await run(true)
    expect(seen).toEqual([{ session: root, operationId: "op-x" }])
  })

  // admits: a bare toRegistration (no Hera.agent host) inventing an operation.
  it("leaves operationId undefined without a resolver, and still gives the session", async () => {
    const { seen, root } = await run(false)
    expect(seen).toEqual([{ session: root, operationId: undefined }])
  })
})
