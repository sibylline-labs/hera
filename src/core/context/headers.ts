import { mintRequestId } from "./request-id.js"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { createHeraLogger, type HeraLogger } from "../logger/index.js"
import type { ActorId, OrgId } from "../schema/index.js"
import {
  type ActorKind,
  type HeraAuthedCtxInput,
  type HeraAuthedCtxShape,
  type HeraCtxShape,
  type HeraPublicCtxInput,
  type HeraPublicCtxShape,
  type HeraTenantCtxInput,
  type HeraTenantCtxService,
  type HeraTenantDb,
  type HeraTenantResolvedDb,
  type Scope,
} from "./types.js"

export function resolveActorIdOption(
  actorId: Option.Option<ActorId> | ActorId | null | undefined
): Option.Option<ActorId> {
  if (actorId === undefined || actorId === null) {
    return Option.none()
  }
  if (Option.isOption(actorId)) {
    return actorId
  }
  return Option.some(actorId)
}

export function resolveTenantDb(
  rawDb: HeraTenantDb | undefined,
  orgId: OrgId
): HeraTenantResolvedDb {
  if (
    rawDb !== undefined &&
    typeof rawDb.exec === "function" &&
    typeof rawDb.query === "function"
  ) {
    return rawDb as HeraTenantResolvedDb
  }
  return {
    ...rawDb,
    orgId: rawDb?.orgId ?? orgId,
    exec: rawDb?.exec ?? (() => ({ rows: [], rowsRead: 0, rowsWritten: 0 })),
    query: rawDb?.query ?? (() => Effect.succeed([])),
  }
}

export function resolvePublicCtxShapes(input: HeraPublicCtxInput): {
  readonly logger: HeraLogger
  readonly publicShape: HeraPublicCtxShape
  readonly legacyShape: HeraCtxShape
} {
  const logger =
    input.logger !== undefined
      ? input.logger.child({
          request_id: input.requestId,
        })
      : createHeraLogger({
          service: input.service,
          requestId: input.requestId,
          sink: input.sink,
          whitelistedErrorCodes: input.whitelistedErrorCodes,
        })
  const now = input.now ?? Clock.currentTimeMillis
  const publicShape: HeraPublicCtxShape = {
    requestId: input.requestId,
    service: input.service,
    logger,
    now,
  }
  const legacyShape: HeraCtxShape = {
    requestId: input.requestId,
    actorId: Option.none(),
    orgId: Option.none(),
    service: input.service,
    logger,
    now,
  }
  return { logger, publicShape, legacyShape }
}

export function resolveAuthedCtxShapes(input: HeraAuthedCtxInput): {
  readonly logger: HeraLogger
  readonly authedShape: HeraAuthedCtxShape
  readonly publicShape: HeraPublicCtxShape
  readonly legacyShape: HeraCtxShape
} {
  const logger =
    input.logger !== undefined
      ? input.logger.child({
          request_id: input.requestId,
          org_id: input.orgId,
          actor_id: input.actorId,
        })
      : createHeraLogger({
          service: input.service,
          requestId: input.requestId,
          orgId: input.orgId,
          actorId: input.actorId,
          sink: input.sink,
          whitelistedErrorCodes: input.whitelistedErrorCodes,
        })
  const now = input.now ?? Clock.currentTimeMillis
  const scopes: ReadonlySet<Scope> =
    input.scopes instanceof Set
      ? input.scopes
      : new Set<Scope>(input.scopes ?? [])
  const actorKind: ActorKind = input.actorKind ?? "user"
  const productCtx: Readonly<Record<string, unknown>> = input.productCtx ?? {}

  const authedShape: HeraAuthedCtxShape = {
    requestId: input.requestId,
    service: input.service,
    orgId: input.orgId,
    actorId: input.actorId,
    actorKind,
    scopes,
    productCtx,
    logger,
    now,
  }
  const publicShape: HeraPublicCtxShape = {
    requestId: input.requestId,
    service: input.service,
    logger,
    now,
  }
  const legacyShape: HeraCtxShape = {
    requestId: input.requestId,
    actorId: Option.some(input.actorId),
    orgId: Option.some(input.orgId),
    service: input.service,
    logger,
    now,
  }
  return { logger, authedShape, publicShape, legacyShape }
}

export function resolveLegacyCtxShapes(shape: HeraCtxShape): {
  readonly logger: HeraLogger
  readonly resolvedShape: HeraCtxShape
  readonly publicShape: HeraPublicCtxShape
} {
  const orgId = Option.getOrNull(shape.orgId)
  const actorId = Option.getOrNull(shape.actorId)
  const logger =
    shape.logger ??
    createHeraLogger({
      service: shape.service,
      requestId: shape.requestId,
      orgId,
      actorId,
    })
  const now = shape.now ?? Clock.currentTimeMillis
  const resolvedShape: HeraCtxShape = {
    ...shape,
    logger,
    now,
  }
  const publicShape: HeraPublicCtxShape = {
    requestId: shape.requestId,
    service: shape.service,
    logger,
    now,
  }
  return { logger, resolvedShape, publicShape }
}

export function resolveTenantCtxShapes(input: HeraTenantCtxInput): {
  readonly logger: HeraLogger
  readonly tenantService: HeraTenantCtxService
  readonly publicShape: HeraPublicCtxShape
  readonly legacyShape: HeraCtxShape
} {
  const service = input.service ?? "hera-tenant"
  const requestId = input.requestId ?? mintRequestId()
  const actorId = resolveActorIdOption(input.actorId)
  const actorIdStr = Option.getOrNull(actorId)

  const logger =
    input.logger !== undefined
      ? input.logger.child({
          request_id: requestId,
          org_id: input.orgId,
          ...(actorIdStr !== null ? { actor_id: actorIdStr } : {}),
        })
      : createHeraLogger({
          service,
          requestId,
          orgId: input.orgId,
          actorId: actorIdStr,
          sink: input.sink,
          whitelistedErrorCodes: input.whitelistedErrorCodes,
        })

  const db = resolveTenantDb(input.db, input.orgId)
  const scheduleDomainAlarm: (atMs: number) => Effect.Effect<void> =
    input.scheduleDomainAlarm ?? (() => Effect.void)
  const now = input.now ?? Clock.currentTimeMillis

  const tenantService: HeraTenantCtxService = {
    orgId: input.orgId,
    db,
    logger,
    scheduleDomainAlarm,
    requestId,
    actorId,
    service,
    now,
    ...(input.actorKind !== undefined ? { actorKind: input.actorKind } : {}),
    ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
  }
  const publicShape: HeraPublicCtxShape = {
    requestId,
    service,
    logger,
    now,
  }
  const legacyShape: HeraCtxShape = {
    requestId,
    actorId,
    orgId: Option.some(input.orgId),
    service,
    logger,
    now,
  }
  return { logger, tenantService, publicShape, legacyShape }
}
