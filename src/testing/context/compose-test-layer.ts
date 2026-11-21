import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import {
  type EnvSource,
  HeraConfig,
  type HeraEnv,
} from "../../core/config/index.js";
import {
  type HeraActorKind,
  HeraAuthedCtx,
  type HeraCtx,
  type HeraPublicCtx,
  HeraTenantCtx,
  type HeraTenantDb,
} from "../../core/context/index.js";
import {
  createHeraLogger,
  type HeraLogger,
  type HeraLoggerService,
  type LogSink,
} from "../../core/logger/index.js";
import type { ActorId, OrgId, RequestId } from "../../core/schema/index.js";
import { DEFAULT_TEST_TIME_MS, SAMPLE_IDS } from "../fixtures/sample-ids.js";

/** Options shared by the pure `/testing` layer and the DO-backed `/testing/durable-object` layer. */
export interface HeraTestLayerBaseOptions {
  readonly requestId?: RequestId | undefined;
  readonly orgId?: OrgId | undefined;
  readonly actorId?: ActorId | Option.Option<ActorId> | undefined;
  readonly actorKind?: HeraActorKind | undefined;
  readonly scopes?: ReadonlySet<string> | ReadonlyArray<string> | undefined;
  readonly productCtx?: Readonly<Record<string, unknown>> | undefined;
  readonly service?: string | undefined;
  readonly logger?: HeraLogger | undefined;
  readonly sink?: LogSink | undefined;
  readonly whitelistedErrorCodes?:
    | ReadonlySet<string>
    | ReadonlyArray<string>
    | undefined;
  readonly initialTimeMs?: number | undefined;
  readonly env?: EnvSource | undefined;
}

export type HeraTestLayerContext =
  | TestClock.TestClock
  | HeraPublicCtx
  | HeraAuthedCtx
  | HeraTenantCtx
  | HeraCtx
  | HeraLoggerService
  | HeraEnv;

/** What backs `HeraTenantCtx` in a test layer; the DO subpath supplies an in-memory SQLite one. */
export interface HeraTestTenantBacking {
  readonly db?: HeraTenantDb | undefined;
  readonly scheduleDomainAlarm?: ((atMs: number) => Effect.Effect<void>) | undefined;
  readonly setClock?: ((timeMs: number) => void) | undefined;
}

export function resolveTestLayerIds(options?: HeraTestLayerBaseOptions): {
  readonly orgId: OrgId;
  readonly service: string;
  readonly initialTimeMs: number;
} {
  return {
    orgId: options?.orgId ?? SAMPLE_IDS.orgId,
    service: options?.service ?? "hera-test",
    initialTimeMs: options?.initialTimeMs ?? DEFAULT_TEST_TIME_MS,
  };
}

/**
 * Composes the test `Layer`: ambient ctx tags, logger, `HeraEnv`, and a `TestClock`
 * pinned to `initialTimeMs`, over whatever tenant backing the caller supplies.
 */
export function composeTestLayer(
  options: HeraTestLayerBaseOptions | undefined,
  backing: HeraTestTenantBacking,
): Layer.Layer<HeraTestLayerContext> {
  const { orgId, service, initialTimeMs } = resolveTestLayerIds(options);
  const requestId = options?.requestId ?? SAMPLE_IDS.requestId;
  const resolvedActorOption: Option.Option<ActorId> =
    options?.actorId === undefined
      ? Option.some(SAMPLE_IDS.actorId)
      : Option.isOption(options.actorId)
        ? options.actorId
        : Option.some(options.actorId);
  const resolvedActorId: ActorId = Option.getOrElse(
    resolvedActorOption,
    () => SAMPLE_IDS.actorId,
  );
  const actorKind: HeraActorKind = options?.actorKind ?? "user";
  const scopesList: ReadonlyArray<string> =
    options?.scopes === undefined ? [] : Array.from(options.scopes);

  const baseLogger =
    options?.logger ??
    createHeraLogger({
      service,
      sink: options?.sink,
      whitelistedErrorCodes: options?.whitelistedErrorCodes,
    });

  const boundLogger = baseLogger.child({
    requestId,
    orgId,
    actorId: Option.getOrUndefined(resolvedActorOption),
  });

  const testClockLayer = Layer.provideMerge(
    Layer.effectDiscard(
      TestClock.setTime(initialTimeMs).pipe(
        Effect.tap(() => Effect.sync(() => backing.setClock?.(initialTimeMs))),
      ),
    ),
    TestClock.layer(),
  );

  const authedLayer = HeraAuthedCtx.layer({
    requestId,
    service,
    orgId,
    actorId: resolvedActorId,
    actorKind,
    scopes: scopesList,
    productCtx: options?.productCtx,
    logger: boundLogger,
    now: Clock.currentTimeMillis,
  });

  const tenantLayer = HeraTenantCtx.layer({
    requestId,
    service,
    orgId,
    actorId: resolvedActorOption,
    actorKind,
    scopes: scopesList,
    db: backing.db,
    logger: boundLogger,
    scheduleDomainAlarm: backing.scheduleDomainAlarm,
    now: Clock.currentTimeMillis,
  });

  const envLayer = HeraConfig.layer(options?.env ?? {});

  return Layer.mergeAll(testClockLayer, authedLayer, tenantLayer, envLayer);
}
