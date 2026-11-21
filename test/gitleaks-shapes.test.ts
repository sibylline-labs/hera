import { describe, expect, it } from "vitest"
import { GITLEAKS_FIXTURES as FIXTURES } from "./fixtures/gitleaks-secrets.js"
import { GITLEAKS_RULES, GITLEAKS_SHAPES, scrubCredentialRuns } from "../src/core/logger/index.js"

describe("GITLEAKS_RULES", () => {
  // admits: a rule added to GITLEAKS_RULES without a fixture would ship untested; no type ties the two tables.
  it("has a fixture for every rule id", () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(GITLEAKS_RULES.map((r) => r.id).sort())
  })

  // admits: each gitleaks pattern must replace its own token shape in place; regex coverage is runtime data no type or lint sees.
  it.each(GITLEAKS_RULES.map((r) => [r.id] as const))("replaces a %s in place", (id) => {
    const secret = FIXTURES[id]!
    const out = scrubCredentialRuns(`before ${secret} after`, GITLEAKS_SHAPES)
    expect(out).not.toContain(secret.slice(4, 30))
    expect(out.startsWith("before ")).toBe(true)
    expect(out.endsWith(" after")).toBe(true)
    expect(out).toContain("[REDACTED]")
  })

  // admits: over-broad heads would blank git SHAs and short tokens in every log line; only a negative case shows it.
  it("leaves lookalikes readable", () => {
    const text = "ghp_short, sha 3f786850e387550fdab836ed7e6dc881de23001b, AKIA-too-short, sk_live_x"
    expect(scrubCredentialRuns(text, GITLEAKS_SHAPES)).toBe(text)
  })

  // admits: a global regex keeps lastIndex between calls; a stateful shape would miss the second secret in a process.
  it("is reusable across calls (global shapes keep no lastIndex state)", () => {
    const secret = FIXTURES["github-pat"]!
    for (let i = 0; i < 3; i++) {
      expect(scrubCredentialRuns(secret, GITLEAKS_SHAPES)).toBe("[REDACTED]")
    }
  })
})
