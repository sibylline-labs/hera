/**
 * Stand-in for the workerd-only `cloudflare:workers` module, for code that runs a Hera Durable
 * Object outside workerd (vitest under Node, `bun test`). Each base class keeps the constructor
 * arguments the way workerd's does, so `TenantDurableObject` subclasses read `ctx` and `env`.
 *
 * Vitest: `resolve.alias: { "cloudflare:workers": "@sibylline-labs/hera/testing/cloudflare-workers" }`.
 * Bun: preload `@sibylline-labs/hera/testing/bun-preload`.
 */
export class DurableObject<Env = unknown> {
  protected ctx: unknown
  protected env: Env

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown
  protected env: Env

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx
    this.env = env
  }
}

export class RpcTarget {}

export const env: Record<string, unknown> = {}
