import type * as Effect from "effect/Effect"
import type { HeraTelemetryHook } from "../../core/telemetry/types.js"
import type * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import type {
  HeraCtx,
  HeraCtxShape,
  HeraTenantCtx,
  HeraTenantCtxShape,
} from "../../core/context/index.js"
import type {
  AnyHeraDefinedError,
  HeraError,
  HeraErrorCodeLookup,
  HeraErrorStatus,
  HeraWireErrorCode,
} from "../../core/errors/index.js"
import type {
  HeraSchemaIssue,
  OrgId,
  RequestId,
} from "../../core/schema/index.js"
import type { HeraBoundaryDefectLog } from "../routes/types.js"

/**
 * Structured-Clone-safe RPC success wire envelope.
 */
export interface HeraRpcOk<A> {
  readonly ok: true
  readonly value: A
}

/**
 * Structured-Clone-safe RPC failure wire envelope.
 *
 * Includes both `code` (Hera canonical) and `error` (the older `Fail<S, C>` contract's field)
 * on a plain prototype-free POJO so `workerd` Structured Clone preserves all fields.
 */
export interface HeraRpcFail<
  C extends HeraWireErrorCode = HeraWireErrorCode,
  S extends HeraErrorStatus = HeraErrorStatus,
> {
  readonly ok: false
  readonly status: S
  readonly code: C
  readonly error: C
  readonly message: string
  readonly requestId?: string
  readonly retryAfter?: number
  readonly issues?: ReadonlyArray<HeraSchemaIssue>
  readonly fields?: Readonly<Record<string, unknown>>
}

/**
 * Union wire result returned across Cloudflare Service Binding / Durable Object RPC.
 */
export type HeraRpcResult<
  A,
  C extends HeraWireErrorCode = HeraWireErrorCode,
  S extends HeraErrorStatus = HeraErrorStatus,
> = HeraRpcOk<A> | HeraRpcFail<C, S>

/**
 * Optional metadata passed alongside an RPC method invocation. `Hera.rpcClient` with `propagate: true` appends
 * one marked `__heraRpcMeta: true` as the last argument of every call;
 * `Hera.rpcMethod` lifts a marked trailing meta off its arguments. `orgId` and `actorId` that
 * arrive only in that appended meta are log correlation, never tenant identity.
 */
export interface HeraRpcInvokeMeta {
  readonly __heraRpcMeta?: true | undefined
  readonly requestId?: RequestId | string | undefined
  /** W3C `traceparent` of the caller's span; the callee's span parents under it. */
  readonly traceparent?: string | undefined
  /** W3C `baggage`, opaque and forwarded hop to hop; never logged. */
  readonly baggage?: string | undefined
  readonly orgId?: OrgId | string | undefined
  readonly actorId?: string | undefined
  readonly tenant?: HeraTenantCtxShape | undefined
  readonly heraCtx?: Partial<HeraCtxShape> | undefined
  readonly onDefect?: ((entry: HeraBoundaryDefectLog) => void) | undefined
}

/**
 * Context passed to the handler of `Hera.rpcMethod`.
 */
export interface HeraRpcHandlerContext {
  readonly method: string
  readonly service: string
  readonly requestId: RequestId
  readonly heraCtx: HeraCtxShape
  readonly tenant?: HeraTenantCtxShape | undefined
  /** The caller's W3C `traceparent`, when it sent a valid one. */
  readonly traceparent?: string | undefined
}

export type RpcInputDecoded<S extends Schema.Top | undefined> =
  S extends Schema.Top ? S["Type"] : unknown

export type RpcInputEncoded<S extends Schema.Top | undefined> =
  S extends Schema.Top ? S["Encoded"] : unknown

/**
 * Specification for `Hera.rpcMethod`.
 */
export interface HeraRpcMethodSpec<
  InputSchema extends Schema.Top | undefined = undefined,
  A = unknown,
  E = HeraError | AnyHeraDefinedError,
  R = HeraCtx,
> {
  readonly name?: string | undefined
  readonly service?: string | undefined
  readonly input?: InputSchema
  readonly layer?: Layer.Layer<Exclude<R, HeraCtx | HeraTenantCtx>, never, never> | undefined
  readonly onDefect?: ((entry: HeraBoundaryDefectLog) => void) | undefined
  /**
   * Traces and exports each call as one `HeraTelemetry` invocation, parented under the caller's
   * `traceparent`. Built where `this.ctx` is in reach: `{ telemetry, waitUntil: (p) => this.ctx.waitUntil(p) }`.
   */
  readonly telemetry?: HeraTelemetryHook | undefined
  readonly handler: (
    input: RpcInputDecoded<InputSchema>,
    ctx: HeraRpcHandlerContext
  ) => Effect.Effect<A, E, R>
}

/**
 * Callable RPC boundary method returned by `Hera.rpcMethod`.
 */
