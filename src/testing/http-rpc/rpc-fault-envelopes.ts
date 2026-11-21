import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { HeraCtx, HeraTenantCtx } from "../../core/context/index.js";
import {
  HeraError,
  resolveCatalogPublicMessage,
} from "../../core/errors/index.js";
import { scrubLogString } from "../../core/logger/index.js";
import type { ActorId, OrgId, RequestId } from "../../core/schema/index.js";
import {
  type HeraRpcFail,
  type HeraRpcInvokeMeta,
  type HeraRpcOk,
  type HeraRpcResult,
  isHeraRpcResult,
  serviceUnavailableCode,
} from "../../server/rpc/index.js";
import { withTestTenantCtx } from "../context/test-ctx.js";
import { SAMPLE_IDS } from "../fixtures/sample-ids.js";
import { getSharedFallbackClockMs } from "../runner/clock-state.js";
import type { HeraRpcDoubleCall } from "./rpc-harness.js";

export interface QueuedRpcDefect {
  readonly error: unknown;
  readonly mode: "envelope" | "transport";
}

export interface RpcDoubleFaultState {
  isUnreachable: boolean;
  unreachableMode: "envelope" | "transport";
  rateLimitedRetryAfter: number | null;
  readonly pendingDefects: Array<QueuedRpcDefect>;
  readonly recordedCalls: Array<HeraRpcDoubleCall>;
}

export function toUnavailableRpcFail(
  serviceName: string,
  methodName: string,
  requestId?: string | undefined,
): HeraRpcFail {
  const code = serviceUnavailableCode(serviceName);
  return {
    ok: false,
    status: 503,
    code,
    error: code,
    message: resolveCatalogPublicMessage(code, 503),
    ...(requestId !== undefined ? { requestId } : {}),
    fields: {
      service: serviceName.toLowerCase(),
      method: methodName,
      retryable: true,
    },
  };
}

export function toHeraErrorRpcFail(
  err: HeraError,
  requestId?: string | undefined,
): HeraRpcFail {
  const rawFields = err.fields;
  const safeFields =
    rawFields !== undefined && Object.keys(rawFields).length > 0
      ? (structuredClone(rawFields) as Record<string, unknown>)
      : undefined;
  const retryAfterField =
    rawFields?.retryAfterSeconds ?? rawFields?.retryAfter;
  const retryAfter =
    typeof retryAfterField === "number" && Number.isFinite(retryAfterField)
      ? retryAfterField
      : undefined;
  const resolvedRequestId = requestId ?? err.requestId;
  return {
    ok: false,
    status: err.httpStatus,
    code: err.code,
    error: err.code,
    message: scrubLogString(err.publicMessage),
    ...(resolvedRequestId !== undefined
      ? { requestId: resolvedRequestId }
      : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(safeFields !== undefined ? { fields: safeFields } : {}),
  };
}

export async function invokeRpcDoubleMethod(
  serviceName: string,
  methodName: string,
  fn: (...args: ReadonlyArray<any>) => any,
  state: RpcDoubleFaultState,
  input?: unknown,
  meta?: HeraRpcInvokeMeta,
): Promise<HeraRpcResult<any>> {
  state.recordedCalls.push({
    method: methodName,
    input,
    meta,
    timestampMs: getSharedFallbackClockMs(),
  });

  const requestId = meta?.requestId;

  if (state.pendingDefects.length > 0) {
    const nextDefect = state.pendingDefects.shift()!;
    if (nextDefect.mode === "transport") {
      throw nextDefect.error instanceof Error
        ? nextDefect.error
        : new Error(String(nextDefect.error));
    }
    return toUnavailableRpcFail(serviceName, methodName, requestId);
  }

  if (state.isUnreachable) {
    if (state.unreachableMode === "transport") {
      throw new Error(
        `Network connection lost while calling ${serviceName}.${methodName}`,
      );
    }
    return toUnavailableRpcFail(serviceName, methodName, requestId);
  }

  if (state.rateLimitedRetryAfter !== null) {
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      error: "rate_limited",
      message: "Rate limit exceeded",
      ...(requestId !== undefined ? { requestId } : {}),
      retryAfter: state.rateLimitedRetryAfter,
      fields: {
        retryAfter: state.rateLimitedRetryAfter,
        retryAfterSeconds: state.rateLimitedRetryAfter,
      },
    };
  }

  try {
    const rawOut = fn(input, meta);
    if (Effect.isEffect(rawOut)) {
      const providedEffect = withTestTenantCtx(
        rawOut as Effect.Effect<unknown, unknown, HeraTenantCtx | HeraCtx>,
        {
          requestId:
            (meta?.requestId as RequestId | undefined) ?? SAMPLE_IDS.requestId,
          orgId: (meta?.orgId as OrgId | undefined) ?? SAMPLE_IDS.orgId,
          actorId:
            meta?.actorId !== undefined
              ? Option.some(meta.actorId as ActorId)
              : Option.some(SAMPLE_IDS.actorId),
          service: serviceName,
        },
      );
      const exit = await Effect.runPromiseExit(
        providedEffect as Effect.Effect<unknown, unknown, never>,
      );
      if (Exit.isSuccess(exit)) {
        const val = exit.value;
        if (isHeraRpcResult(val)) {
          return structuredClone(val);
        }
        return structuredClone({
          ok: true,
          value: val,
        } satisfies HeraRpcOk<unknown>);
      }
      const failureOpt = Cause.findErrorOption(exit.cause);
      if (Option.isSome(failureOpt)) {
        const failure = failureOpt.value;
        if (HeraError.is(failure)) {
          return toHeraErrorRpcFail(failure, requestId);
        }
      }
      return toUnavailableRpcFail(serviceName, methodName, requestId);
    }

    const awaited = await rawOut;
    if (isHeraRpcResult(awaited)) {
      return structuredClone(awaited);
    }
    return structuredClone({
      ok: true,
      value: awaited,
    } satisfies HeraRpcOk<unknown>);
  } catch (err) {
    if (HeraError.is(err)) {
      return toHeraErrorRpcFail(err, requestId);
    }
    return toUnavailableRpcFail(serviceName, methodName, requestId);
  }
}
