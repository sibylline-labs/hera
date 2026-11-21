import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"
import type { HeraLogger, LogSink } from "../logger/index.js"
import type { ActorId, OrgId, RequestId } from "../schema/index.js"

/**
 * Authenticated principal kind.
 */
export type HeraActorKind =
  | "user"
  | "service"
  | "admin"
  | "service_key"
  | "internal"

export type ActorKind = HeraActorKind

export type Scope = string

export interface HeraTenantDb {
  readonly orgId: OrgId
  readonly exec?: (
    sql: string,
    params?: ReadonlyArray<unknown>,
    ...bindings: ReadonlyArray<unknown>
  ) => unknown
  readonly query?: <T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
    ...bindings: ReadonlyArray<any>
  ) => Effect.Effect<ReadonlyArray<T>, any>
  readonly transactSync?: (...args: ReadonlyArray<any>) => unknown
  readonly transactWithOutbox?: (...args: ReadonlyArray<any>) => unknown
  readonly enqueueOutbox?: (...args: ReadonlyArray<any>) => unknown
  readonly [key: string]: unknown
}

export interface HeraTenantResolvedDb extends HeraTenantDb {
  readonly orgId: OrgId
  readonly exec: (
    sql: string,
    params?: ReadonlyArray<unknown>,
    ...bindings: ReadonlyArray<unknown>
  ) => unknown
  readonly query: <T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
    ...bindings: ReadonlyArray<any>
  ) => Effect.Effect<ReadonlyArray<T>, any>
}

export interface HeraPublicCtxShape {
  readonly requestId: RequestId
  readonly service: string
  readonly logger: HeraLogger
  readonly now: Effect.Effect<number>
}

export interface HeraPublicCtxInput {
  readonly requestId: RequestId
  readonly service: string
  readonly logger?: HeraLogger | undefined
  readonly now?: Effect.Effect<number> | undefined
  readonly sink?: LogSink | undefined
  readonly whitelistedErrorCodes?:
    | ReadonlySet<string>
    | ReadonlyArray<string>
    | undefined
}

export interface HeraAuthedCtxShape extends HeraPublicCtxShape {
  readonly orgId: OrgId
  readonly actorId: ActorId
  readonly actorKind: ActorKind
  readonly scopes: ReadonlySet<Scope>
  readonly productCtx: Readonly<Record<string, unknown>>
}

export interface HeraAuthedCtxInput {
  readonly requestId: RequestId
  readonly service: string
  readonly orgId: OrgId
  readonly actorId: ActorId
  readonly actorKind?: ActorKind | undefined
  readonly scopes?: Iterable<Scope> | ReadonlySet<Scope> | undefined
  readonly productCtx?: Readonly<Record<string, unknown>> | undefined
  readonly logger?: HeraLogger | undefined
  readonly now?: Effect.Effect<number> | undefined
  readonly sink?: LogSink | undefined
  readonly whitelistedErrorCodes?:
    | ReadonlySet<string>
    | ReadonlyArray<string>
    | undefined
}

export interface HeraCtxShape {
  readonly requestId: RequestId
  readonly actorId: Option.Option<ActorId>
  readonly orgId: Option.Option<OrgId>
  readonly service: string
  readonly logger?: HeraLogger | undefined
  readonly now?: Effect.Effect<number> | undefined
}

export interface HeraTenantCtxShape {
  readonly requestId: RequestId
  readonly actorId: Option.Option<ActorId>
  readonly orgId: OrgId
  readonly service: string
  readonly actorKind?: HeraActorKind | undefined
  readonly scopes?: ReadonlyArray<string> | undefined
  readonly db?: HeraTenantDb | undefined
  readonly logger?: HeraLogger | undefined
  readonly scheduleDomainAlarm?:
    | ((atMs: number) => Effect.Effect<void>)
    | undefined
  readonly now?: Effect.Effect<number> | undefined
}

export interface HeraTenantCtxService {
  readonly orgId: OrgId
  readonly db: HeraTenantResolvedDb
  readonly logger: HeraLogger
  readonly scheduleDomainAlarm: (atMs: number) => Effect.Effect<void>
  readonly requestId: RequestId
  readonly actorId: Option.Option<ActorId>
  readonly service: string
  readonly now: Effect.Effect<number>
  readonly actorKind?: HeraActorKind | undefined
  readonly scopes?: ReadonlyArray<string> | undefined
}

export interface HeraTenantCtxInput {
  readonly orgId: OrgId
  readonly service?: string | undefined
  readonly requestId?: RequestId | undefined
  readonly actorId?: Option.Option<ActorId> | ActorId | null | undefined
  readonly actorKind?: HeraActorKind | undefined
  readonly scopes?: ReadonlyArray<string> | undefined
  readonly db?: HeraTenantDb | undefined
  readonly logger?: HeraLogger | undefined
  readonly scheduleDomainAlarm?:
    | ((atMs: number) => Effect.Effect<void>)
    | undefined
  readonly now?: Effect.Effect<number> | undefined
  readonly sink?: LogSink | undefined
  readonly whitelistedErrorCodes?:
    | ReadonlySet<string>
    | ReadonlyArray<string>
    | undefined
}

