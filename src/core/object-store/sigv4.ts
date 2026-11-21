import * as Redacted from "effect/Redacted"
import { encodeRfc3986 } from "./metadata.js"

/** An S3 key pair; neither half leaves `Redacted` except inside `signSigV4`. */
export interface HeraS3Credentials {
  readonly accessKeyId: Redacted.Redacted<string>
  readonly secretAccessKey: Redacted.Redacted<string>
}

export interface SigV4Input {
  readonly method: string
  readonly url: string
  /** Every header the request will send, except `host` (taken from `url`). */
  readonly headers: Readonly<Record<string, string>>
  /** Lowercase hex SHA-256 of the body (of `""` when there is none). */
  readonly payloadSha256: string
  readonly credentials: HeraS3Credentials
  readonly region: string
  readonly service: string
  /** Signing time, epoch ms. */
  readonly nowMs: number
}

const encoder = new TextEncoder()

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("")
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data))
}

/** `20130524T000000Z` from epoch ms. */
export function amzDate(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&")
}

/**
 * AWS Signature Version 4 over WebCrypto (runtime-agnostic: bun, node, workerd). Returns the
 * headers to send: the input headers plus `x-amz-date`, `x-amz-content-sha256` and
 * `authorization`. Every returned header except `authorization` is signed, with `host`.
 */
export async function signSigV4(input: SigV4Input): Promise<Record<string, string>> {
  const url = new URL(input.url)
  const date = amzDate(input.nowMs)
  const day = date.slice(0, 8)
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers)) {
    headers[name.toLowerCase()] = value.trim().replace(/\s+/g, " ")
  }
  headers["x-amz-date"] = date
  headers["x-amz-content-sha256"] = input.payloadSha256
  const signed: Record<string, string> = { ...headers, host: url.host }
  const names = Object.keys(signed).sort()
  const signedHeaders = names.join(";")
  const canonicalRequest = [
    input.method,
    url.pathname === "" ? "/" : url.pathname,
    canonicalQuery(url.searchParams),
    names.map((n) => `${n}:${signed[n]}\n`).join(""),
    signedHeaders,
    input.payloadSha256,
  ].join("\n")
  const scope = `${day}/${input.region}/${input.service}/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    date,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")
  const secret = Redacted.value(input.credentials.secretAccessKey)
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), day)
  const kRegion = await hmac(kDate, input.region)
  const kService = await hmac(kRegion, input.service)
  const kSigning = await hmac(kService, "aws4_request")
  const signature = hex(await hmac(kSigning, stringToSign))
  const accessKeyId = Redacted.value(input.credentials.accessKeyId)
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}
