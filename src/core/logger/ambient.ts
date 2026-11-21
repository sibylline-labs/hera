import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import {
  HERA_AUTHED_CTX_KEY,
  HERA_CTX_KEY,
  HERA_PUBLIC_CTX_KEY,
  HERA_TENANT_CTX_KEY,
} from "../context/keys.js"

/**
 * What a line can learn from the fiber it is written in: correlation a layer bound
 * (`CurrentLogCorrelation`), the Hera request context, and the active span's W3C ids. Each slot is
 * `null` when the fiber does not carry it; a slot the logger itself bound wins over all of them.
 */
export interface AmbientCorrelation {
  readonly orgId: string | null
  readonly requestId: string | null
  readonly actorId: string | null
  readonly actorKind: string | null
  readonly traceId: string | null
  readonly spanId: string | null
}

/** The slot values `CurrentLogCorrelation` carried, as split by `extractCorrelationOverrides`. */
export interface BoundCorrelation {
  readonly orgId?: string | null | undefined
  readonly requestId?: string | null | undefined
  readonly actorId?: string | null | undefined
}

type CtxRecord = Readonly<Record<string, unknown>>

function readCtx(context: Context.Context<never>, key: string): CtxRecord | undefined {
  const value: unknown = context.mapUnsafe.get(key)
  return typeof value === "object" && value !== null ? (value as CtxRecord) : undefined
}

/** A string, or the string inside a `Some` (the legacy `HeraCtx` and tenant `actorId` shapes). */
function stringOf(value: unknown): string | null {
  if (typeof value === "string") {
    return value
  }
  if (Option.isOption(value) && Option.isSome(value)) {
    return typeof value.value === "string" ? value.value : null
  }
  return null
}

/** The first non-null reading of `field` across `ctxs`, in order. */
function firstOf(ctxs: ReadonlyArray<CtxRecord | undefined>, field: string): string | null {
  for (const ctx of ctxs) {
    const value = ctx === undefined ? null : stringOf(ctx[field])
    if (value !== null) {
      return value
    }
  }
  return null
}

/**
 * Reads the ambient correlation of one fiber. Precedence per slot: `CurrentLogCorrelation`, then
 * `HeraTenantCtx`, `HeraAuthedCtx`, `HeraCtx`, `HeraPublicCtx`. Contexts are read by key and
 * structurally, so a log call never widens an effect's requirements.
 */
export function readAmbientCorrelation(
  context: Context.Context<never>,
  bound: BoundCorrelation
): AmbientCorrelation {
  const tenant = readCtx(context, HERA_TENANT_CTX_KEY)
  const authed = readCtx(context, HERA_AUTHED_CTX_KEY)
  const ctxs = [tenant, authed, readCtx(context, HERA_CTX_KEY), readCtx(context, HERA_PUBLIC_CTX_KEY)]
  const span = Context.getOption(context, Tracer.ParentSpan)
  return {
    orgId: bound.orgId ?? firstOf(ctxs, "orgId"),
    requestId: bound.requestId ?? firstOf(ctxs, "requestId"),
    actorId: bound.actorId ?? firstOf(ctxs, "actorId"),
    actorKind: firstOf([tenant, authed], "actorKind"),
    traceId: Option.isSome(span) ? span.value.traceId : null,
    spanId: Option.isSome(span) ? span.value.spanId : null,
  }
}
