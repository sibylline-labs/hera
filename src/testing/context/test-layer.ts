import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { HeraTenantDb } from "../../core/context/index.js";
import {
  composeTestLayer,
  type HeraTestLayerBaseOptions,
  type HeraTestLayerContext,
} from "./compose-test-layer.js";

export type { HeraTestLayerContext } from "./compose-test-layer.js";

export interface HeraTestLayerOptions extends HeraTestLayerBaseOptions {
  /** Tenant db behind `HeraTenantCtx.db`; omitted, `exec` / `query` are no-ops. */
  readonly db?: HeraTenantDb | undefined;
  readonly scheduleDomainAlarm?:
    | ((atMs: number) => Effect.Effect<void>)
    | undefined;
}

/**
 * Composes a drop-in Effect v4 `Layer` for tests providing `HeraPublicCtx`, `HeraAuthedCtx`,
 * `HeraTenantCtx`, `HeraCtx`, `HeraLoggerService`, `HeraEnv`, and Effect's deterministic
 * `TestClock`. Needs no ambient types; the in-memory SQLite DO-backed variant
 * is `makeTestLayer` from `@sibylline-labs/hera/testing/durable-object`.
 */
export function makeTestLayer(
  options?: HeraTestLayerOptions,
): Layer.Layer<HeraTestLayerContext> {
  return composeTestLayer(options, {
    db: options?.db,
    scheduleDomainAlarm: options?.scheduleDomainAlarm,
  });
}
