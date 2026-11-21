import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import fc from "fast-check"
import { describe, expect, test } from "vitest"
import {
  describeException,
  exceptionFingerprint,
  frameFunctions,
  HeraTelemetry,
  scrubExceptionStack,
} from "../src/core/telemetry/index.js"
import { toAttributes } from "../src/core/telemetry/otlp-values.js"
import { GITLEAKS_FIXTURES } from "./fixtures/gitleaks-secrets.js"

/**
 * No secret-corpus run and no raw message survives the stack scrubber, the fingerprint or the
 * OTLP payload. Each message carries a unique marker; the marker stands for "any
 * caller text", the corpus entry for "a credential".
 */
const secrets = Object.values(GITLEAKS_FIXTURES)
const secretArb = fc.constantFrom(...secrets)
const markerArb = fc.stringMatching(/^[A-Za-z0-9]{12}$/).map((s) => `MSG${s}MSG`)
const fnArb = fc.stringMatching(/^[A-Za-z_$][A-Za-z0-9_$]{0,20}$/)

function v8Stack(name: string, message: string, frames: ReadonlyArray<string>, secret: string): string {
  const lines = frames.map((fn, i) =>
    i % 2 === 0
      ? `    at ${fn} (https://worker.example/index.js?token=${encodeURIComponent(secret)}:${i + 1}:${i + 7})`
      : `    at ${fn} (index.js:${i + 1}:${i + 3})`
  )
  return [`${name}: ${message}`, ...lines].join("\n")
}

function leaks(text: string, marker: string, secret: string): boolean {
  return text.includes(marker) || text.includes(secret) || text.includes(encodeURIComponent(secret))
}

describe("scrubExceptionStack, exceptionFingerprint and OTLP serialization never carry raw text", () => {
  // admits: free text from arbitrary errors; no type or lint sees runtime strings
  test("stack and fingerprint", () => {
    fc.assert(
      fc.property(markerArb, secretArb, fc.array(fnArb, { minLength: 1, maxLength: 12 }), (marker, secret, fns) => {
        const message = `failed for ${secret} ${marker}\nsecond line ${marker}`
        const stack = v8Stack("TypeError", message, fns, secret)
        const scrubbed = scrubExceptionStack(stack, "TypeError")
        expect(scrubbed.split("\n")[0]).toBe("TypeError: [REDACTED]")
        expect(leaks(scrubbed, marker, secret)).toBe(false)
        const fingerprint = exceptionFingerprint({ type: "TypeError", frames: frameFunctions(scrubbed) })
        expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)
        expect(leaks(fingerprint, marker, secret)).toBe(false)
      }),
      { numRuns: 200 }
    )
  })

  // admits: the payload is built from the live span and log path, which only a run exercises
  test("OTLP payloads of a dying, error-logging invocation", async () => {
    await fc.assert(
      fc.asyncProperty(markerArb, secretArb, async (marker, secret) => {
        const bodies: Array<string> = []
        const telemetry = HeraTelemetry.make({
          service: "prop",
          environment: "test",
          sink: { baseUrl: "https://logfire.test", token: Redacted.make("write-token") },
          fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
            bodies.push(String(init?.body ?? ""))
            return new Response("{}", { status: 200 })
          }) as typeof fetch,
          random: () => 0.5,
        })
        const pending: Array<Promise<unknown>> = []
        const invocation = telemetry.begin({ name: "prop", source: "external", waitUntil: (p) => void pending.push(p) })
        // Log bodies and span names are code-chosen text: only the secret must not survive there.
        const program = Effect.logError(`raw ${secret}`).pipe(
          Effect.andThen(Effect.sync(() => {
            throw new Error(`boom ${secret} ${marker}`)
          })),
          Effect.withSpan(`span ${secret}`)
        )
        await Effect.runPromiseExit(invocation.provide(program))
        invocation.end({ defect: true })
        await Promise.all(pending)
        expect(bodies.length).toBe(2)
        for (const body of bodies) {
          expect(leaks(body, marker, secret)).toBe(false)
        }
      }),
      { numRuns: 50 }
    )
  })

  // admits: an error name is caller text; an identifier-shaped credential (ghp_…, AKIA…) passed the identifier check and left as exception.type.
  test.each(Object.entries(GITLEAKS_FIXTURES).filter(([, secret]) => /^[A-Za-z_$][\w$.]{0,63}$/.test(secret)))(
    "an identifier-shaped %s as the error name exports as Error",
    (_id, secret) => {
      const described = describeException(Object.assign(new Error("x"), { name: secret }), { secretShapes: [] })
      expect(described.type).toBe("Error")
      expect(described.stacktrace).not.toContain(secret)
    }
  )

  // admits: key redaction covered strings only, so a credential-named array of plain values left verbatim; a value's type is runtime data.
  test("a string array under a credential-named key exports redacted", () => {
    const out = toAttributes({ password: ["hunter2plain"], tags: ["a"] }, { secretShapes: [] })
    expect(out).toEqual([
      { key: "password", value: { stringValue: "[REDACTED]" } },
      { key: "tags", value: { arrayValue: { values: [{ stringValue: "a" }] } } },
    ])
  })
})
