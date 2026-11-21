import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import {
  HeraCtx,
  type HeraCtxShape,
  HeraTenantCtx,
  type HeraTenantCtxService,
} from "../context/index.js"

export function extractSpanAttributesFromContext(
  tenantOpt: Option.Option<HeraTenantCtxService>,
  ctxOpt: Option.Option<HeraCtxShape>
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {}
  if (Option.isSome(tenantOpt)) {
    const tenant = tenantOpt.value
    attrs.requestId = tenant.requestId
    attrs.request_id = tenant.requestId
    attrs.orgId = tenant.orgId
    attrs.org_id = tenant.orgId
    attrs.service = tenant.service
    if (Option.isSome(tenant.actorId)) {
      attrs.actorId = tenant.actorId.value
      attrs.actor_id = tenant.actorId.value
    }
    if (tenant.actorKind !== undefined) {
      attrs.actorKind = tenant.actorKind
      attrs.actor_kind = tenant.actorKind
    }
  } else if (Option.isSome(ctxOpt)) {
    const ctx = ctxOpt.value
    attrs.requestId = ctx.requestId
    attrs.request_id = ctx.requestId
    attrs.service = ctx.service
    if (Option.isSome(ctx.orgId)) {
      attrs.orgId = ctx.orgId.value
      attrs.org_id = ctx.orgId.value
    }
    if (Option.isSome(ctx.actorId)) {
      attrs.actorId = ctx.actorId.value
      attrs.actor_id = ctx.actorId.value
    }
  }
  return attrs
}

/**
 * Enriches the active tracing span with `requestId`, `orgId`, `actorId`, and `service`
 * attributes from `HeraTenantCtx` or `HeraCtx` whenever present in the fiber's `Context`,
 * without adding `HeraCtx` or `HeraTenantCtx` to the effect's `R` requirement channel.
 */
export function enrichSpanFromHeraCtx<A, E, R>(
  self: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return Effect.flatMap(
    Effect.all([
      Effect.serviceOption(HeraTenantCtx),
      Effect.serviceOption(HeraCtx),
    ]),
    ([tenantOpt, ctxOpt]) => {
      const attrs = extractSpanAttributesFromContext(tenantOpt, ctxOpt)
      if (Object.keys(attrs).length === 0) {
        return self
      }
      return Effect.andThen(Effect.annotateCurrentSpan(attrs), self)
    }
  )
}
