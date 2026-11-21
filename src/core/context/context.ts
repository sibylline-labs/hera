import { Service } from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { HeraLoggerService } from "../logger/index.js"
import {
  resolveAuthedCtxShapes,
  resolveLegacyCtxShapes,
  resolvePublicCtxShapes,
  resolveTenantCtxShapes,
} from "./headers.js"
import {
  HERA_AUTHED_CTX_KEY,
  HERA_CTX_KEY,
  HERA_PUBLIC_CTX_KEY,
  HERA_TENANT_CTX_KEY,
} from "./keys.js"
import type {
  HeraAuthedCtxInput,
  HeraAuthedCtxShape,
  HeraCtxShape,
  HeraPublicCtxInput,
  HeraPublicCtxShape,
  HeraTenantCtxInput,
  HeraTenantCtxService,
  HeraTenantCtxShape,
} from "./types.js"

/**
 * Ambient context for unauthenticated routes (`/healthz`, OAuth callbacks, public webhooks).
 * Carries `requestId`, `service`, redacted `logger`, and deterministic `now` (`Clock.currentTimeMillis`).
 */
export class HeraPublicCtx extends Service<HeraPublicCtx, HeraPublicCtxShape>()(
  HERA_PUBLIC_CTX_KEY
) {
  static layer(
    input: HeraPublicCtxInput
  ): Layer.Layer<HeraPublicCtx | HeraCtx | HeraLoggerService> {
    const { logger, publicShape, legacyShape } = resolvePublicCtxShapes(input)
    return Layer.mergeAll(
      Layer.succeed(HeraPublicCtx, publicShape),
      Layer.succeed(HeraCtx, legacyShape),
      logger.layer
    )
  }

  static get current(): Effect.Effect<
    HeraPublicCtxShape,
    never,
    HeraPublicCtx
  > {
    return Effect.service(HeraPublicCtx)
  }
}

/**
 * Ambient context for authenticated routes verified by an issuer or service keys.
 * Extends `HeraPublicCtx` with `orgId`, `actorId`, `actorKind`, `scopes`, `productCtx`,
 * and an enriched `logger` pre-bound with `{ org_id, actor_id, request_id }`.
 */
export class HeraAuthedCtx extends Service<HeraAuthedCtx, HeraAuthedCtxShape>()(
  HERA_AUTHED_CTX_KEY
) {
  static layer(
    input: HeraAuthedCtxInput
  ): Layer.Layer<HeraAuthedCtx | HeraPublicCtx | HeraCtx | HeraLoggerService> {
    const { logger, authedShape, publicShape, legacyShape } =
      resolveAuthedCtxShapes(input)
    return Layer.mergeAll(
      Layer.succeed(HeraAuthedCtx, authedShape),
      Layer.succeed(HeraPublicCtx, publicShape),
      Layer.succeed(HeraCtx, legacyShape),
      logger.layer
    )
  }

  static get current(): Effect.Effect<
    HeraAuthedCtxShape,
    never,
    HeraAuthedCtx
  > {
    return Effect.service(HeraAuthedCtx)
  }
}

/**
 * Legacy unified request context preserved for backwards compatibility with existing consumers.
 * Prefer `HeraPublicCtx` or `HeraAuthedCtx` in new route handlers.
 */
export class HeraCtx extends Service<HeraCtx, HeraCtxShape>()(
  HERA_CTX_KEY
) {
  static layer(
    shape: HeraCtxShape
  ): Layer.Layer<HeraCtx | HeraPublicCtx | HeraLoggerService> {
    const { logger, resolvedShape, publicShape } =
      resolveLegacyCtxShapes(shape)
    return Layer.mergeAll(
      Layer.succeed(HeraCtx, resolvedShape),
      Layer.succeed(HeraPublicCtx, publicShape),
      logger.layer
    )
  }

  static get current(): Effect.Effect<HeraCtxShape, never, HeraCtx> {
    return Effect.service(HeraCtx)
  }
}

/**
 * Ambient context for per-org Durable Object execution (`HeraDurableObject`).
 * Carries `orgId`, `db` (`HeraTenantDb`), a `logger` pre-bound with `{ service, org_id }`,
 * `scheduleDomainAlarm(atMs: number): Effect<void>`, and `now` (`Clock.currentTimeMillis`).
 */
export class HeraTenantCtx extends Service<
  HeraTenantCtx,
  HeraTenantCtxService
>()(HERA_TENANT_CTX_KEY) {
  static toHeraCtx(shape: HeraTenantCtxShape): HeraCtxShape {
    return {
      requestId: shape.requestId,
      actorId: shape.actorId,
      orgId: Option.some(shape.orgId),
      service: shape.service,
      ...(shape.logger !== undefined ? { logger: shape.logger } : {}),
      ...(shape.now !== undefined ? { now: shape.now } : {}),
    }
  }

  static layer(
    input: HeraTenantCtxInput
  ): Layer.Layer<HeraTenantCtx | HeraPublicCtx | HeraCtx | HeraLoggerService> {
    const { logger, tenantService, publicShape, legacyShape } =
      resolveTenantCtxShapes(input)
    return Layer.mergeAll(
      Layer.succeed(HeraTenantCtx, tenantService),
      Layer.succeed(HeraPublicCtx, publicShape),
      Layer.succeed(HeraCtx, legacyShape),
      logger.layer
    )
  }

  static get current(): Effect.Effect<
    HeraTenantCtxService,
    never,
    HeraTenantCtx
  > {
    return Effect.service(HeraTenantCtx)
  }
}
