import * as Effect from "effect/Effect"
import {
  HeraError,
  type HeraErrorCodeLookup,
  type HeraErrorStatus,
  type HeraWireErrorCode,
  isHeraErrorCode,
  isHeraErrorStatus,
  resolveCatalogPublicMessage,
  sanitizeErrorFields,
} from "../../core/errors/index.js"
import type { HeraSchemaIssue } from "../../core/schema/index.js"
import { extractSafeDefectName } from "../routes/response.js"
import {
  isHeraRpcResult,
  normalizeServiceSlug,
  serviceUnavailableCode,
} from "./envelope.js"
import {
  buildAmbientRpcMeta,
  extractTrailingRpcMeta,
  mergeInvokeMeta,
} from "./invoke-meta.js"
import {
  isRetryableTransportError,
  type RpcTransportFailure,
  withAttemptTimeout,
  withRpcRetry,
} from "./retry.js"
import type { HeraRpcClient, HeraRpcClientOptions } from "./types.js"

/**
 * A registry-declared code keeps its declared status and message; a catalog code keeps the wire's
 * status; anything else is the callee's `<service>_unavailable`.
 */
function resolveWireCode(
  rawCode: string,
  wireStatus: unknown,
  serviceSlug: string,
  lookups: ReadonlyArray<HeraErrorCodeLookup> | undefined
): {
  readonly code: HeraWireErrorCode
  readonly status: HeraErrorStatus
  readonly publicMessage: string
} {
  for (const lookup of lookups ?? []) {
    const declared = lookup.resolve(rawCode)
    if (declared !== undefined) {
      return declared
    }
  }
  const code: HeraWireErrorCode = isHeraErrorCode(rawCode)
    ? rawCode
    : serviceUnavailableCode(serviceSlug)
  const status: HeraErrorStatus = isHeraErrorStatus(wireStatus)
    ? wireStatus
    : 503
  return { code, status, publicMessage: resolveCatalogPublicMessage(code, status) }
}

function wireFailureToHeraError(
  wire: Record<string, unknown>,
  serviceSlug: string,
  lookups: ReadonlyArray<HeraErrorCodeLookup> | undefined
): HeraError {
  const rawCode =
    typeof wire.code === "string"
      ? wire.code
      : typeof wire.error === "string"
        ? wire.error
        : serviceUnavailableCode(serviceSlug)
  const { code, status, publicMessage } = resolveWireCode(
    rawCode,
    wire.status,
    serviceSlug,
    lookups
  )
  const retryAfter =
    typeof wire.retryAfter === "number"
      ? wire.retryAfter
      : typeof wire.retry_after === "number"
        ? wire.retry_after
        : undefined
  const requestId =
    typeof wire.requestId === "string"
      ? wire.requestId
      : typeof wire.request_id === "string"
        ? wire.request_id
        : undefined
  const issues = Array.isArray(wire.issues)
    ? (wire.issues as ReadonlyArray<HeraSchemaIssue>)
    : undefined
  const fields =
    typeof wire.fields === "object" && wire.fields !== null
      ? sanitizeErrorFields(wire.fields as Readonly<Record<string, unknown>>)
      : undefined

  return new HeraError({
    code,
    httpStatus: status,
    publicMessage,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(issues !== undefined ? { issues } : {}),
    ...(fields !== undefined ? { fields } : {}),
  })
}

/**
 * A returned value is a failure when it is an `{ ok: false }` envelope or an RFC 7807
 * problem-details object (`type` string, catalog `status`, string `code`, no `ok`).
 */
function isFailureWire(wire: unknown): wire is Record<string, unknown> {
  if (typeof wire !== "object" || wire === null) {
    return false
  }
  const record = wire as Record<string, unknown>
  if ("ok" in record) {
    return record.ok === false
  }
  return (
    typeof record.type === "string" &&
    typeof record.code === "string" &&
    isHeraErrorStatus(record.status)
  )
}

/**
 * The arguments a remote call sends: the caller's, with the fiber's correlation appended as a
 * marked meta. A caller that already ends with a marked meta (a forwarder) keeps its fields; the
 * fiber fills only the ones it left unset.
 */
const withAmbientMeta = (
  args: ReadonlyArray<unknown>,
  propagate: boolean
): Effect.Effect<ReadonlyArray<unknown>> =>
  propagate
    ? Effect.map(buildAmbientRpcMeta, (auto) => {
        const split = extractTrailingRpcMeta(args)
        return [...split.args, mergeInvokeMeta(split.meta, auto)]
      })
    : Effect.succeed(args)

