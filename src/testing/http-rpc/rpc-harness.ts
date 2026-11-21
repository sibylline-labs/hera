import type * as Effect from "effect/Effect";
import {
  type HeraRpcClient,
  type HeraRpcInvokeMeta,
  type HeraRpcResult,
  rpcClient,
} from "../../server/rpc/index.js";
import { extractTrailingRpcMeta } from "../../server/rpc/invoke-meta.js";
import {
  invokeRpcDoubleMethod,
  type RpcDoubleFaultState,
} from "./rpc-fault-envelopes.js";

export interface HeraRpcDoubleCall {
  readonly method: string;
  readonly input: unknown;
  readonly meta: HeraRpcInvokeMeta | undefined;
  readonly timestampMs: number;
}

export interface HeraRpcFaultOptions {
  /**
   * `"envelope"` returns a Structured-Clone-safe `{ ok: false, status: 503, code: "<service>_unavailable", ... }` POJO
   * (matching `Hera.rpcMethod` boundary behavior).
   * `"transport"` rejects the Promise with a workerd transport error to exercise `Hera.rpcClient`'s transport trap.
   */
  readonly mode?: "envelope" | "transport" | undefined;
}

export type HeraRpcDoubleMethods<
  T extends Record<string, (...args: ReadonlyArray<any>) => any>,
> = {
  readonly [K in keyof T]: (
    input?: Parameters<T[K]>[0],
    meta?: HeraRpcInvokeMeta,
  ) => Promise<
    HeraRpcResult<
      Awaited<ReturnType<T[K]>> extends Effect.Effect<infer A, any, any>
        ? A
        : Awaited<ReturnType<T[K]>> extends HeraRpcResult<infer B>
          ? B
          : Awaited<ReturnType<T[K]>>
    >
  >;
};

export type HeraRpcDouble<
  T extends Record<string, (...args: ReadonlyArray<any>) => any>,
> = HeraRpcDoubleMethods<T> & {
  /**
   * Toggle service-wide `503 <service>_unavailable` outage fault.
   */
  unreachable: boolean;
  /**
   * Configures `.unreachable` and optional delivery mode (`"envelope"` vs `"transport"`).
   */
  readonly setUnreachable: (
    unreachable?: boolean,
    options?: HeraRpcFaultOptions,
  ) => void;
  /**
   * Configures a `429 rate_limited` fault with deterministic `retryAfter` seconds.
   */
  readonly rateLimited: (retryAfterSeconds?: number) => void;
  /**
   * Clears an active `.rateLimited(...)` fault toggle.
   */
  readonly clearRateLimit: () => void;
  /**
   * Queues a one-shot defect on the next RPC invocation.
   * The defect message is scrubbed at the RPC boundary into a closed `503 <service>_unavailable` response.
   */
  readonly defectOnNextCall: (
    error?: unknown,
    options?: HeraRpcFaultOptions,
  ) => void;
  /**
   * Resets all fault toggles (`.unreachable`, `.rateLimited`, `.defectOnNextCall`) and call history.
   */
  readonly resetFaults: () => void;
  /**
   * Clears recorded `.calls` without changing fault toggles.
   */
  readonly clearCalls: () => void;
  /**
   * Recorded RPC invocations against this double.
   */
  readonly calls: ReadonlyArray<HeraRpcDoubleCall>;
  /**
   * Pre-bound `Hera.rpcClient` wrapping this double for direct `yield* double.client.<method>(input)` usage.
   */
  readonly client: HeraRpcClient<HeraRpcDoubleMethods<T>>;
};

/**
 * Wraps a service binding implementation into a conformance RPC double
 * with built-in fault injection toggles (`.unreachable`, `.rateLimited(retryAfter?)`,
 * `.defectOnNextCall(error?)`, `.resetFaults()`) and call recording (`.calls`).
 */
export function makeTestRpcDouble<
  T extends Record<string, (...args: ReadonlyArray<any>) => any>,
>(serviceName: string, impl: T): HeraRpcDouble<T> {
  const faultState: RpcDoubleFaultState = {
    isUnreachable: false,
    unreachableMode: "envelope",
    rateLimitedRetryAfter: null,
    pendingDefects: [],
    recordedCalls: [],
  };

  const target: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(impl)) {
    if (typeof value === "function") {
      // A `Hera.rpcClient` call ends with a marked meta; lift it as `Hera.rpcMethod` does, so a
      // zero-argument call still records `input: undefined`.
      target[key] = (...callArgs: ReadonlyArray<unknown>) => {
        const { args, meta: trailing } = extractTrailingRpcMeta(callArgs);
        const explicit = args[1] as HeraRpcInvokeMeta | undefined;
        return invokeRpcDoubleMethod(
          serviceName,
          key,
          value.bind(impl),
          faultState,
          args[0],
          trailing === undefined ? explicit : { ...trailing, ...explicit },
        );
      };
    }
  }

  Object.defineProperties(target, {
    unreachable: {
      get: () => faultState.isUnreachable,
      set: (val: boolean) => {
        faultState.isUnreachable = Boolean(val);
        if (!faultState.isUnreachable) {
          faultState.unreachableMode = "envelope";
        }
      },
      enumerable: false,
      configurable: true,
    },
    setUnreachable: {
      value: (unreachable = true, options?: HeraRpcFaultOptions) => {
        faultState.isUnreachable = unreachable;
        faultState.unreachableMode = options?.mode ?? "envelope";
      },
      enumerable: false,
    },
    rateLimited: {
      value: (retryAfterSeconds = 60) => {
        faultState.rateLimitedRetryAfter = Math.max(
          1,
          Math.round(retryAfterSeconds),
        );
      },
      enumerable: false,
    },
    clearRateLimit: {
      value: () => {
        faultState.rateLimitedRetryAfter = null;
      },
      enumerable: false,
    },
    defectOnNextCall: {
      value: (
        error: unknown = new Error("Simulated upstream RPC defect"),
        options?: HeraRpcFaultOptions,
      ) => {
        faultState.pendingDefects.push({
          error,
          mode: options?.mode ?? "envelope",
        });
      },
      enumerable: false,
    },
    resetFaults: {
      value: () => {
        faultState.isUnreachable = false;
        faultState.unreachableMode = "envelope";
        faultState.rateLimitedRetryAfter = null;
        faultState.pendingDefects.length = 0;
        faultState.recordedCalls.length = 0;
      },
      enumerable: false,
    },
    clearCalls: {
      value: () => {
        faultState.recordedCalls.length = 0;
      },
      enumerable: false,
    },
    calls: {
      get: () => faultState.recordedCalls,
      enumerable: false,
    },
  });

  const boundClient = rpcClient(target as HeraRpcDoubleMethods<T>, {
    service: serviceName,
  });
  Object.defineProperty(target, "client", {
    value: boundClient,
    enumerable: false,
  });

  return target as HeraRpcDouble<T>;
}
