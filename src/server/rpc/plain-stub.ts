import { HERA_RPC_META_MARK, isHeraRpcInvokeMeta } from "./invoke-meta.js"

type FillParams<P extends readonly unknown[]> = unknown[] extends P
  ? []
  : P extends readonly []
    ? []
    : P extends readonly [infer H, ...infer T]
      ? [H, ...FillParams<T>]
      : P extends readonly [(infer H)?]
        ? [H | undefined]
        : P extends readonly [(infer H)?, ...infer T]
          ? [H | undefined, ...FillParams<T>]
          : []
type FillMethod<F> = F extends (...args: infer P) => infer R ? (...args: FillParams<P>) => R : F

/**
 * A plain stub type whose methods take every optional positional parameter as a required
 * `X | undefined` and no trailing rest: a caller cannot leave a slot for the appended meta to fall into.
 */
export type HeraFilledStub<T> = { readonly [K in keyof T]: FillMethod<T[K]> }

/** Members a propagating stub never touches: the transport's own (`fetch`, `connect`), `then`
 *  (so the stub is not mistaken for a thenable), and every symbol-keyed one (`Symbol.dispose`). */
const UNPROPAGATED: ReadonlySet<string> = new Set(["fetch", "connect", "then"])

/**
 * `stub` with Hera's marked invoke meta (`{ __heraRpcMeta: true, traceparent }`) appended after the
 * arguments of each method call: the plain-stub twin of `Hera.rpcClient`'s `propagate: true`, for a
 * Durable Object door that answers raw values (`runDoor`). With no `traceparent` it answers `stub`.
 */
export function propagatingStub<T extends object>(stub: T, traceparent: string | undefined): HeraFilledStub<T> {
  if (traceparent === undefined) return stub as unknown as HeraFilledStub<T>
  const meta = { [HERA_RPC_META_MARK]: true, traceparent } as const
  return new Proxy(stub, {
    get(target, key) {
      const member: unknown = Reflect.get(target, key)
      if (typeof member !== "function" || typeof key === "symbol" || UNPROPAGATED.has(key)) return member
      return (...args: ReadonlyArray<unknown>): unknown => Reflect.apply(member, target, [...args, meta]) as unknown
    },
  }) as unknown as HeraFilledStub<T>
}

/** An optional door parameter as its caller passed it: `undefined` when the slot holds a marked
 *  invoke meta (a caller that omitted the optional). Read every door optional through it. */
export function givenOptional<T>(value: T | undefined): T | undefined {
  return isHeraRpcInvokeMeta(value) ? undefined : value
}
