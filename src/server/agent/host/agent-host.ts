import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { PiHarness } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import type { TelemetryCarrier } from "@earendil-works/pi-telemetry"
import type { AlarmDriver } from "../../durable-object/alarm-driver.js"
import { TenantDurableObject } from "../../durable-object/tenant-do.js"
import type { HeraTenantDurableObjectOptions } from "../../durable-object/types.js"
import type { HeraAgentEgressConfig } from "../egress/config.js"
import { HeraAgentEgress, type HeraAgentUpstream } from "../egress/egress.js"
import { HeraAgentMeter } from "../egress/meter.js"
import { HERA_AGENT_PROVIDER, type HeraAgentModel, HeraAgentModels } from "../models/catalog.js"
import { HeraAgentTelemetry, type HeraAgentTelemetryOptions } from "../telemetry/index.js"
import type { HeraAgentTool } from "../tool/agent-tool.js"
import { toRegistration } from "../tool/registration.js"
import { HERA_COMPOSITE_JOB, LifecycleAlarmDriver } from "./lifecycle-driver.js"
import { makeOperationResolver } from "./operation-resolver.js"

/**
 * `PiHarness` whose job dispatch ends in a telemetry flush. Pi's work runs in memory between alarm
 * dispatches, so spans end after `alarm()` returns; flushing when the harness job settles exports
 * them before an eviction can drop the buffer.
 */
class FlushingPiHarness extends PiHarness {
  constructor(
    options: ConstructorParameters<typeof PiHarness>[0],
    private readonly afterJob: () => void
  ) {
    super(options)
  }

  override async onJob(context: Parameters<PiHarness["onJob"]>[0]): ReturnType<PiHarness["onJob"]> {
    try {
      return await super.onJob(context)
    } finally {
      this.afterJob()
    }
  }
}

/** What the host's telemetry needs from the consumer; Hera fills in service, tenant and `waitUntil`. */
export type HeraAgentTelemetryConfig = Omit<HeraAgentTelemetryOptions, "service" | "tenant" | "waitUntil">

export interface HeraAgentDef<Env> {
  /** The Worker service name (logs, gateway metadata, span resource). */
  readonly service: string
  /** The agent's name: its registry extension and `gen_ai.agent.name`. */
  readonly agent: string
  /** The system instructions every request starts with. */
  readonly instructions: string
  /** The tools, built once per open. Only `Hera.agentTool` builds a `HeraAgentTool`. */
  readonly tools: (host: HeraAgentHost<Env>) => ReadonlyArray<HeraAgentTool>
  /** Default `HeraAgentModels.default` (Gemma, thinking off). */
  readonly model?: HeraAgentModel | undefined
  /** Default `HeraAgentModels.fallback` (Argon at `low`); `null` runs with no fallback. */
  readonly fallback?: HeraAgentModel | null | undefined
  /** The model egress, read from the consumer's own env (the Gemini key is its Worker secret). */
  readonly egress: (env: Env) => HeraAgentEgressConfig
  /** GenAI span export; omitted, Pi runs with no telemetry. */
  readonly telemetry?: ((env: Env) => HeraAgentTelemetryConfig | undefined) | undefined
  readonly durableObject?: Omit<HeraTenantDurableObjectOptions, "service"> | undefined
}

/** A durable submission: its id is the idempotency key, so a resubmit answers `accepted: false`. */
export interface HeraAgentReceipt {
  readonly operationId: string
  readonly session: string
  readonly accepted: boolean
}

export interface HeraAgentSubmit {
  readonly operationId: string
  readonly prompt: string
  readonly session?: string | undefined
}

/** The doors and seams every `Hera.agent` class has. */
export interface HeraAgentHost<Env> extends TenantDurableObject<Env> {
  submit(input: HeraAgentSubmit): Promise<HeraAgentReceipt>
  cancel(input: { readonly operationId: string; readonly session?: string | undefined }): Promise<{ readonly cancelled: boolean }>
  dispose(): Promise<void>
}

/**
 * Hosts Pi Durable on a `TenantDurableObject`. Pi's `Lifecycle` is installed lazily on
 * first use (`Lifecycle.install(this).use(harness)`; the constructor writes nothing) and owns the platform alarm; Hera's composite pass runs as its one host job
 * through a `LifecycleAlarmDriver`. `purgeStorage()` runs `dispose` in `beforePurge`, so the order
 * is driver clear → dispose → `deleteAll` → `abort`.
 */
