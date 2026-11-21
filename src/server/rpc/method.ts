import { mintRequestId } from "../../core/context/request-id.js"
import * as Effect from "effect/Effect"
import { beginHooked, exitIsDefect } from "../../core/telemetry/hook.js"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Schema from "effect/Schema"
import {
  HeraCtx,
  type HeraCtxShape,
  HeraTenantCtx,
  type HeraTenantCtxShape,
} from "../../core/context/index.js"
import {
  type AnyHeraDefinedError,
  HeraError,
} from "../../core/errors/index.js"
import {
  HeraSchema,
  type HeraSchemaError,
  OrgId,
  RequestId,
} from "../../core/schema/index.js"
import {
  bindCallerHints,
  extractTrailingRpcMeta,
  readInboundTrace,
  type RpcInboundTrace,
} from "./invoke-meta.js"
import { CurrentRpcBaggage } from "./trace-context.js"
import {
  exitToRpcResult,
  normalizeServiceSlug,
  serviceUnavailableCode,
} from "./envelope.js"
import type {
  HeraRpcHandlerContext,
  HeraRpcInvokeMeta,
  HeraRpcMethod,
  HeraRpcMethodSpec,
  HeraRpcResult,
  RpcInputDecoded,
} from "./types.js"

function resolveRpcInvocationContexts(
  rawInput: unknown,
  meta: HeraRpcInvokeMeta | undefined,
  serviceSlug: string,
  callerRequestId: string | undefined
): {
  readonly requestId: RequestId
  readonly resolvedOrgId: OrgId | undefined
  readonly heraCtx: HeraCtxShape
  readonly tenantCtx: HeraTenantCtxShape | undefined
} {
  const requestId =
    meta?.requestId !== undefined && RequestId.is(meta.requestId)
      ? meta.requestId
      : meta?.tenant?.requestId ??
        meta?.heraCtx?.requestId ??
        (callerRequestId !== undefined && RequestId.is(callerRequestId)
          ? callerRequestId
          : mintRequestId())

  const candidateOrgFromInput =
    typeof rawInput === "object" &&
    rawInput !== null &&
    "orgId" in rawInput &&
    OrgId.is((rawInput as { readonly orgId?: unknown }).orgId)
      ? (rawInput as { readonly orgId: OrgId }).orgId
      : undefined

  const resolvedOrgId =
    meta?.tenant?.orgId ??
    (meta?.orgId !== undefined && OrgId.is(meta.orgId)
      ? meta.orgId
      : candidateOrgFromInput)

  const heraCtx: HeraCtxShape = {
    requestId,
    actorId: meta?.tenant?.actorId ?? meta?.heraCtx?.actorId ?? Option.none(),
    orgId:
      resolvedOrgId !== undefined
        ? Option.some(resolvedOrgId)
        : (meta?.heraCtx?.orgId ?? Option.none()),
    service: meta?.tenant?.service ?? meta?.heraCtx?.service ?? serviceSlug,
  }

  const tenantCtx: HeraTenantCtxShape | undefined =
    meta?.tenant ??
    (resolvedOrgId !== undefined
      ? {
          requestId,
          actorId: heraCtx.actorId,
          orgId: resolvedOrgId,
          service: heraCtx.service,
        }
      : undefined)

  return { requestId, resolvedOrgId, heraCtx, tenantCtx }
}

function buildRpcMethodProgram<
  InputSchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraCtx,
>(
  spec: HeraRpcMethodSpec<InputSchema, A, E, R>,
  methodName: string,
  spanName: string,
  rawInput: unknown,
  requestId: RequestId,
  heraCtx: HeraCtxShape,
  tenantCtx: HeraTenantCtxShape | undefined,
  inbound: RpcInboundTrace
): Effect.Effect<A, unknown, never> {
  const program = Effect.gen(function* () {
    let decodedInput: unknown = rawInput
    if (spec.input !== undefined) {
      const decodeFn = HeraSchema.decodeUnknownEffect(
        spec.input as unknown as Schema.Codec<
          RpcInputDecoded<InputSchema>,
          unknown,
          never,
          never
        >
      )
      decodedInput = yield* Effect.mapError(
        decodeFn(rawInput),
        (schemaErr: HeraSchemaError) =>
          new HeraError({
            code: "invalid_rpc_input",
            httpStatus: 400,
            publicMessage: "Invalid RPC input payload",
            requestId,
            issues: schemaErr.issues,
            cause: schemaErr,
          })
      )
    }

    yield* Effect.annotateCurrentSpan({
      requestId: heraCtx.requestId,
      request_id: heraCtx.requestId,
      service: heraCtx.service,
      rpc_method: methodName,
      ...(Option.isSome(heraCtx.orgId)
        ? { orgId: heraCtx.orgId.value, org_id: heraCtx.orgId.value }
        : {}),
    })

    const handlerCtx: HeraRpcHandlerContext = {
      method: methodName,
      service: heraCtx.service,
      requestId,
      heraCtx,
      ...(tenantCtx !== undefined ? { tenant: tenantCtx } : {}),
      ...(inbound.traceparent !== undefined ? { traceparent: inbound.traceparent } : {}),
    }

    return yield* spec.handler(
      decodedInput as RpcInputDecoded<InputSchema>,
      handlerCtx
    )
  }).pipe(
    Effect.withSpan(spanName, inbound.parent !== undefined ? { parent: inbound.parent } : undefined),
    // A caller's org/actor reach log lines only, and only when the callee has no tenant of its own
    // (tenancy comes only from explicit meta or input). Applied inside the ctx layer, so they
    // merge over the slots its logger binds.
    tenantCtx === undefined ? bindCallerHints(inbound) : (self) => self,
    Effect.provide(
      tenantCtx !== undefined
        ? HeraTenantCtx.layer(tenantCtx)
        : HeraCtx.layer(heraCtx)
    ),
    Effect.provide(Layer.succeed(CurrentRpcBaggage, inbound.baggage))
  )

  return (
    spec.layer !== undefined ? Effect.provide(program, spec.layer) : program
  ) as Effect.Effect<A, unknown, never>
}

