import { createHash, randomBytes } from "node:crypto"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import { createHeraLogger, HeraObjectStore, REDACTED_VALUE, scrubLogString } from "../src/index"

const ULID = "01HZX3Q4W5E6R7T8Y9A0B1C2D3"

/** A base64url secret as a minter draws one: the part of a credential that must never be readable. */
function secret(): string {
  return randomBytes(32).toString("base64url")
}

function capture(options: { secretKeys?: RegExp; secretShapes?: ReadonlyArray<RegExp> } = {}) {
  const lines: Array<string> = []
  const logger = createHeraLogger({
    service: "redaction-test",
    sink: (line) => {
      lines.push(line)
    },
    ...options,
  })
  const write = (fields: Record<string, unknown>): { text: string; line: Record<string, unknown> } => {
    Effect.runSync(logger.error("upstream_failed", fields))
    expect(lines).toHaveLength(1)
    const text = lines[0]!
    return { text, line: JSON.parse(text) as Record<string, unknown> }
  }
  return write
}

/** One credential of each shape Hera knows; `leak` must never be readable in a line. */
const SHAPES: ReadonlyArray<readonly [string, () => { logged: string; leak: string }]> = [
  ["a sib_ token", () => {
    const s = secret()
    return { logged: `sib_${ULID}_${s}`, leak: s }
  }],
  ["a Linear OAuth token", () => {
    const s = secret()
    return { logged: `lin_oauth_${s}`, leak: s }
  }],
  ["a Linear API key", () => {
    const s = secret()
    return { logged: `lin_api_${s}`, leak: s }
  }],
  ["a Bearer value with underscores", () => {
    const s = `SEC_${secret()}_END`
    return { logged: `Bearer ${s}`, leak: s }
  }],
  ["a SHA-256 hash", () => {
    const h = createHash("sha256").update(secret()).digest("hex")
    return { logged: h, leak: h }
  }],
]

