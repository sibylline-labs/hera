import { createHash, randomBytes } from "node:crypto"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { createHeraLogger, ERROR_MESSAGE_LIMIT, REDACTED_VALUE } from "../src/index"

const ULID = "01HZX3Q4W5E6R7T8Y9A0B1C2D3"

function secret(): string {
  return randomBytes(32).toString("base64url")
}

function write(fields: Record<string, unknown>): { text: string; line: Record<string, unknown> } {
  const lines: Array<string> = []
  const logger = createHeraLogger({
    service: "error-message-test",
    events: ["upstream_failed"] as const,
    errorMessages: "scrubbed",
    sink: (line) => {
      lines.push(line)
    },
  })
  // A child, as consumers log through one: the option must survive `child`.
  Effect.runSync(logger.child({ hook: "drain" }).error("upstream_failed", fields))
  expect(lines).toHaveLength(1)
  const text = lines[0]!
  return { text, line: JSON.parse(text) as Record<string, unknown> }
}

/** Every `n`-character window of `value`: a cut that kept any of them kept part of the credential. */
function fragments(value: string, n: number): Array<string> {
  return Array.from({ length: value.length - n + 1 }, (_, i) => value.slice(i, i + n))
}

describe("HeraLogger errorMessages: \"scrubbed\"", () => {
  // admits: an Error field loses the reason operators triage by; the message is runtime data
  it("an Error's plain message is written, its cause's too, with name and code kept", () => {
    const err = new Error("Linear 500: upstream down", { cause: new Error("socket hang up") })
    const { line } = write({ error: err })
    expect(line.error).toEqual({
      name: "Error",
      code: "unclassified_error",
      message: "Linear 500: upstream down",
      cause: { name: "Error", code: "unclassified_error", message: "socket hang up" },
    })
  })

  // admits: a credential quoted in an Error's message reaches the line once messages are kept; runtime data
  it("a credential-shaped run inside the message is redacted in place, and in name and _tag", () => {
    const s = secret()
    const err = Object.assign(new Error(`refused sib_${ULID}_${s} at gateway`), {
      name: `lin_api_${s}`,
      _tag: `TagError lin_api_${s}`,
    })
    const { text, line } = write({ error: err })
    expect(text).not.toContain(s)
    expect(line.error).toMatchObject({
      name: REDACTED_VALUE,
      message: `refused ${REDACTED_VALUE} at gateway`,
    })
  })

  // admits: a string cause (`{ cause: "timeout" }`) carries the reason but is blanked; runtime data
  it("a string cause is scrubbed and kept like a message", () => {
    const s = secret()
    const { text, line } = write({ error: new Error("fetch failed", { cause: `timeout Bearer ${s}` }) })
    expect(text).not.toContain(s)
    expect(line.error).toMatchObject({ message: "fetch failed", cause: `timeout ${REDACTED_VALUE}` })
  })

  // admits: a message an upstream echoes whole (a 10k body) floods the line; length is runtime data
  it("a 10k-character message is bounded after the scrub", () => {
    const s = secret()
    const { text, line } = write({ error: new Error(`${"x".repeat(10_000)} Bearer ${s}`) })
    expect(text).not.toContain(s)
    expect(line.error).toMatchObject({ message: "x".repeat(ERROR_MESSAGE_LIMIT) })
  })

  // admits: cut-then-scrub leaves the front of a credential no whole-shape rule matches; runtime order
  it.each([
    ["a SHA-256 hash", () => createHash("sha256").update(secret()).digest("hex"), (c: string) => c],
    ["a sib_ token", () => `sib_${ULID}_${secret()}`, (c: string) => c.slice(4)],
  ])("%s straddling the cut is wholly redacted, no prefix survives", (_label, build, readable) => {
    const credential = build()
    // Neither a hex digit nor a letter, so the filler never joins the hash's run or masks the
    // `sib_` head; a cut at the limit lands 20 characters into the credential.
    const filler = ".".repeat(ERROR_MESSAGE_LIMIT - 20)
    const { text, line } = write({ error: new Error(`${filler}${credential} tail`) })
    for (const fragment of fragments(readable(credential), 8)) {
      expect(text).not.toContain(fragment)
    }
    const message = (line.error as { message: string }).message
    expect(message.length).toBeLessThanOrEqual(ERROR_MESSAGE_LIMIT)
    expect(message).toBe(`${filler}${REDACTED_VALUE} tail`)
  })
})
