import * as Schema from "effect/Schema"
import { HeraError } from "../../core/errors/index.js"
import { HeraDurableObjectBase } from "./base-do.js"
import type { HeraTenantDurableObjectOptions } from "./types.js"

/** Fail-closed error when a `KeyedDurableObject`'s `ctx.id.name` is missing or its key codec refuses it. */
export const DurableObjectKeyError = HeraError.define("DurableObjectKeyError", {
  code: "invalid_subject",
  publicMessage: "Durable Object instance does not have a valid key",
  fields: { reason: Schema.String },
})
export type DurableObjectKeyError = InstanceType<typeof DurableObjectKeyError>

/** Options of a `KeyedDurableObject`: the tenant options plus the codec that decodes its key. */
export interface HeraKeyedDurableObjectOptions<Key extends string = string>
  extends Omit<HeraTenantDurableObjectOptions, "runKeyed"> {
  /** Decodes `ctx.id.name` into the object's key; throw `DurableObjectKeyError` to refuse it. */
  readonly key?: ((rawName: string | undefined) => Key) | undefined
}

/** The default key codec: any non-empty `ctx.id.name`; an anonymous id has no key. */
export function requireDurableObjectName(rawName: string | undefined): string {
  if (typeof rawName !== "string" || rawName.length === 0) {
    throw new DurableObjectKeyError({
      reason:
        "Durable Object ctx.id.name is missing (anonymous DO instances are not permitted for KeyedDurableObject)",
    })
  }
  return rawName
}

/**
 * Base class for Durable Objects that are not per-org: a pointer, a registry, a device
 * code. Same migrations, `this.db`/`SyncTx`, logger, outbox, jobs and composite alarm as
 * `TenantDurableObject`; its identity is `ctx.id.name` decoded by `options.key` instead of an `OrgId`.
 * Logs carry `doId` (`ctx.id.toString()`), never the key, which can be a token hash.
 */
export abstract class KeyedDurableObject<
  Env = Record<string, unknown>,
  Key extends string = string,
> extends HeraDurableObjectBase<Env, Key> {
  constructor(ctx: DurableObjectState, env: Env, options?: HeraKeyedDurableObjectOptions<Key>) {
    const decode = options?.key ?? (requireDurableObjectName as (rawName: string | undefined) => Key)
    super(ctx, env, options, (rawName) => ({
      key: decode(rawName),
      logFields: { doId: String(ctx.id) },
    }))
  }

  static configure<Env = Record<string, unknown>, Key extends string = string>(
    defaultOptions: HeraKeyedDurableObjectOptions<Key>
  ) {
    abstract class ConfiguredKeyedDurableObject extends KeyedDurableObject<Env, Key> {
      constructor(ctx: DurableObjectState, env: Env, overrides?: HeraKeyedDurableObjectOptions<Key>) {
        super(ctx, env, {
          ...defaultOptions,
          ...overrides,
          migrations: overrides?.migrations ?? defaultOptions.migrations,
        })
      }
    }
    return ConfiguredKeyedDurableObject
  }
}