export interface HeraRpcMethod<
  InputSchema extends Schema.Top | undefined = undefined,
  A = unknown,
> {
  (
    ...args: InputSchema extends Schema.Top
      ? [input: RpcInputEncoded<InputSchema>, meta?: HeraRpcInvokeMeta]
      : [input?: unknown, meta?: HeraRpcInvokeMeta]
  ): Promise<HeraRpcResult<A>>
  readonly methodName: string
  readonly service: string
}

/**
 * Options for `Hera.rpcClient(binding, options?)`.
 */
export interface HeraRpcClientOptions {
  readonly service?: string | undefined
  /**
   * Registries (`HeraError.codes`) whose domain codes a failure keeps on this side, at the
   * registry's declared status. A code no registry declares maps to `<service>_unavailable`.
   */
  readonly codes?: ReadonlyArray<HeraErrorCodeLookup> | undefined
  /** Fires once per failed attempt (`attempt` is 1-based), before any retry. */
  readonly onTransportError?:
    | ((info: {
        readonly service: string
        readonly method: string
        readonly retryable: boolean
        readonly errorName: string
        readonly attempt: number
        readonly timedOut: boolean
      }) => void)
    | undefined
  /** Opt-in transport retry. Absent: one attempt, no timeout. */
  readonly retry?: HeraRpcRetryPolicy | undefined
  /**
   * `true` appends a marked `HeraRpcInvokeMeta` (request/org/actor correlation, `traceparent`,
   * `baggage`) to every call. Default `false`: the caller's arguments cross untouched, because a
   * callee `rpcMethod` built before trailing-meta stripping reads a second argument as its
   * tenant-bearing meta, and a plain method takes an extra argument into an optional parameter.
   * Opt in only for a binding whose callee is an `rpcMethod` that strips a trailing meta.
   */
  readonly propagate?: boolean | undefined
}

/**
 * Exponential full-jitter backoff: the delay before retry `n` is
 * `min(maxMs, baseMs * 2^(n-1) * U)`, `U` drawn from Effect `Random` in `[0, 1)`.
 */
export interface HeraRpcRetryBackoff {
  readonly baseMs: number
  readonly maxMs: number
}

/** Passed to `HeraRpcRetryPolicy.onRetry` before each backoff sleep. */
export interface HeraRpcRetryNotice {
  readonly service: string
  readonly method: string
  /** The attempt that just failed (1-based). */
  readonly attempt: number
  readonly backoffMs: number
  readonly errorName: string
  readonly timedOut: boolean
}

/**
 * Transport retry policy for `Hera.rpcClient`. Only a rejected or timed-out call is
 * retried; an `{ ok: false }` or problem-details refusal is a returned value and never is. Each
 * attempt re-resolves a `() => stub` binding, so a stub broken by a throw is not reused.
 */
export interface HeraRpcRetryPolicy {
  /** Total attempts including the first (integer >= 1). */
  readonly attempts: number
  /** Defaults to `{ baseMs: 50, maxMs: 1000 }`. */
  readonly backoff?: HeraRpcRetryBackoff | undefined
  /**
   * Abandon an attempt unsettled after this long and count it as retryable. Abandoning does not
   * cancel the call, so set it only for a call whose second application lands the same state.
   */
  readonly timeoutMs?: number | undefined
  /** Classifies a rejection; defaults to `isRetryableTransportError`. */
  readonly isRetryable?: ((err: unknown) => boolean) | undefined
  readonly onRetry?: ((notice: HeraRpcRetryNotice) => void) | undefined
}

type RpcClientMethod<M> = M extends (
  ...args: infer Args
) => Promise<HeraRpcResult<infer A, any, any>>
  ? (...args: Args) => Effect.Effect<A, HeraError, never>
  : M extends (...args: infer Args) => Promise<infer R>
    ? (
        ...args: Args
      ) => Effect.Effect<
        R extends { readonly ok: true; readonly value: infer V }
          ? V
          : Exclude<R, { readonly ok: false }>,
        HeraError,
        never
      >
    : never

type RpcCallArgs<M> = M extends (...a: infer A) => any
  ? A
  : ReadonlyArray<unknown>

type RpcCallValue<M> = M extends (
  ...a: ReadonlyArray<any>
) => Promise<HeraRpcResult<infer V, any, any>>
  ? V
  : unknown

/**
 * Typed Effect RPC client returned by `Hera.rpcClient(binding, options?)`.
 */
export type HeraRpcClient<T extends object> = {
  readonly [K in keyof T as T[K] extends (...args: ReadonlyArray<any>) => any
    ? K
    : never]: RpcClientMethod<T[K]>
} & {
  call<K extends keyof T & string>(
    method: K,
    ...args: RpcCallArgs<T[K]>
  ): Effect.Effect<RpcCallValue<T[K]>, HeraError, never>
}
