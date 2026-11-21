import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { Hera, HeraAgentModels, type HeraAgentUpstream } from "../../../src/server/agent/index.js"
import { HeraAgentTest } from "../../../src/testing/agent/index.js"

interface Env {
  readonly ORG: DurableObjectNamespace<AgentOrg>
  readonly CONTENT: DurableObjectNamespace<AgentOrgContent>
}

/** Per-object event logs that outlive an object reset (`ctx.abort`): the isolate keeps its module. */
const purgeEvents = new Map<string, string[]>()

const ensureTables = (sql: SqlStorage) => {
  sql.exec("CREATE TABLE IF NOT EXISTS tool_exec (call_id TEXT NOT NULL, at INTEGER NOT NULL)")
  sql.exec("CREATE TABLE IF NOT EXISTS side_effects (call_id TEXT PRIMARY KEY, at INTEGER NOT NULL)")
  sql.exec("CREATE TABLE IF NOT EXISTS tool_ops (session TEXT NOT NULL, call_id TEXT NOT NULL, operation_id TEXT)")
  sql.exec("CREATE TABLE IF NOT EXISTS fixture_cfg (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
}

const Lookup = Schema.Struct({ key: Schema.String })

/** Every step is slow enough that an eviction lands inside it. */
const SCRIPTS: Record<string, ReadonlyArray<Parameters<typeof HeraAgentTest.script>[0][number]>> = {
  chaos: [HeraAgentTest.toolCall("lookup", { key: "alpha" }, { delayMs: 600 }), HeraAgentTest.text("alpha=v", { delayMs: 600 })],
  concurrent: [HeraAgentTest.toolCall("lookup", { key: "alpha" }, { delayMs: 300 }), HeraAgentTest.text("alpha=v", { delayMs: 300 })],
  coerced: [HeraAgentTest.toolCall("lookup", { key: 3 }), HeraAgentTest.text("refused")],
  plain: [HeraAgentTest.toolCall("lookup", { key: "alpha" }), HeraAgentTest.text("alpha=v")],
}

/** A minimal agent consumer: one replay-safe tool whose side effect is idempotent by `callId`. */
export class AgentOrg extends Hera.agent<Env>({
  service: "workerd-agent",
  agent: "fixture",
  instructions: "You are a terse test agent.",
  tools: (host) => [
    Hera.agentTool({
      name: "lookup",
      description: "Look up the value stored under a key.",
      input: Lookup,
      execute: ({ key }, { callId, session, operationId }) =>
        Effect.promise(async () => {
          const sql = host.ctx.storage.sql
          ensureTables(sql)
          sql.exec("INSERT INTO tool_ops VALUES (?, ?, ?)", session, callId, operationId ?? null)
          sql.exec("INSERT INTO tool_exec VALUES (?, ?)", callId, Date.now())
          await new Promise((resolve) => setTimeout(resolve, 600))
          sql.exec("INSERT OR IGNORE INTO side_effects VALUES (?, ?)", callId, Date.now())
          return `${key}=v`
        }),
    }),
  ],
  egress: () => ({ accountId: "acct_fixture", gateway: "gw-fixture", apiKey: Redacted.make("fixture-key") }),
  telemetry: () => ({
    environment: "workerd-test",
    sink: { baseUrl: "http://otlp.test", token: Redacted.make("fixture-token") },
  }),
}) {
  protected override createEgressUpstream(): HeraAgentUpstream {
    ensureTables(this.ctx.storage.sql)
    const mode = this.ctx.storage.sql.exec("SELECT v FROM fixture_cfg WHERE k = 'script'").toArray()[0]?.v
    return HeraAgentTest.script(SCRIPTS[String(mode ?? "chaos")] ?? [])
  }

  override async dispose(): Promise<void> {
    purgeEvents.get(this.orgId)?.push("dispose")
    await super.dispose()
  }

  async start(script: string, operationId: string) {
    ensureTables(this.ctx.storage.sql)
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO fixture_cfg VALUES ('script', ?)", script)
    return this.submit({ operationId, prompt: "Call lookup with key alpha, then reply with the value." })
  }

  /** Two conversations on one host, one operation each, submitted together. */
  async startTwo(operationA: string, operationB: string) {
    ensureTables(this.ctx.storage.sql)
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO fixture_cfg VALUES ('script', 'concurrent')")
    const root = await this.pi()
    const second = await (await root.pi()).createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: { provider: "google", modelId: HeraAgentModels.default.id } } },
      BACKGROUND_CONTEXT
    )
    const prompt = "Call lookup with key alpha, then reply with the value."
    const sessionB = String(second.id)
    const [a, b] = await Promise.all([
      this.submit({ operationId: operationA, prompt }),
      this.submit({ operationId: operationB, prompt, session: sessionB }),
    ])
    return { a, b }
  }

  readonly incarnation = crypto.randomUUID().slice(0, 8)

  evict(): void {
    this.ctx.abort("forced eviction")
  }

  async purge(): Promise<void> {
    const events: string[] = []
    purgeEvents.set(this.orgId, events)
    const storage = this.ctx.storage
    const deleteAll = storage.deleteAll.bind(storage)
    storage.deleteAll = async (options) => {
      events.push("deleteAll")
      return deleteAll(options)
    }
    const abort = this.ctx.abort.bind(this.ctx)
    this.ctx.abort = (reason) => {
      events.push("abort")
      abort(reason)
    }
    await this.purgeStorage()
  }

  async observe() {
    const sql = this.ctx.storage.sql
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((r) => String(r.name))
    const has = (t: string) => tables.includes(t)
    const pi = has("tool_exec") ? await this.pi() : undefined
    return {
      tables,
      pending: pi === undefined ? [] : (await pi.pending()).map((p) => p.status),
      toolExec: has("tool_exec") ? sql.exec("SELECT call_id, count(*) AS n FROM tool_exec GROUP BY call_id").toArray() : [],
      sideEffects: has("side_effects") ? sql.exec("SELECT call_id FROM side_effects").toArray().map((r) => String(r.call_id)) : [],
      toolResults: pi !== undefined
        ? (await pi.messages())
            .flatMap((e) => e.model ?? [])
            .filter((m) => m.role === "toolResult")
            .map((m) => ({ id: m.toolCallId, isError: m.isError }))
        : [],
      taskTraceIds: has("pi_tasks")
        ? sql
            .exec("SELECT record FROM pi_tasks ORDER BY id")
            .toArray()
            .map((r) => (JSON.parse(String(r.record)) as { trace?: { traceparent?: string } }).trace?.traceparent?.split("-")[1] ?? "none")
        : [],
      meter: this.agentMeter.rows().map((r) => r.logId),
      meterOperations: this.agentMeter.rows().map((r) => r.operationId ?? null),
      toolOps: has("tool_ops")
        ? sql.exec("SELECT session, call_id, operation_id FROM tool_ops ORDER BY session").toArray().map((r) => ({
            session: String(r.session),
            callId: String(r.call_id),
            operationId: r.operation_id === null ? null : String(r.operation_id),
          }))
        : [],
      purgeEvents: purgeEvents.get(this.orgId) ?? [],
      incarnation: this.incarnation,
      alarm: await this.ctx.storage.getAlarm(),
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.searchParams.get("ns") === "content") {
      const content = env.CONTENT.getByName(url.searchParams.get("name") ?? "")
      switch (url.searchParams.get("op")) {
        case "start":
          return Response.json(await content.start(url.searchParams.get("operation") ?? "op-1"))
        case "carrier":
          return Response.json(await content.carrier(url.searchParams.get("session") ?? ""))
        default:
          return Response.json(await content.observe())
      }
    }
    const stub = env.ORG.getByName(url.searchParams.get("name") ?? "")
    switch (url.searchParams.get("op")) {
      case "start":
        return Response.json(await stub.start(url.searchParams.get("script") ?? "chaos", url.searchParams.get("operation") ?? "op-1"))
      case "startTwo":
        return Response.json(await stub.startTwo(url.searchParams.get("a") ?? "op-a", url.searchParams.get("b") ?? "op-b"))
      case "evict":
        try {
          await stub.evict()
        } catch {
          // The reset rejects the caller: that is the eviction.
        }
        return Response.json({ evicted: true })
      case "purge":
        await stub.purge()
        return Response.json({ ok: true })
      default:
        return Response.json(await stub.observe())
    }
  },
} satisfies ExportedHandler<Env>

/** The same agent with `contentExport: true`: its spans carry GenAI content. */
export class AgentOrgContent extends Hera.agent<Env>({
  service: "workerd-agent-content",
  agent: "fixture",
  instructions: "You are a terse test agent.",
  tools: () => [
    Hera.agentTool({
      name: "lookup",
      description: "Look up the value stored under a key.",
      input: Lookup,
      execute: ({ key }) => Effect.succeed(`${key}=v`),
    }),
  ],
  egress: () => ({ accountId: "acct_fixture", gateway: "gw-fixture", apiKey: Redacted.make("fixture-key") }),
  telemetry: () => ({
    environment: "workerd-test",
    sink: { baseUrl: "http://otlp.test", token: Redacted.make("fixture-token") },
    contentExport: true,
  }),
}) {
  protected override createEgressUpstream(): HeraAgentUpstream {
    return HeraAgentTest.script(SCRIPTS["plain"] ?? [])
  }

  async start(operationId: string) {
    return this.submit({ operationId, prompt: "Call lookup with key alpha, then reply with the value." })
  }

  async observe() {
    const pi = await this.pi()
    return { pending: (await pi.pending()).map((p) => p.status) }
  }

  carrier(session: string) {
    return this.runTraceCarrier(session) ?? null
  }
}
