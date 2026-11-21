import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * hera's telemetry is pure TypeScript over Effect and fetch: the OpenTelemetry SDK is not a
 * dependency at any level, so a consumer's Worker never carries it.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../..")
const OTEL = "@opentelemetry/"

type DependencyMap = Readonly<Record<string, string>>
const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as Readonly<
  Record<"dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies", DependencyMap | undefined>
>
const lock = fs.readFileSync(path.join(REPO_ROOT, "bun.lock"), "utf8")

describe("no OpenTelemetry packages", () => {
  // admits: a manifest is JSON, so no type or ast-grep rule sees a dependency re-added by hand.
  it("declares no @opentelemetry/* package in any dependency map", () => {
    const declared = (["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const).flatMap(
      (field) => Object.keys(manifest[field] ?? {}).filter((name) => name.startsWith(OTEL)).map((name) => `${field}: ${name}`)
    )
    expect(declared).toEqual([])
  })

  // admits: a transitive install (a dependency that pulls the SDK) shows only in the lockfile; vitest's optional-peer mention is not a package entry.
  it("resolves no @opentelemetry/* package in bun.lock", () => {
    const entries = [...lock.matchAll(/^\s+"(@opentelemetry\/[^"]+)": \["/gm)].map((match) => match[1])
    expect(entries).toEqual([])
  })
})
