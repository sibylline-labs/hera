import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { Hera, type HeraAgentUpstream } from "../../../src/server/agent/index.js"
import { HeraAgentTest } from "../../../src/testing/agent/index.js"

interface Env {
  readonly RUN: DurableObjectNamespace<RunAgent>
  readonly ORG: DurableObjectNamespace<OrgAgent>
}

const Lookup = Schema.Struct({ key: Schema.String })

const ensureTables = (sql: SqlStorage) => {
  sql.exec("CREATE TABLE IF NOT EXISTS side_effects (call_id TEXT PRIMARY KEY, n INTEGER NOT NULL)")
}

/** Every step is slow enough that an eviction lands inside it. */
const SCRIPT = [HeraAgentTest.toolCall("lookup", { key: "alpha" }, { delayMs: 600 }), HeraAgentTest.text("alpha=v", { delayMs: 600 })]

const definition = (service: string) => ({
  service,
  agent: "fixture",
  instructions: "You are a terse test agent.",
  tools: (host: { readonly ctx: DurableObjectState }) => [
    Hera.agentTool({
      name: "lookup",
      description: "Look up the value stored under a key.",
      input: Lookup,
      execute: ({ key }, { callId }) =>
        Effect.promise(async () => {
          const sql = host.ctx.storage.sql
          ensureTables(sql)
          await new Promise((resolve) => setTimeout(resolve, 400))
          sql.exec("INSERT INTO side_effects VALUES (?, 1) ON CONFLICT(call_id) DO UPDATE SET n = n", callId)
          return `${key}=v`
        }),
    }),
  ],
  egress: () => ({ accountId: "acct_fixture", gateway: "gw-fixture", apiKey: Redacted.make("fixture-key") }),
})

/** One object per run: named `org:<OrgId>:run:<runKey>`. */
export class RunAgent extends Hera.agent<Env>({ ...definition("workerd-run-agent"), durableObject: { runKeyed: true } }) {
  readonly incarnation = crypto.randomUUID().slice(0, 8)

  protected override createEgressUpstream(): HeraAgentUpstream {
    return HeraAgentTest.script(SCRIPT)
  }

  start(operationId: string) {
    return this.submit({ operationId, prompt: "Call lookup with key alpha, then reply with the value." })
  }

  async waitFor(operationId: string, session: string) {
    const outcome = await (await this.pi()).wait(operationId, { session: session as never })
    return { status: outcome.status, text: outcome.text ?? null }
  }

  evict(): void {
    this.ctx.abort("forced eviction")
  }

  purge(): Promise<void> {
    return this.purgeStorage()
  }

  async observe() {
    const sql = this.ctx.storage.sql
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray().map((r) => String(r.name))
    const started = tables.some((t) => t.startsWith("pi_"))
    const pi = started ? await this.pi() : undefined
    return {
      orgId: this.orgId,
      runKey: this.runKey ?? null,
      incarnation: this.incarnation,
      tables,
      pending: pi === undefined ? [] : (await pi.pending()).map((p) => p.status),
      sideEffects: tables.includes("side_effects")
        ? sql.exec("SELECT call_id FROM side_effects").toArray().map((r) => String(r.call_id))
        : [],
      meterOperations: started ? this.agentMeter.rows().map((r) => r.operationId ?? null) : [],
      alarm: await this.ctx.storage.getAlarm(),
    }
  }
}

/** The per-org form, unchanged: named by the org alone. */
export class OrgAgent extends Hera.agent<Env>(definition("workerd-org-agent")) {
  async observe() {
    return { orgId: this.orgId, runKey: this.runKey ?? null }
  }
}

/** The tag of the error a constructor threw, or `ok`. */
async function identity(call: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json({ ok: await call() })
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) })
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const name = url.searchParams.get("name") ?? ""
    const param = (k: string) => url.searchParams.get(k) ?? ""
    if (url.searchParams.get("ns") === "org") return identity(() => env.ORG.getByName(name).observe())
    const stub = env.RUN.getByName(name)
    switch (param("op")) {
      case "identity":
        return identity(() => stub.observe())
      case "start":
        return Response.json(await stub.start(param("operation")))
      case "wait":
        return Response.json(await stub.waitFor(param("operation"), param("session")))
      case "cancel":
        return Response.json(await stub.cancel({ operationId: param("operation") }))
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
