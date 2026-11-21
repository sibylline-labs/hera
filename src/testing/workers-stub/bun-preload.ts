import * as cloudflareWorkers from "./cloudflare-workers.js"

/**
 * `bun test` preload that resolves `cloudflare:workers` to the Hera stub, so a test can import a
 * `TenantDurableObject` subclass. Add it to `bunfig.toml`:
 * `[test] preload = ["@sibylline-labs/hera/testing/bun-preload"]`.
 */
interface BunPluginBuilder {
  module(id: string, load: () => { exports: Record<string, unknown>; loader: "object" }): void
}

const bun = (
  globalThis as {
    readonly Bun?: { plugin(options: { name: string; setup(build: BunPluginBuilder): void }): void }
  }
).Bun

bun?.plugin({
  name: "hera-cloudflare-workers-stub",
  setup(build) {
    build.module("cloudflare:workers", () => ({ exports: { ...cloudflareWorkers }, loader: "object" }))
  },
})
