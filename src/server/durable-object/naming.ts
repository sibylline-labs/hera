import { mintRequestId } from "../../core/context/request-id.js"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  type HeraActorKind,
  type HeraTenantCtxShape,
} from "../../core/context/index.js"
import type { HeraLogger } from "../../core/logger/index.js"
import {
  type ActorId,
  HeraSchema,
  OrgId,
  RequestId,
} from "../../core/schema/index.js"
import {
  type HeraGetTenantStubOptions,
  type HeraSqlClient,
  type HeraSqlError,
  type OrgDurableObjectName,
  type SyncEffect,
  TenantIdentityError,
} from "./types.js"

const LOCAL_WORKERD_VAR = "HERA_LOCAL_WORKERD"
const LOCAL_WORKERD_ON = "1"
const WORKERD_JURISDICTION_UNIMPLEMENTED =
  "Jurisdiction restrictions are not implemented"

export interface TenantCtxOptions {
  readonly requestId?: RequestId | undefined
  readonly actorId?: ActorId | Option.Option<ActorId> | undefined
  readonly actorKind?: HeraActorKind | undefined
  readonly scopes?: ReadonlyArray<string> | undefined
}

export function orgDoName(orgId: OrgId): OrgDurableObjectName {
  return `org:${orgId}`
}

export function parseOrgDoName(name: string): Option.Option<OrgId> {
  if (!name.startsWith("org:")) {
    return Option.none()
  }
  const raw = name.slice("org:".length)
  return Schema.decodeUnknownOption(OrgId)(raw)
}

/**
 * Resolves a Durable Object `ctx.id.name` into a branded `OrgId`.
 * Supports both raw `<OrgId>` (`idFromName(orgId)`) and `org:<OrgId>` (`idFromName(orgDoName(orgId))`),
 * for either `OrgId` form (`org_<ULID>` or bare `<ULID>`), returned verbatim.
 * Never echoes the raw unvalidated string on failure.
 */
export function resolveTenantDoOrgId(
  rawName: string | undefined | null
): Option.Option<OrgId> {
  if (typeof rawName !== "string" || rawName.length === 0) {
    return Option.none()
  }
  if (rawName.startsWith("org:")) {
    return parseOrgDoName(rawName)
  }
  return Schema.decodeUnknownOption(OrgId)(rawName)
}

export function requireTenantDoOrgId(
  rawName: string | undefined | null
): OrgId {
  const resolvedOrg = resolveTenantDoOrgId(rawName)
  if (Option.isNone(resolvedOrg)) {
    throw new TenantIdentityError({
      reason:
        rawName === undefined
          ? "Durable Object ctx.id.name is missing (anonymous DO instances are not permitted for TenantDurableObject)"
          : "Durable Object ctx.id.name is not a valid OrgId",
    })
  }
  return resolvedOrg.value
}

export function buildTenantDoContextShape(params: {
  readonly orgId: OrgId
  readonly service: string
  readonly db: HeraSqlClient
  readonly logger: HeraLogger
  readonly scheduleDomainAlarm: (atMs: number) => SyncEffect<void, HeraSqlError>
  readonly options?: TenantCtxOptions | undefined
}): HeraTenantCtxShape {
  const requestId =
    params.options?.requestId ??
    mintRequestId()
  const actorId =
    params.options?.actorId === undefined
      ? Option.none<ActorId>()
      : Option.isOption(params.options.actorId)
        ? params.options.actorId
        : Option.some(params.options.actorId)

  return {
    requestId,
    orgId: params.orgId,
    actorId,
    actorKind: params.options?.actorKind ?? "internal",
    scopes: params.options?.scopes ?? [],
    service: params.service,
    db: params.db,
    logger: params.logger,
    scheduleDomainAlarm: (atMs: number) =>
      params.scheduleDomainAlarm(atMs).pipe(Effect.orDie),
  }
}

/**
 * Sole helper for obtaining a tenant Durable Object stub.
 *
 * Requires a branded `OrgId` at compile time (`@ts-expect-error` if passed an unbranded `string`)
 * and validates `orgId` at runtime via `HeraSchema` before calling `namespace.idFromName(...)`.
 */
export function getTenantStub<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
>(
  namespace: DurableObjectNamespace<T>,
  orgId: OrgId,
  options?: HeraGetTenantStubOptions
): DurableObjectStub<T> {
  const decoded = Schema.decodeUnknownOption(OrgId)(orgId)
  if (Option.isNone(decoded)) {
    throw new TenantIdentityError({
      reason: "getTenantStub requires a valid branded OrgId",
    })
  }
  const verifiedOrgId = decoded.value
  const targetNamespace = withJurisdiction(namespace, options)
  const doName = options?.useOrgPrefix
    ? orgDoName(verifiedOrgId)
    : verifiedOrgId
  const id = targetNamespace.idFromName(doName)
  return targetNamespace.get(id)
}

/**
 * `namespace` pinned to `options.jurisdiction`. On local workerd (`HERA_LOCAL_WORKERD=1` in
 * `options.env`), an unimplemented jurisdiction falls back to the unpinned namespace; anywhere else it throws.
 */
export function withJurisdiction<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  options?: Pick<HeraGetTenantStubOptions, "jurisdiction" | "env">
): DurableObjectNamespace<T> {
  if (options?.jurisdiction === undefined) return namespace
  try {
    return namespace.jurisdiction(options.jurisdiction as DurableObjectJurisdiction)
  } catch (error) {
    const isLocalWorkerdFallback =
      error instanceof Error &&
      error.message.includes(WORKERD_JURISDICTION_UNIMPLEMENTED) &&
      options.env !== undefined &&
      Reflect.get(options.env, LOCAL_WORKERD_VAR) === LOCAL_WORKERD_ON
    if (!isLocalWorkerdFallback) throw error
    return namespace
  }
}
