/**
 * Hera-native HTTP over Workers JS RPC: `httpRpcMethod` on the callee, `httpRpcClient` on the caller.
 *
 * Invariants:
 *  - The callee answers `Promise<HeraRpcResult<HttpRpcReply>>` and never a `Response`, so no stream
 *    crosses the binding (cloudflare/workerd#8674). It is an `rpcMethod`: span, invoke meta, ctx and
 *    defect trapping are `rpcMethod`'s.
 *  - The caller sends an `HttpRpcRequest` and never a `Request`; an oversize body fails 413 before
 *    the binding is called.
 *  - Both sides read the other's previous shape: the callee takes a raw `Request`, the caller reads a
 *    raw `Response` or a bare `HttpRpcReply` (a callee answering with no `{ ok }` envelope).
 */
import * as Effect from "effect/Effect"
import { HeraError, type AnyHeraDefinedError } from "../../core/errors/index.js"
import type { HeraCtx } from "../../core/context/index.js"
import type { HeraRouter } from "../routes/router.js"
import { rpcClient } from "./client.js"
import {
  fromHttpRpcReply,
  fromHttpRpcRequest,
  type HttpRpcBodyOptions,
  type HttpRpcReply,
  type HttpRpcRequest,
  resolveHttpRpcMaxBytes,
  toHttpRpcReply,
  toHttpRpcRequest,
} from "./http-envelope.js"
import { rpcMethod } from "./method.js"
import type {
  HeraRpcClientOptions,
  HeraRpcHandlerContext,
  HeraRpcInvokeMeta,
  HeraRpcMethodSpec,
  HeraRpcResult,
} from "./types.js"

type HttpRpcSpecBase<R> = Pick<
  HeraRpcMethodSpec<undefined, HttpRpcReply, unknown, R>,
  "service" | "layer" | "onDefect" | "telemetry"
> & {
  /** Reply body cap (default `MAX_HTTP_RPC_BYTES`); a larger reply answers 502 `bad_gateway`. */
  readonly maxBytes?: number | undefined
}

/**
 * `handler` answers the request as an Effect, or `router` dispatches it with the call's
 * `heraCtx` / `tenant`; exactly one is set.
 */
export type HeraHttpRpcMethodSpec<E = HeraError | AnyHeraDefinedError, R = HeraCtx> =
  HttpRpcSpecBase<R> &
    (
      | {
          readonly handler: (
            request: Request,
            ctx: HeraRpcHandlerContext
          ) => Effect.Effect<Response, E, R>
          readonly router?: undefined
        }
      | { readonly router: HeraRouter<never>; readonly handler?: undefined }
    )

/** The callable an entrypoint method returns: `handle(input, meta) { return method(input, meta) }`. */
export interface HeraHttpRpcMethod {
  (input: HttpRpcRequest | Request, meta?: HeraRpcInvokeMeta): Promise<HeraRpcResult<HttpRpcReply>>
  readonly methodName: string
  readonly service: string
}

function answer<E, R>(
  spec: HeraHttpRpcMethodSpec<E, R>,
  request: Request,
  ctx: HeraRpcHandlerContext
): Effect.Effect<Response, E, R> {
  if (spec.handler !== undefined) return spec.handler(request, ctx)
  const router = spec.router
  return Effect.promise(() =>
    router(request, {
      heraCtx: ctx.heraCtx,
      ...(ctx.tenant !== undefined ? { tenant: ctx.tenant } : {}),
    })
  )
}

/** Wraps an HTTP handler or `Hera.router` as an RPC method that answers an `HttpRpcReply`. */
export function httpRpcMethod<E = HeraError | AnyHeraDefinedError, R = HeraCtx>(
  name: string,
  spec: HeraHttpRpcMethodSpec<E, R>
): HeraHttpRpcMethod {
  const replyOptions: HttpRpcBodyOptions = { maxBytes: resolveHttpRpcMaxBytes(spec) }
  const method = rpcMethod<undefined, HttpRpcReply, E | HeraError, R>(name, {
    service: spec.service,
    layer: spec.layer,
    onDefect: spec.onDefect,
    telemetry: spec.telemetry,
    handler: (input, ctx) =>
      Effect.gen(function* () {
        const request = yield* Effect.try({
          try: () => fromHttpRpcRequest(input as HttpRpcRequest | Request),
          catch: (cause) => (HeraError.is(cause) ? cause : HeraError.badRequest()),
        })
        const response = yield* answer(spec, request, ctx)
        return yield* Effect.tryPromise({
          try: () => toHttpRpcReply(response, replyOptions),
          catch: (cause) => (HeraError.is(cause) ? cause : HeraError.badGateway()),
        })
      }),
  })
  return method as unknown as HeraHttpRpcMethod
}

export interface HeraHttpRpcClientOptions extends HeraRpcClientOptions {
  /** The callee's method name (default `"handle"`). */
  readonly method?: string | undefined
  /** Request body cap (default `MAX_HTTP_RPC_BYTES`); a larger body fails 413 before the call. */
  readonly maxBytes?: number | undefined
}

export interface HeraHttpRpcClient {
  /** Forwards `request` over the binding and answers the callee's `Response`. */
  readonly fetch: (request: Request) => Effect.Effect<Response, HeraError>
}

/** A callee still answering a raw `Response` is read as an `{ ok: true }` envelope. */
function normalisingBinding<T extends object>(
  binding: T | (() => T),
  methodName: string,
  replyOptions: HttpRpcBodyOptions
): () => Record<string, (...args: ReadonlyArray<unknown>) => Promise<unknown>> {
  return () => {
    const target = typeof binding === "function" ? (binding as () => T)() : binding
    const candidate = (target as Record<string, unknown>)[methodName]
    if (typeof candidate !== "function") return {}
    return {
      [methodName]: async (...args) => {
        // `Reflect.apply`: on a workerd stub every property is remote, `.apply` included.
        const wire: unknown = await Reflect.apply(candidate, target, [...args])
        return wire instanceof Response
          ? { ok: true, value: await toHttpRpcReply(wire, replyOptions) }
          : wire
      },
    }
  }
}

/** Wraps a Service Binding (or thunk) whose method answers `HttpRpcReply` as an Effect `fetch`. */
export function httpRpcClient<T extends object>(
  binding: T | (() => T),
  options?: HeraHttpRpcClientOptions
): HeraHttpRpcClient {
  const methodName = options?.method ?? "handle"
  const bodyOptions: HttpRpcBodyOptions = { maxBytes: resolveHttpRpcMaxBytes(options) }
  const client = rpcClient(normalisingBinding(binding, methodName, bodyOptions), options)
  return {
    fetch: (request) =>
      Effect.gen(function* () {
        const envelope = yield* Effect.tryPromise({
          try: () => toHttpRpcRequest(request, bodyOptions),
          catch: (cause) => (HeraError.is(cause) ? cause : HeraError.badRequest()),
        })
        const wire = yield* client.call(methodName, envelope)
        return yield* Effect.try({
          try: () => fromHttpRpcReply(wire as HttpRpcReply | Response),
          catch: (cause) => (HeraError.is(cause) ? cause : HeraError.badGateway()),
        })
      }),
  }
}
