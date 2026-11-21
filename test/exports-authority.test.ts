import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as AgentSubpath from "../src/server/agent/index.js"

interface PackageJson {
  readonly exports: Readonly<Record<string, { readonly default: string }>>
}

const root = join(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageJson

/** Subpaths whose module graph loads only under workerd; the type check below covers them. */
const WORKERD_ONLY = new Set(["./agent"])
/** Side-effect entry points with no exports at all. */
const SIDE_EFFECT_ONLY = new Set(["./testing/bun-preload"])

describe("authority ctx constructor stays boundary-internal", () => {
  // admits: integration — the real module graph behind every published subpath; a re-export added
  // to any barrel would let a consumer mint a granted `HeraAuthorityCtx` without a verifier.
  it.each(Object.entries(pkg.exports).filter(([subpath]) => !WORKERD_ONLY.has(subpath)))(
    "%s does not export grantAuthorityCtx",
    async (subpath, target) => {
      const mod = (await import(join(root, target.default))) as Record<string, unknown>
      if (!SIDE_EFFECT_ONLY.has(subpath)) expect(Object.keys(mod).length).toBeGreaterThan(0)
      expect("grantAuthorityCtx" in mod).toBe(false)
      // Namespace objects (`Hera`, `HeraTest`, `HeraCli`, ...) must not carry it either.
      for (const value of Object.values(mod)) {
        if (typeof value === "object" && value !== null) expect("grantAuthorityCtx" in value).toBe(false)
      }
    }
  )

  // admits: integration — `./agent` loads only under workerd, so tsc over its real barrel holds the
  // same property; the expectTypeOf fails the typecheck if the barrel ever re-exports the constructor.
  it("covers the workerd-only subpaths at the type level", () => {
    expect([...WORKERD_ONLY].every((subpath) => subpath in pkg.exports)).toBe(true)
    expectTypeOf<"grantAuthorityCtx" extends keyof typeof AgentSubpath ? true : false>().toEqualTypeOf<false>()
  })
})
