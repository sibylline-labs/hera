import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import type { HeraError } from "../errors/index.js"
import { fn } from "../fn/index.js"
import { request } from "../http/index.js"
import { toStoreError } from "./errors.js"
import { type HeraS3Credentials, sha256Hex } from "./sigv4.js"

export interface HeraR2TokenCredentialsOptions {
  /** A Cloudflare API token with R2 object permissions (`CLOUDFLARE_API_TOKEN`). */
  readonly apiToken: Redacted.Redacted<string>
  /** Tried at `/accounts/<id>/tokens/verify` when the user-token endpoint refuses (account tokens). */
  readonly accountId?: string | undefined
  /** Default `https://api.cloudflare.com/client/v4`. */
  readonly apiBase?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly fetch?: typeof globalThis.fetch | undefined
}

const VerifyReply = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Struct({ id: Schema.String }),
})

/**
 * Derives R2 S3 credentials from a Cloudflare API token as R2 documents it: the
 * access key id is the token's id (read from `tokens/verify`), the secret access key is the
 * SHA-256 hex of the token value. Both come back `Redacted`; the token goes only into the
 * verify call's `Authorization` header.
 */
export const credentialsFromApiToken: (
  options: HeraR2TokenCredentialsOptions
) => Effect.Effect<HeraS3Credentials, HeraError> = fn(
  "HeraObjectStore.credentialsFromApiToken"
)(function* (options: HeraR2TokenCredentialsOptions) {
  const apiBase = (options.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "")
  const verify = (url: string) =>
    request({
      url,
      schema: VerifyReply,
      headers: {
        authorization: Redacted.make(`Bearer ${Redacted.value(options.apiToken)}`),
      },
      timeoutMs: options.timeoutMs,
      fetch: options.fetch,
      redirect: "error",
    })
  const user = yield* Effect.result(verify(`${apiBase}/user/tokens/verify`))
  let id: string
  if (user._tag === "Success") {
    id = user.success.data.result.id
  } else if (options.accountId !== undefined) {
    const account = yield* verify(
      `${apiBase}/accounts/${encodeURIComponent(options.accountId)}/tokens/verify`
    ).pipe(Effect.mapError((err) => toStoreError("credentials", "", err)))
    id = account.data.result.id
  } else {
    return yield* Effect.fail(toStoreError("credentials", "", user.failure))
  }
  const secret = yield* Effect.promise(() => sha256Hex(Redacted.value(options.apiToken)))
  return {
    accessKeyId: Redacted.make(id),
    secretAccessKey: Redacted.make(secret),
  }
})