function invokeRpcBindingMethod<T extends object>(
  binding: T | (() => T),
  serviceSlug: string,
  unavailableCode: `${string}_unavailable`,
  options: HeraRpcClientOptions | undefined,
  methodName: string,
  args: ReadonlyArray<unknown>
): Effect.Effect<unknown, HeraError, never> {
  return Effect.gen(function* () {
    const spanName = `rpc.client.${serviceSlug}.${methodName}`
    const retry = options?.retry
    const isRetryable = retry?.isRetryable ?? isRetryableTransportError
    const reportFailure = (failure: RpcTransportFailure, attempt: number) =>
      Effect.sync(() =>
        options?.onTransportError?.({
          service: serviceSlug,
          method: methodName,
          retryable: failure.retryable,
          errorName: extractSafeDefectName(failure.cause),
          attempt,
          timedOut: failure.timedOut,
        })
      )
    const attempt = (n: number) =>
      Effect.flatMap(withAmbientMeta(args, options?.propagate === true), (sent) =>
      withAttemptTimeout(
        Effect.tryPromise({
          try: async () => {
            // Resolved per attempt: a stub that has thrown stays broken, so a retry needs a new one.
            const target =
              typeof binding === "function" ? (binding as () => T)() : binding
            const candidate = (target as Record<string, unknown>)[methodName]
            if (typeof candidate !== "function") {
              throw new TypeError(`RPC method "${methodName}" is not a function`)
            }
            // `Reflect.apply`, not `candidate.apply`: on a workerd RPC stub every property is remote, so
            // `.apply` would be a call to a method named "apply" on the callee.
            return (await Reflect.apply(
              candidate as (...a: Array<unknown>) => Promise<unknown>,
              target,
              [...sent]
            )) as unknown
          },
          // A thrown `HeraError` is a refusal raised on this side (a local binding or the thunk),
          // never a transient of the transport, so no predicate may retry it.
          catch: (cause): RpcTransportFailure => ({
            cause,
            timedOut: false,
            retryable: !HeraError.is(cause) && isRetryable(cause),
          }),
        }),
        retry?.timeoutMs
      )).pipe(Effect.tapError((failure) => reportFailure(failure, n)))

    const wire = yield* withRpcRetry(attempt, retry, {
      service: serviceSlug,
      method: methodName,
    }).pipe(
      Effect.mapError(
        (failure) =>
          new HeraError({
            code: unavailableCode,
            httpStatus: 503,
            publicMessage: resolveCatalogPublicMessage(unavailableCode, 503),
            fields: {
              service: serviceSlug,
              method: methodName,
              retryable: failure.retryable,
              ...(retry !== undefined
                ? { attempts: failure.attempts, timedOut: failure.timedOut }
                : {}),
            },
            cause: failure.cause,
          })
      ),
      Effect.withSpan(spanName)
    )

    if (isHeraRpcResult(wire)) {
      if (wire.ok) {
        return wire.value
      }
      return yield* Effect.fail(
        wireFailureToHeraError(
          wire as unknown as Record<string, unknown>,
          serviceSlug,
          options?.codes
        )
      )
    }

    if (isFailureWire(wire)) {
      return yield* Effect.fail(
        wireFailureToHeraError(wire, serviceSlug, options?.codes)
      )
    }

    return wire
  })
}

/**
 * Wraps a Cloudflare Service Binding or Durable Object stub (or thunk `() => stub`)
 * into an Effect-native RPC client.
 */
export function rpcClient<T extends object>(
  binding: T | (() => T),
  options?: HeraRpcClientOptions
): HeraRpcClient<T> {
  const serviceSlug = normalizeServiceSlug(options?.service)
  const unavailableCode = serviceUnavailableCode(serviceSlug)

  return new Proxy({} as HeraRpcClient<T>, {
    get(_target, prop) {
      if (prop === "call") {
        return (method: string, ...args: ReadonlyArray<unknown>) =>
          invokeRpcBindingMethod(
            binding,
            serviceSlug,
            unavailableCode,
            options,
            method,
            args
          )
      }
      if (typeof prop !== "string" || prop === "then") {
        return undefined
      }
      return (...args: ReadonlyArray<unknown>) =>
        invokeRpcBindingMethod(
          binding,
          serviceSlug,
          unavailableCode,
          options,
          prop,
          args
        )
    },
  })
}
