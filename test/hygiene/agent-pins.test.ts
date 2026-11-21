import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * The agent plane's pins move as one group: `agents` and every `@earendil-works/*`
 * package are exact, the Pi packages share one version, and the lockfile resolves each of them
 * (nested copies included) to that version. `agents` declares `~` ranges on chord, pi-ai and
 * pi-durable, so a bump of one member alone could otherwise resolve two Pi versions side by side.
 * The group is an optional peer set: a CLI-only consumer never installs it, a `/agent`
 * consumer installs the exact versions named here, and hera's own dev install runs those same pins.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../..")
const PI_SCOPE = "@earendil-works/"
const EXACT = /^\d+\.\d+\.\d+$/

const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
  readonly dependencies: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
}
const lock = fs.readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8")

/** Every `"<key>": ["<name>@<version>"` package entry of `bun.lock` whose name is `name`. */
function lockedVersions(name: string): ReadonlyArray<{ readonly key: string; readonly version: string }> {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  const entry = new RegExp(`^\\s+"((?:[^"]+/)?${escaped})": \\["${escaped}@([^"]+)"`, "gm")
  return [...lock.matchAll(entry)].map((m) => ({ key: m[1] ?? "", version: m[2] ?? "" }))
}

const group = Object.entries(manifest.peerDependencies ?? {}).filter(
  ([name]) => name === "agents" || name.startsWith(PI_SCOPE)
)
const piPins = group.filter(([name]) => name.startsWith(PI_SCOPE))

describe("agent plane pins", () => {
  // admits: a range (`^1.4.0`) lets a consumer resolve a Pi version hera never ran; a dev pin that
  // differs from the peer pin means hera tests a version consumers are not told to install.
  it("pins agents and every @earendil-works package exactly, as optional peers hera's dev install matches", () => {
    expect(group.map(([name]) => name)).toEqual(
      expect.arrayContaining(["agents", "@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/pi-telemetry"])
    )
    for (const [name, spec] of group) {
      expect(spec, name).toMatch(EXACT)
      expect(manifest.peerDependenciesMeta?.[name]?.optional, name).toBe(true)
      expect(manifest.devDependencies?.[name], name).toBe(spec)
    }
    expect(Object.keys(manifest.dependencies).filter((n) => n === "agents" || n.startsWith(PI_SCOPE))).toEqual([])
  })

  // admits: bumping one Pi package alone; pi-durable 1.4.0 pins its siblings exactly, so a split breaks it.
  it("keeps every @earendil-works pin on one version", () => {
    expect(new Set(piPins.map(([, spec]) => spec)).size).toBe(1)
  })

  // admits: package.json and the lockfile disagreeing, or a nested second copy of a Pi package.
  it("resolves each group member in bun.lock, nested copies included, to its pin", () => {
    const piVersion = piPins[0]?.[1]
    const lockedPi = [...lock.matchAll(/^\s+"((?:[^"]+\/)?@earendil-works\/[a-z-]+)": \["(@earendil-works\/[a-z-]+)@([^"]+)"/gm)]
    expect(lockedPi.length).toBeGreaterThanOrEqual(piPins.length)
    for (const m of lockedPi) expect(m[3], m[1]).toBe(piVersion)
    for (const [name, spec] of group) {
      const locked = lockedVersions(name)
      expect(locked.length, name).toBeGreaterThan(0)
      for (const l of locked) expect(l.version, l.key).toBe(spec)
    }
  })
})
