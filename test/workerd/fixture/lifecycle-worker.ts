import { Lifecycle } from "agents/lifecycle"
import {
  type AlarmDriver,
  type HeraJobRegistry,
  type HeraOutboxRecord,
  TenantDurableObject,
} from "../../../src/server/durable-object/index.js"

interface Env {
  readonly ORG: DurableObjectNamespace<LifecycleOrg>
}

/** The one Lifecycle host job Hera's composite pass runs as. */
const COMPOSITE_JOB = "hera:composite"

/** An `AlarmDriver` over a Lifecycle host job: Lifecycle owns the platform alarm, Hera owns one job. */
class LifecycleAlarmDriver implements AlarmDriver {
  constructor(private readonly host: { readonly lifecycle: Lifecycle }) {}

  readonly set = async (atMs: number): Promise<void> => {
    await this.host.lifecycle.jobs.push({ id: COMPOSITE_JOB, fn: COMPOSITE_JOB, time: atMs })
  }

  readonly get = async (): Promise<number | null> =>
    this.host.lifecycle.jobs.get(COMPOSITE_JOB)?.time ?? null

  readonly clear = async (): Promise<void> => {
    await this.host.lifecycle.jobs.cancel(COMPOSITE_JOB)
  }
}

const seen = (self: LifecycleOrg, kind: string): void => {
  self.ctx.storage.sql.exec("INSERT INTO seen (kind, at) VALUES (?, ?)", kind, Date.now())
}

/**
 * The shape the `AgentsTenant` takes: a Hera tenant DO whose platform alarm a `Lifecycle`
 * owns. Hera's `alarm()` is on the prototype, so `Lifecycle.install` leaves it in place, and the host
 * overrides it to delegate.
 */
export class LifecycleOrg extends TenantDurableObject.configure<Env>({
  service: "workerd-lifecycle",
  alarmErrorBackoffMs: 200,
  migrations: [{ version: 1, name: "001_seen", sql: "CREATE TABLE seen (kind TEXT NOT NULL, at INTEGER NOT NULL)" }],
}) {
  static readonly jobs = {
    work: (_nowMs: number, self: LifecycleOrg) => {
      seen(self, "job")
      return null
    },
    purgeMidPass: async (nowMs: number, self: LifecycleOrg) => {
      await self.ctx.storage.deleteAll()
      return nowMs + 60_000
    },
  } satisfies HeraJobRegistry<LifecycleOrg>

  readonly lifecycle = Lifecycle.install(this)

  protected override createAlarmDriver(): AlarmDriver {
    return new LifecycleAlarmDriver(this)
  }

  override async alarm(): Promise<void> {
    await this.lifecycle.alarm()
  }

  async onJob({ job }: { readonly job: { readonly fn: string } }): Promise<{ rescheduleAt: number } | undefined> {
    if (job.fn !== COMPOSITE_JOB) {
      return undefined
    }
    const nextAt = await this.runCompositePass()
    return nextAt === null ? undefined : { rescheduleAt: nextAt }
  }

  protected override deliverOutboxBatch(records: ReadonlyArray<HeraOutboxRecord>): void {
    for (const record of records) {
      seen(this, `delivered:${record.id}`)
    }
  }

  protected override onDomainAlarm(): void {
    const failedOnce = this.ctx.storage.sql.exec("SELECT 1 FROM seen WHERE kind = 'hook-failed'").toArray().length > 0
    if (!failedOnce) {
      seen(this, "hook-failed")
      throw new Error("the first domain alarm fails")
    }
    seen(this, "hook")
  }

  protected override async beforePurge(): Promise<void> {
    await this.lifecycle.dispose()
    await this.lifecycle.disableAlarms()
  }

  async seed(): Promise<void> {
    const now = Date.now()
    await this.runWithTenantCtx(
      this.db.transactWithOutbox(function* (tx) {
        yield* tx.enqueueOutbox({ id: "evt_1", type: "item.created@1", payload: { n: 1 } })
      })
    )
    await this.runWithTenantCtx(this.jobs.schedule("work", now + 100))
    await this.runWithTenantCtx(this.scheduleDomainAlarm(now + 100))
  }

  async seedPurgeMidPass(): Promise<void> {
    await this.runWithTenantCtx(this.jobs.schedule("purgeMidPass", Date.now() + 100))
  }

  async observe(): Promise<{
    readonly initialized: boolean
    readonly seen: ReadonlyArray<string>
    readonly hookRetryGapMs: number | null
    readonly pending: number
    readonly heraTables: ReadonlyArray<string>
    readonly compositeJobAt: number | null
    readonly platformAlarm: number | null
  }> {
    const tables = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .toArray()
      .map((row) => String(row.name))
    const ownTables = tables.filter((name) => name === "seen" || name.startsWith("_hera"))
    return {
      initialized: this.isInitialized(),
      seen: tables.includes("seen")
        ? this.ctx.storage.sql.exec("SELECT kind FROM seen ORDER BY rowid").toArray().map((row) => String(row.kind))
        : [],
      hookRetryGapMs: tables.includes("seen")
        ? Number(
            this.ctx.storage.sql
              .exec("SELECT MAX(CASE WHEN kind = 'hook' THEN at END) - MAX(CASE WHEN kind = 'hook-failed' THEN at END) AS gap FROM seen")
              .one().gap ?? Number.NaN
          )
        : null,
      pending: this.getPendingOutboxRecords().length,
      heraTables: ownTables,
      compositeJobAt: tables.includes("cf_agents_jobs") ? (this.lifecycle.jobs.get(COMPOSITE_JOB)?.time ?? null) : null,
      platformAlarm: await this.ctx.storage.getAlarm(),
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const stub = env.ORG.getByName(url.searchParams.get("name") ?? "")
    switch (url.searchParams.get("op")) {
      case "seed":
        await stub.seed()
        return Response.json({ ok: true })
      case "seedPurgeMidPass":
        await stub.seedPurgeMidPass()
        return Response.json({ ok: true })
      case "purge":
        await stub.purgeStorage()
        return Response.json({ ok: true })
      default:
        return Response.json(await stub.observe())
    }
  },
} satisfies ExportedHandler<Env>