describe("HeraLogger value-shape redaction", () => {
  // admits: a credential inside a string, array or key reaches the line; value shapes are runtime data no type sees
  it.each(SHAPES)("%s is redacted wherever it sits in a string, keeping the text around it", (_label, build) => {
    // When a credential rides inside a string (a runtime error quoting its input, a nested field, a
    // map key), a key rule cannot see it and it reaches the log verbatim: observed at the raw text.
    const { logged, leak } = build()
    const { text, line } = capture()({
      detail: `refused ${logged} twice`,
      attempts: [{ n: 1, body: logged }],
      counts: { [logged]: 1 },
      byKey: new Map([[logged, 2]]),
    })
    expect(text).not.toContain(leak)
    expect(line.detail).toBe(`refused ${REDACTED_VALUE} twice`)
    expect(line.attempts).toEqual([{ n: 1, body: REDACTED_VALUE }])
    expect(line.counts).toEqual({ [REDACTED_VALUE]: 1 })
    expect(line.byKey).toEqual({ [REDACTED_VALUE]: 2 })
  })

  // admits: an Error's name, code or _tag carries a credential past the message rule; runtime values
  it("a credential in an Error's name, code or _tag never reaches the line", () => {
    const s = secret()
    const err = Object.assign(new Error("x"), { name: `sib_${ULID}_${s}`, code: `lin_api_${s}`, _tag: `TagError lin_api_${s}` })
    const { text, line } = capture()({ err, wrapped: new Error("y", { cause: err }) })
    expect(text).not.toContain(s)
    expect(line.err).toMatchObject({ name: REDACTED_VALUE, code: "unclassified_error" })
  })

  // admits: a credential glued to a field prefix (`key_sib_...`) slips past a word-boundary anchor; runtime data
  it("a credential head glued to a prefix with an underscore is still redacted", () => {
    const s = secret()
    const { text, line } = capture()({ detail: `key_sib_${ULID}_${s} and key_lin_api_${s}` })
    expect(text).not.toContain(s)
    expect(line.detail).toBe(`key_${REDACTED_VALUE} and key_${REDACTED_VALUE}`)
  })

  // admits: shapes match wider than a credential and blank monitor fields; runtime data
  it("text that merely resembles a credential stays readable", () => {
    // When the shapes match wider than a credential, the fields a monitor selects on go blank (a
    // limiter key, an org id, a git SHA): observed at the parsed line.
    const sha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3"
    const fields = {
      prefix: `sib_${ULID}`,
      subject: ULID,
      commit: sha,
      note: "token refreshed for lin_ workspace",
    }
    expect(capture()(fields).line).toMatchObject(fields)
  })

  // admits: a function's source or symbol description is written as text; runtime values
  it("a function or symbol value is dropped, never written as its source", () => {
    // When a function reaches the writer as text, a credential in its body reaches the log: observed
    // at the raw text.
    const { text, line } = capture()({
      onRetry: () => "Bearer LEAKFN",
      tag: Symbol("LEAKSYM"),
      nested: [{ cb: () => "LEAKNESTED" }],
    })
    for (const leak of ["LEAKFN", "LEAKSYM", "LEAKNESTED"]) {
      expect(text).not.toContain(leak)
    }
    expect(line.nested).toEqual([{}])
    expect(line).not.toHaveProperty("onRetry")
  })

  // admits: consumer rules replace Hera's instead of adding to them; runtime merge of two rule sets
  it("a consumer's key and shape rules redact on top of Hera's, never instead of them", () => {
    // When a consumer's rules replace Hera's, a name only Hera knows (`passwd`) or a shape only the
    // consumer mints (`sibdc_`) reaches the log: observed at the raw text.
    const deviceSecret = secret()
    const write = capture({
      secretKeys: /key|hash|kek|dek|sealed/i,
      secretShapes: [/sibdc_[BCDFGHJKLMNPQRSTVWXZ]{8}_[A-Za-z0-9_-]+/],
    })
    const { text, line } = write({
      r2_key: "r2-1",
      content_hash: "ch-2",
      wrapped_dek: "wd-3",
      passwd: "pw-4",
      detail: `device sibdc_BCDFGHJK_${deviceSecret} expired`,
    })
    for (const leak of ["r2-1", "ch-2", "wd-3", "pw-4", deviceSecret]) {
      expect(text).not.toContain(leak)
    }
    expect(line.detail).toBe(`device ${REDACTED_VALUE} expired`)
  })

  // admits: a `g` key pattern skips every other key via lastIndex; RegExp state is invisible to types
  it("a stateful (global) consumer key pattern tests every key whole", () => {
    // When a `g` pattern's lastIndex carries over between keys, every other key slips through.
    const { text } = capture({ secretKeys: /kek/g })({ kek: "k-1", kek_2: "k-2", kek_3: "k-3" })
    for (const leak of ["k-1", "k-2", "k-3"]) {
      expect(text).not.toContain(leak)
    }
  })

  // admits: the run pass replaces the whole-string rule instead of preceding it; runtime string handling
  it("scrubLogString keeps its whole-string rule for prefixes it has no run shape for", () => {
    expect(scrubLogString("key sk_live_abcDEF123 refused")).toBe(REDACTED_VALUE)
    expect(scrubLogString("plain text")).toBe("plain text")
  })
})

describe("HeraObjectStore credentials through the logger", () => {
  // admits: an R2 token or derived S3 secret readable in a log line; Redacted.value is legal TS, so only the line shows a leak
  it("logging the r2S3 config, derived credentials and a store failure leaks no secret", async () => {
    const token = secret()
    const accessKeySecret = secret()
    const derived = createHash("sha256").update(token).digest("hex")
    const credentials = {
      accessKeyId: Redacted.make("tok_probe_id"),
      secretAccessKey: Redacted.make(accessKeySecret),
    }
    const fetch = (async () =>
      new Response(`<Error><Code>AccessDenied</Code><Message>${token}</Message></Error>`, { status: 403 })) as typeof globalThis.fetch
    const config = { accountId: "acct", bucket: "scratch", credentials, fetch }
    const failure = await Effect.runPromise(Effect.flip(HeraObjectStore.r2S3(config).get("k")))
    const { text } = capture()({
      config,
      apiToken: Redacted.make(token),
      derived: { accessKeyId: Redacted.make("tok_probe_id"), secretAccessKey: Redacted.make(derived) },
      error: failure,
    })
    for (const leak of [token, accessKeySecret, derived]) {
      expect(text).not.toContain(leak)
    }
    expect(text).toContain('"code":"upstream_error"')
  })
})
