import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  type EnvSource,
  HeraConfig,
  type HeraEnv,
} from "../../core/config/index.js";
import {
  HeraCtx,
  type HeraCtxShape,
  HeraTenantCtx,
  type HeraTenantCtxShape,
} from "../../core/context/index.js";
import { SAMPLE_IDS } from "../fixtures/sample-ids.js";

/**
 * Builds a deterministic `HeraCtxShape` for tests with optional field overrides.
 */
export function makeTestCtx(overrides?: Partial<HeraCtxShape>): HeraCtxShape {
  return {
    requestId: overrides?.requestId ?? SAMPLE_IDS.requestId,
    actorId: overrides?.actorId ?? Option.some(SAMPLE_IDS.actorId),
    orgId: overrides?.orgId ?? Option.some(SAMPLE_IDS.orgId),
    service: overrides?.service ?? "hera-test",
    ...(overrides?.logger !== undefined ? { logger: overrides.logger } : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
  };
}

/**
 * Builds a deterministic `HeraTenantCtxShape` for tests with optional field overrides.
 */
export function makeTestTenantCtx(
  overrides?: Partial<HeraTenantCtxShape>,
): HeraTenantCtxShape {
  return {
    requestId: overrides?.requestId ?? SAMPLE_IDS.requestId,
    actorId: overrides?.actorId ?? Option.some(SAMPLE_IDS.actorId),
    orgId: overrides?.orgId ?? SAMPLE_IDS.orgId,
    service: overrides?.service ?? "hera-test",
    ...(overrides?.actorKind !== undefined
      ? { actorKind: overrides.actorKind }
      : {}),
    ...(overrides?.scopes !== undefined ? { scopes: overrides.scopes } : {}),
    ...(overrides?.db !== undefined ? { db: overrides.db } : {}),
    ...(overrides?.logger !== undefined ? { logger: overrides.logger } : {}),
    ...(overrides?.scheduleDomainAlarm !== undefined
      ? { scheduleDomainAlarm: overrides.scheduleDomainAlarm }
      : {}),
    ...(overrides?.now !== undefined ? { now: overrides.now } : {}),
  };
}

/**
 * Convenience Layer constructors for test suites.
 */
export function makeTestCtxLayer(
  overrides?: Partial<HeraCtxShape>,
): Layer.Layer<HeraCtx> {
  return HeraCtx.layer(makeTestCtx(overrides));
}

export function makeTestTenantCtxLayer(
  overrides?: Partial<HeraTenantCtxShape>,
): Layer.Layer<HeraTenantCtx | HeraCtx> {
  return HeraTenantCtx.layer(makeTestTenantCtx(overrides));
}

/**
 * Provides a test `HeraCtx` layer to an Effect (supports both data-first and pipeable curried calls).
 */
export function withTestCtx<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  overrides?: Partial<HeraCtxShape>,
): Effect.Effect<A, E, Exclude<R, HeraCtx>>;
export function withTestCtx(
  overrides?: Partial<HeraCtxShape>,
): <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, Exclude<R, HeraCtx>>;
export function withTestCtx(
  first?: Effect.Effect<unknown, unknown, unknown> | Partial<HeraCtxShape>,
  second?: Partial<HeraCtxShape>,
): unknown {
  if (Effect.isEffect(first)) {
    const layer = HeraCtx.layer(makeTestCtx(second));
    return Effect.provide(first, layer);
  }
  const layer = HeraCtx.layer(makeTestCtx(first));
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, layer);
}

/**
 * Provides both `HeraTenantCtx` and `HeraCtx` test layers to an Effect
 * (supports both data-first and pipeable curried calls).
 */
export function withTestTenantCtx<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  overrides?: Partial<HeraTenantCtxShape>,
): Effect.Effect<A, E, Exclude<R, HeraTenantCtx | HeraCtx>>;
export function withTestTenantCtx(
  overrides?: Partial<HeraTenantCtxShape>,
): <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, Exclude<R, HeraTenantCtx | HeraCtx>>;
export function withTestTenantCtx(
  first?:
    | Effect.Effect<unknown, unknown, unknown>
    | Partial<HeraTenantCtxShape>,
  second?: Partial<HeraTenantCtxShape>,
): unknown {
  if (Effect.isEffect(first)) {
    const layer = HeraTenantCtx.layer(makeTestTenantCtx(second));
    return Effect.provide(first, layer);
  }
  const layer = HeraTenantCtx.layer(makeTestTenantCtx(first));
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, layer);
}

/**
 * Provides a `HeraEnv` layer from an in-memory env object to an Effect
 * (supports both data-first and pipeable curried calls).
 */
export function withTestEnv<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  env: EnvSource,
): Effect.Effect<A, E, Exclude<R, HeraEnv>>;
export function withTestEnv(
  env: EnvSource,
): <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, Exclude<R, HeraEnv>>;
export function withTestEnv(
  first: Effect.Effect<unknown, unknown, unknown> | EnvSource,
  second?: EnvSource,
): unknown {
  if (Effect.isEffect(first)) {
    return Effect.provide(first, HeraConfig.layer(second));
  }
  const envLayer = HeraConfig.layer(first);
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, envLayer);
}
