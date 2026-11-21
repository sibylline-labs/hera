import * as Effect from "effect/Effect"
import * as Tracer from "effect/Tracer"
import { readAmbientCorrelation } from "../../core/logger/ambient.js"
import { extractCorrelationOverrides } from "../../core/logger/serializer.js"
import { ambientTraceparent } from "../../core/telemetry/traceparent.js"
import { CurrentLogCorrelation } from "../../core/logger/types.js"
import { ActorId, OrgId, RequestId } from "../../core/schema/index.js"
import { CurrentRpcBaggage, normalizeBaggage, parseTraceparent } from "./trace-context.js"
import type { HeraRpcInvokeMeta } from "./types.js"

/** The marker key that tells `Hera.rpcMethod` a trailing argument is invoke meta, not input. */
export const HERA_RPC_META_MARK = "__heraRpcMeta"

/**
 * What `Hera.rpcClient` appends to a call: correlation scalars only, so it is always
 * structured-clone-safe and never carries a tenant shape, a callback or a credential.
 */
export interface HeraRpcAutoMeta {
  readonly __heraRpcMeta: true
  readonly requestId?: string
  readonly orgId?: string
  readonly actorId?: string
  readonly traceparent?: string
  readonly baggage?: string
}

/** True for an object that carries `__heraRpcMeta: true`. */
export function isHeraRpcInvokeMeta(value: unknown): value is HeraRpcInvokeMeta & { readonly __heraRpcMeta: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)[HERA_RPC_META_MARK] === true
  )
}

/** Splits a marked trailing meta off a call's arguments; `meta` is `undefined` when there is none. */
export function extractTrailingRpcMeta(args: ReadonlyArray<unknown>): {
  readonly args: ReadonlyArray<unknown>
  readonly meta: (HeraRpcInvokeMeta & { readonly __heraRpcMeta: true }) | undefined
} {
  const last = args[args.length - 1]
  return isHeraRpcInvokeMeta(last)
    ? { args: args.slice(0, -1), meta: last }
    : { args, meta: undefined }
}

const strOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

/**
 * The meta the calling fiber implies: its correlation (`CurrentLogCorrelation` slots, then the
 * Hera ctxs), its active span as `traceparent`, and the inbound `baggage` it serves.
 */
export const buildAmbientRpcMeta: Effect.Effect<HeraRpcAutoMeta> = Effect.withFiber((fiber) => {
  const { rest: _rest, span: _span, ...bound } = extractCorrelationOverrides(
    fiber.getRef(CurrentLogCorrelation)
  )
  const ambient = readAmbientCorrelation(fiber.context, bound)
  const traceparent = ambientTraceparent(fiber)
  const baggage = normalizeBaggage(fiber.getRef(CurrentRpcBaggage))
  const meta: HeraRpcAutoMeta = {
    __heraRpcMeta: true,
    ...(ambient.requestId !== null ? { requestId: ambient.requestId } : {}),
    ...(ambient.orgId !== null ? { orgId: ambient.orgId } : {}),
    ...(ambient.actorId !== null ? { actorId: ambient.actorId } : {}),
    ...(traceparent !== undefined ? { traceparent } : {}),
    ...(baggage !== undefined ? { baggage } : {}),
  }
  return Effect.succeed(meta)
})

/** The only keys a marked meta carries over the wire. */
const WIRE_KEYS = ["requestId", "orgId", "actorId", "traceparent", "baggage"] as const

/**
 * The marked meta a call sends: the correlation keys `explicit` sets, the rest from `auto`.
 * Nothing else crosses (no `onDefect`, `tenant` or `heraCtx`), whatever a forwarder passes.
 */
export function mergeInvokeMeta(
  explicit: HeraRpcInvokeMeta | undefined,
  auto: HeraRpcInvokeMeta
): HeraRpcAutoMeta {
  const out: Record<string, string> = {}
  for (const key of WIRE_KEYS) {
    const value = strOf(explicit?.[key]) ?? strOf(auto[key])
    if (value !== undefined) {
      out[key] = value
    }
  }
  return { ...out, __heraRpcMeta: true }
}

/**
 * The caller hints a trailing meta carries: correlation for log lines, never tenant identity. A
 * hint that is not a well-formed id is dropped, so a caller cannot write free text into a line.
 */
export function callerHints(auto: HeraRpcInvokeMeta | undefined): {
  readonly requestId?: string
  readonly orgId?: string
  readonly actorId?: string
} {
  const requestId = RequestId.is(auto?.requestId) ? auto.requestId : undefined
  const orgId = OrgId.is(auto?.orgId) ? auto.orgId : undefined
  const actorId = ActorId.is(auto?.actorId) ? auto.actorId : undefined
  return {
    ...(requestId !== undefined ? { requestId } : {}),
    ...(orgId !== undefined ? { orgId } : {}),
    ...(actorId !== undefined ? { actorId } : {}),
  }
}

/** What a marked trailing meta adds to a call: trace context and caller hints, never a tenant. */
export interface RpcInboundTrace {
  readonly parent: Tracer.ExternalSpan | undefined
  readonly traceparent: string | undefined
  readonly baggage: string | undefined
  readonly hints: ReturnType<typeof callerHints>
}

export function readInboundTrace(
  explicit: HeraRpcInvokeMeta | undefined,
  trailing: HeraRpcInvokeMeta | undefined
): RpcInboundTrace {
  const raw = explicit?.traceparent ?? trailing?.traceparent
  const parent = parseTraceparent(raw)
  return {
    parent,
    traceparent: parent !== undefined ? (raw as string) : undefined,
    baggage: normalizeBaggage(explicit?.baggage ?? trailing?.baggage),
    hints: callerHints(trailing),
  }
}

/** Binds a caller's `orgId` / `actorId` hints as log correlation for `effect`. */
export const bindCallerHints =
  (inbound: RpcInboundTrace) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const { orgId, actorId } = inbound.hints
    if (orgId === undefined && actorId === undefined) {
      return effect
    }
    return Effect.updateService(effect, CurrentLogCorrelation, (current) => ({
      ...current,
      ...(orgId !== undefined ? { org_id: orgId } : {}),
      ...(actorId !== undefined ? { actor_id: actorId } : {}),
    }))
  }
