import { TenantDurableObject } from "../../../src/server/durable-object/index.js"

interface Env {
  readonly ORG: DurableObjectNamespace<Org>
}

// The shape a consumer's tenant DO takes: a `configure(...)` subclass called over Workers RPC.
export class Org extends TenantDurableObject.configure<Env>({
  service: "workerd-smoke",
  migrations: [{ version: 1, name: "001_create_notes", sql: "CREATE TABLE notes (id TEXT PRIMARY KEY)" }],
}) {
  hello(): { readonly orgId: string; readonly service: string; readonly migrations: ReadonlyArray<string> } {
    return {
      orgId: this.orgId,
      service: this.service,
      migrations: this.getAppliedMigrations().map((migration) => migration.name),
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).searchParams.get("name") ?? ""
    return Response.json(await env.ORG.getByName(name).hello())
  },
} satisfies ExportedHandler<Env>
