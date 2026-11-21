import * as Effect from "effect/Effect"
import {
  type HeraCtx,
  type HeraPublicCtx,
  HeraTenantCtx,
  type HeraTenantCtxShape,
} from "../../core/context/index.js"
import type { HeraLoggerService } from "../../core/logger/index.js"
import type { OrgId } from "../../core/schema/index.js"
import { HeraDurableObjectBase } from "./base-do.js"
import {
  buildTenantDoContextShape,
  getTenantStub,
  orgDoName,
  parseOrgDoName,
  requireTenantDoOrgId,
  type TenantCtxOptions,
} from "./naming.js"
import { getTenantRunStub, orgRunDoName, parseOrgRunDoName, requireTenantRunDoName } from "./run-naming.js"
import type { HeraSqlClient, HeraTenantDurableObjectOptions } from "./types.js"

export type { TenantCtxOptions }

/**
 * Base class for tenant-scoped Durable Objects: the
 * shared Hera DO spine (`HeraDurableObjectBase`) keyed by an `OrgId`, with tenant context.
 *
 * Extends `DurableObject` from `cloudflare:workers` (through the base) because workerd exposes
 * Workers RPC only on a class declared that way. Outside workerd, `cloudflare:workers`
 * resolves to `@sibylline-labs/hera/testing/cloudflare-workers`.
 */
export abstract class TenantDurableObject<
  Env = Record<string, unknown>,
> extends HeraDurableObjectBase<Env, OrgId> {
  declare readonly db: HeraSqlClient
  readonly orgId: OrgId
  /** The run this object serves, decoded from `org:<OrgId>:run:<runKey>`; `undefined` on a per-org object. */
  readonly runKey: string | undefined

  static readonly orgDoName = orgDoName
  static readonly parseOrgDoName = parseOrgDoName
  static readonly getTenantStub = getTenantStub
  static readonly orgRunDoName = orgRunDoName
  static readonly parseOrgRunDoName = parseOrgRunDoName
  static readonly getTenantRunStub = getTenantRunStub

  constructor(ctx: DurableObjectState, env: Env, options?: HeraTenantDurableObjectOptions) {
    // Decoded from the object's own name only, before anything is built; a bad name writes nothing.
    const run = options?.runKeyed === true ? requireTenantRunDoName(ctx?.id?.name) : undefined
    super(ctx, env, options, (rawName) => {
      if (run !== undefined) {
        return { key: run.orgId, orgId: run.orgId, logFields: { orgId: run.orgId, doId: String(ctx.id) } }
      }
      const orgId = requireTenantDoOrgId(rawName)
      return { key: orgId, orgId, logFields: { orgId } }
    })
    this.orgId = this.key
    this.runKey = run?.runKey
  }

  static configure<Env = Record<string, unknown>>(defaultOptions: HeraTenantDurableObjectOptions) {
    abstract class ConfiguredTenantDurableObject extends TenantDurableObject<Env> {
      constructor(ctx: DurableObjectState, env: Env, overrides?: HeraTenantDurableObjectOptions) {
        super(ctx, env, {
          ...defaultOptions,
          ...overrides,
          migrations: overrides?.migrations ?? defaultOptions.migrations,
        })
      }
    }
    return ConfiguredTenantDurableObject
  }

  protected override runAlarmProgram(program: Effect.Effect<void, never, never>): Promise<void> {
    return this.runWithTenantCtx(program)
  }

  makeTenantCtx(options?: TenantCtxOptions): HeraTenantCtxShape {
    return buildTenantDoContextShape({
      orgId: this.orgId,
      service: this.service,
      db: this.db,
      logger: this.logger,
      scheduleDomainAlarm: (atMs) => this.scheduleDomainAlarm(atMs),
      options,
    })
  }

  runWithTenantCtx<A, E>(
    effect: Effect.Effect<A, E, HeraTenantCtx | HeraPublicCtx | HeraCtx | HeraLoggerService>,
    options?: TenantCtxOptions
  ): Promise<A> {
    const tenantCtx = this.makeTenantCtx(options)
    const previousRequestId = this.activeRequestId
    this.activeRequestId = tenantCtx.requestId
    const provided = effect.pipe(
      Effect.provide(HeraTenantCtx.layer({ ...tenantCtx, now: Effect.sync(() => this.now()) }))
    )
    // hera-allow: raw-effect-run
    return Effect.runPromise(provided).finally(() => {
      this.activeRequestId = previousRequestId
    })
  }
}
