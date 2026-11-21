import { createHash } from "node:crypto"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { describe, expect, it } from "vitest"
import { HeraObjectStore } from "../src/core/object-store/index"
import { HeraTest } from "../src/testing/index"

const TOKEN = "cf-test-token-value"

function verifyFetch(answers: Record<string, number>) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    seen.push({ url, headers: Object.fromEntries(new Headers(init?.headers)) })
    const path = new URL(url).pathname
    const status = answers[path] ?? 404
    return status === 200
      ? Response.json({ success: true, errors: [], messages: [], result: { id: "tok_123", status: "active" } })
      : Response.json({ success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, { status })
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

describe("HeraObjectStore.credentialsFromApiToken", () => {
  // admits: the derived key pair not matching R2's documented derivation, or leaving Redacted; runtime values
  it("derives access key id = token id and secret = SHA-256 hex of the token, both Redacted", async () => {
    const { fetch, seen } = verifyFetch({ "/client/v4/user/tokens/verify": 200 })
    const creds = await HeraTest.runTest(
      HeraObjectStore.credentialsFromApiToken({ apiToken: Redacted.make(TOKEN), fetch })
    )
    expect(Redacted.isRedacted(creds.accessKeyId)).toBe(true)
    expect(Redacted.value(creds.accessKeyId)).toBe("tok_123")
    expect(Redacted.value(creds.secretAccessKey)).toBe(createHash("sha256").update(TOKEN).digest("hex"))
    expect(seen).toEqual([
      { url: "https://api.cloudflare.com/client/v4/user/tokens/verify", headers: { authorization: `Bearer ${TOKEN}` } },
    ])
  })

  // admits: an account-owned token refused because only the user endpoint was tried; endpoint choice is runtime
  it("falls back to the account endpoint when the user endpoint refuses", async () => {
    const { fetch, seen } = verifyFetch({ "/client/v4/accounts/acct_9/tokens/verify": 200 })
    const creds = await HeraTest.runTest(
      HeraObjectStore.credentialsFromApiToken({ apiToken: Redacted.make(TOKEN), accountId: "acct_9", fetch })
    )
    expect(Redacted.value(creds.accessKeyId)).toBe("tok_123")
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      "/client/v4/user/tokens/verify",
      "/client/v4/accounts/acct_9/tokens/verify",
    ])
  })

  // admits: a refused token surfacing as an untyped failure or echoing the token; runtime mapping
  it("fails upstream_error when both endpoints refuse, without the token", async () => {
    const { fetch } = verifyFetch({})
    const err = await HeraTest.runTest(
      Effect.flip(
        HeraObjectStore.credentialsFromApiToken({ apiToken: Redacted.make(TOKEN), accountId: "acct_9", fetch })
      )
    )
    expect(err.code).toBe("upstream_error")
    expect(err.fields).toMatchObject({ op: "credentials", status: 404 })
    expect(JSON.stringify(err)).not.toContain(TOKEN)
  })
})