/**
 * Wraps a Cloudflare `WorkerEntrypoint` or `DurableObject` RPC method.
 *
 * - Decodes `input` via `HeraSchema` (returning `{ ok: false, status: 400, code: "invalid_rpc_input", ... }` on mismatch).
 * - Executes the `Effect` handler inside a named tracing span (`rpc.<service>.<method>`).
 * - Marshals `Exit` into a plain Structured-Clone-safe POJO (`{ ok: true, value }` or `{ ok: false, status, code, error, ... }`).
 * - Traps all unexpected defects (`Cause.die`) into a closed `{ ok: false, status: 503, code: "<service>_unavailable" }`
 *   wire POJO without ever reading or echoing `defect.message`.
 */
export function rpcMethod<
  InputSchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraCtx,
>(
  name: string,
  spec: HeraRpcMethodSpec<InputSchema, A, E, R>
): HeraRpcMethod<InputSchema, A>
export function rpcMethod<
  InputSchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraCtx,
>(
  spec: HeraRpcMethodSpec<InputSchema, A, E, R> & { readonly name: string }
): HeraRpcMethod<InputSchema, A>
export function rpcMethod<
  InputSchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraCtx,
>(
  nameOrSpec:
    | string
    | (HeraRpcMethodSpec<InputSchema, A, E, R> & { readonly name: string }),
  maybeSpec?: HeraRpcMethodSpec<InputSchema, A, E, R>
): HeraRpcMethod<InputSchema, A> {
  const spec = typeof nameOrSpec === "string" ? maybeSpec! : nameOrSpec
  const methodName =
    typeof nameOrSpec === "string" ? nameOrSpec : nameOrSpec.name
  const serviceSlug = normalizeServiceSlug(spec.service)
  const spanName = `rpc.${serviceSlug}.${methodName}`
  const unavailableCode = serviceUnavailableCode(serviceSlug)

  const invoke = async (
    ...callArgs: ReadonlyArray<unknown>
  ): Promise<HeraRpcResult<A>> => {
    const { args, meta: trailing } = extractTrailingRpcMeta(callArgs)
    const rawInput = args[0]
    const meta =
      typeof args[1] === "object" && args[1] !== null
        ? (args[1] as HeraRpcInvokeMeta)
        : undefined
    const inbound = readInboundTrace(meta, trailing)
    const { requestId, resolvedOrgId, heraCtx, tenantCtx } =
      resolveRpcInvocationContexts(rawInput, meta, serviceSlug, inbound.hints.requestId)

    const runnable = buildRpcMethodProgram(
      spec,
      methodName,
      spanName,
      rawInput,
      requestId,
      heraCtx,
      tenantCtx,
      inbound
    )

    const invocation = beginHooked(spec.telemetry, { name: spanName, source: "internal", traceparent: inbound.traceparent })
    // hera-allow: raw-effect-run
    const exit = await Effect.runPromiseExit(invocation.provide(runnable))

    const result = exitToRpcResult(exit, {
      requestId,
      resolvedOrgId,
      service: heraCtx.service,
      spanName,
      unavailableCode,
      onDefect: meta?.onDefect ?? spec.onDefect,
    })
    invocation.end({ status: result.ok ? 200 : result.status, defect: exitIsDefect(exit) })
    return result
  }

  const rpcFn = ((...callArgs: ReadonlyArray<unknown>) =>
    invoke(...callArgs)) as unknown as HeraRpcMethod<InputSchema, A>

  Object.defineProperties(rpcFn, {
    methodName: { value: methodName, enumerable: true },
    service: { value: serviceSlug, enumerable: true },
  })

  return rpcFn
}
