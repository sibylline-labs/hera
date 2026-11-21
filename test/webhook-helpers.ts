import * as Exit from "effect/Exit"
import { HeraError, HeraWebhook, type HeraWebhookOptions } from "../src/index"
import { HeraTest } from "../src/testing/index"

export const NOW_MS = 1_730_000_000_000
export const NOW_S = NOW_MS / 1000

const encoder = new TextEncoder()

export async function hmacHex(key: string, signed: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(signed)))
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function post(body: string, headers: Record<string, string>): Request {
  return new Request("https://gateway.test/v1/webhooks", { method: "POST", headers, body })
}

async function run(verify: (request: Request) => ReturnType<ReturnType<typeof HeraWebhook.verifyHmac>>, req: Request) {
  return HeraTest.runTestExit(verify(req), HeraTest.layer({ initialTimeMs: NOW_MS }))
}

type Verifier = ReturnType<typeof HeraWebhook.verifyHmac>

export async function admitted(verify: Verifier, req: Request): Promise<string> {
  const exit = await run(verify, req)
  if (!Exit.isSuccess(exit)) throw new Error(`expected success, got ${String(exit)}`)
  return new TextDecoder().decode(exit.value)
}

export async function refusedWith(verify: Verifier, req: Request): Promise<string | undefined> {
  const exit = await run(verify, req)
  if (!Exit.isFailure(exit)) throw new Error("expected a refusal")
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error
  if (!HeraError.is(error)) throw new Error("expected a HeraError")
  return HeraWebhook.refusalReason(error)
}

export type { HeraWebhookOptions }