export function agent<Env = Record<string, unknown>>(def: HeraAgentDef<Env>) {
  const model = def.model ?? HeraAgentModels.default
  const fallback = def.fallback === null ? undefined : (def.fallback ?? HeraAgentModels.fallback)

  abstract class HeraAgentObject
    extends TenantDurableObject.configure<Env>({ ...def.durableObject, service: def.service })
    implements HeraAgentHost<Env>
  {
    #lifecycle: Lifecycle | undefined
    #harness: PiHarness | undefined
    #meter: HeraAgentMeter | undefined
    #telemetry: HeraAgentTelemetry | null | undefined

    /** The model upstream; a test subclass answers `HeraAgentTest.script([...])`. */
    protected createEgressUpstream(): HeraAgentUpstream | undefined {
      return undefined
    }

    /** One usage row per model request, in this object's SQLite (`_hera_agent_meter`). */
    get agentMeter(): HeraAgentMeter {
      return (this.#meter ??= HeraAgentMeter.sqlite(this.ctx.storage.sql))
    }

    protected get agentTelemetry(): HeraAgentTelemetry | undefined {
      if (this.#telemetry === undefined) {
        const config = def.telemetry?.(this.env)
        this.#telemetry =
          config === undefined
            ? null
            : HeraAgentTelemetry.make({ ...config, service: def.service, tenant: this.orgId, waitUntil: (p) => this.ctx.waitUntil(p) })
      }
      return this.#telemetry ?? undefined
    }

    #buildHarness(): PiHarness {
      return new FlushingPiHarness({
        harness: ({ storage, context, onWake }) => {
          const operations = makeOperationResolver(storage, context)
          const registry = createRegistry()
          registry.install({
            name: def.agent,
            sections: [{ key: "preamble", render: () => def.instructions, tag: false }],
            tools: def.tools(this).map((tool) => toRegistration(tool, operations)),
          })
          const models = HeraAgentEgress.make({
            config: def.egress(this.env),
            metadata: { tenant: this.orgId, agent: def.agent, service: def.service },
            model,
            fallback,
            meter: this.agentMeter,
            operationFor: async (sessionId) => (await operations.forProviderSession(sessionId))?.operationId,
            upstream: this.createEgressUpstream(),
          })
          const telemetry = this.agentTelemetry?.context
          return Harness.open(
            storage,
            { models, registry, onWake, identity: { attribution: null }, ...(telemetry === undefined ? {} : { telemetry }) },
            context
          )
        },
        defaults: {
          model: { provider: HERA_AGENT_PROVIDER, id: model.id },
          ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
        },
      }, () => this.#flush())
    }

    /** Installs Lifecycle with the harness on first use; the two are only ever built together. */
    protected get lifecycle(): Lifecycle {
      if (this.#lifecycle === undefined) {
        const harness = this.#buildHarness()
        this.#lifecycle = Lifecycle.install(this as never).use(harness)
        this.#harness = harness
      }
      return this.#lifecycle
    }

    /** The started Pi harness, for reads the doors do not cover (`pending`, `messages`). */
    protected async pi(): Promise<PiHarness> {
      const lifecycle = this.lifecycle
      await lifecycle.start()
      return this.#harness as PiHarness
    }

    protected override createAlarmDriver(): AlarmDriver {
      return new LifecycleAlarmDriver(() => this.lifecycle)
    }

    override async alarm(): Promise<void> {
      try {
        await this.lifecycle.alarm()
      } finally {
        this.#flush()
      }
    }

    /** Lifecycle's host-job dispatch: Hera's composite pass; Pi's own job goes to its capability. */
    async onJob({ job }: { readonly job: { readonly fn: string } }): Promise<{ rescheduleAt: number } | undefined> {
      if (job.fn !== HERA_COMPOSITE_JOB) return undefined
      const nextAt = await this.runCompositePass()
      return nextAt === null ? undefined : { rescheduleAt: nextAt }
    }

    async submit(input: HeraAgentSubmit): Promise<HeraAgentReceipt> {
      const harness = await this.pi()
      try {
        const receipt = await harness.submit(input.prompt, {
          operationId: input.operationId,
          ...(input.session === undefined ? {} : { session: input.session }),
        })
        // Export the run's spans once it settles, even when it settles inside this invocation.
        this.ctx.waitUntil(harness.wait(receipt.operationId, { session: receipt.session }).then(() => this.#flush(), () => this.#flush()))
        return { operationId: receipt.operationId, session: receipt.session, accepted: receipt.accepted }
      } finally {
        this.#flush()
      }
    }

    async cancel(input: { readonly operationId: string; readonly session?: string | undefined }): Promise<{ readonly cancelled: boolean }> {
      const harness = await this.pi()
      const cancelled = await harness.abort({
        operationId: input.operationId,
        ...(input.session === undefined ? {} : { session: input.session }),
      })
      return { cancelled }
    }

    /** Closes Pi's in-memory resources and the meter. Durable state is untouched. */
    async dispose(): Promise<void> {
      this.agentMeter.close()
      if (this.#harness !== undefined) await this.#harness.dispose()
      await this.agentTelemetry?.flush()
    }

    protected override async beforePurge(): Promise<void> {
      await this.dispose()
      await this.lifecycle.disableAlarms()
    }

    /**
     * The trace carrier of the newest Pi task in conversation `session`, so a run-level span (the
     * consumer's `invoke_agent`) joins the trace its tasks ran in. Every task of a run shares that
     * trace; `undefined` before Pi has written a task, or for a record with no carrier.
     */
    protected runTraceCarrier(session: string): TelemetryCarrier | undefined {
      try {
        const sql = this.ctx.storage.sql
        if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_tasks'").toArray().length === 0) return undefined
        const raw = sql
          .exec("SELECT record FROM pi_tasks WHERE CAST(json_extract(record, '$.conversationId') AS TEXT) = ? ORDER BY id DESC LIMIT 1", session)
          .toArray()[0]?.record
        if (typeof raw !== "string") return undefined
        const trace = (JSON.parse(raw) as { readonly trace?: unknown }).trace
        return typeof trace === "object" && trace !== null && typeof (trace as TelemetryCarrier)["traceparent"] === "string"
          ? (trace as TelemetryCarrier)
          : undefined
      } catch {
        return undefined
      }
    }

    #flush(): void {
      const telemetry = this.agentTelemetry
      if (telemetry !== undefined) this.ctx.waitUntil(telemetry.flush())
    }
  }
  return HeraAgentObject
}
