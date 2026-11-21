import * as Redacted from "effect/Redacted"
import { AgentEgressUnconfiguredError } from "../errors.js"

/**
 * Where a Hera agent's model traffic goes: the Cloudflare AI Gateway `google-ai-studio`
 * route, authenticated to Google with the Gemini API key. Dan, Nov-07: there is no separate gateway
 * token by default; `gatewayToken` is sent as `cf-aig-authorization` only when one is configured
 * (an Authenticated Gateway).
 */
export interface HeraAgentEgressConfig {
  /** The Cloudflare account that owns the gateway. */
  readonly accountId: string
  /** The AI Gateway id (its slug). */
  readonly gateway: string
  /** The Gemini API key, a Worker secret of the consumer. Sent as `x-goog-api-key`, to the gateway host only. */
  readonly apiKey: Redacted.Redacted<string> | string
  /** An Authenticated Gateway token; omitted, no `cf-aig-authorization` header is sent. */
  readonly gatewayToken?: Redacted.Redacted<string> | string | undefined
}

/** The decoded config: every required value present, secrets kept `Redacted`. */
export interface ResolvedEgressConfig {
  readonly baseUrl: string
  readonly apiKey: Redacted.Redacted<string>
  readonly gatewayToken: Redacted.Redacted<string> | undefined
}

export const AI_GATEWAY_HOST = "gateway.ai.cloudflare.com"

/** One path segment: the account id and gateway slug never carry `/`, `?`, `#` or whitespace. */
const SEGMENT = /^[A-Za-z0-9_-]+$/

function secret(value: Redacted.Redacted<string> | string | undefined): Redacted.Redacted<string> | undefined {
  if (value === undefined) return undefined
  const redacted = Redacted.isRedacted(value) ? value : Redacted.make(value)
  return Redacted.value(redacted).trim() === "" ? undefined : redacted
}

function segment(field: string, value: string | undefined): string {
  if (value === undefined || !SEGMENT.test(value)) throw new AgentEgressUnconfiguredError({ field })
  return value
}

/** Validates `config` (fails closed, naming the field) and builds the gateway route. */
export function resolveEgressConfig(config: HeraAgentEgressConfig): ResolvedEgressConfig {
  const accountId = segment("accountId", config.accountId)
  const gateway = segment("gateway", config.gateway)
  const apiKey = secret(config.apiKey)
  if (apiKey === undefined) throw new AgentEgressUnconfiguredError({ field: "apiKey" })
  return {
    baseUrl: `https://${AI_GATEWAY_HOST}/v1/${accountId}/${gateway}/google-ai-studio/v1beta`,
    apiKey,
    gatewayToken: secret(config.gatewayToken),
  }
}

/** What the gateway is told about a request: who sent it, for its logs and analytics. */
export interface EgressMetadata {
  readonly tenant: string
  readonly agent: string
  readonly service: string
}

/**
 * The gateway headers every model request carries. `cf-aig-authorization` appears only with a
 * gateway token; the token goes only to the gateway host, which the allowlist enforces per request.
 */
export function egressHeaders(resolved: ResolvedEgressConfig, metadata: EgressMetadata): Record<string, string> {
  const headers: Record<string, string> = { "cf-aig-metadata": JSON.stringify(metadata) }
  if (resolved.gatewayToken !== undefined) {
    headers["cf-aig-authorization"] = `Bearer ${Redacted.value(resolved.gatewayToken)}`
  }
  return headers
}
