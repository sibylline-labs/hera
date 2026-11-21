import type { ProviderStreams } from "@earendil-works/pi-ai"
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models"
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy"
import * as Redacted from "effect/Redacted"
import { catalogModel, HERA_AGENT_PROVIDER, type HeraAgentModel } from "../models/catalog.js"
import { egressHeaders, type EgressMetadata, type HeraAgentEgressConfig, resolveEgressConfig } from "./config.js"
import type { HeraAgentMeter } from "./meter.js"
import { meteredStreams } from "./metered-streams.js"

/**
 * A model upstream: what speaks to the model once Hera's egress rules have passed. Production uses
 * pi-ai's Google Generative AI adapter; `@sibylline-labs/hera/testing/agent` serves a scripted one
 * through the same seam, so allowlist, thinking level and meter run unchanged in tests.
 */
export type HeraAgentUpstream = ProviderStreams

export interface HeraAgentEgressOptions {
  readonly config: HeraAgentEgressConfig
  readonly metadata: EgressMetadata
  /** The primary model and, optionally, the catalog fallback. */
  readonly model: HeraAgentModel
  readonly fallback?: HeraAgentModel | undefined
  readonly meter: HeraAgentMeter
  readonly upstream?: HeraAgentUpstream | undefined
  readonly now?: (() => number) | undefined
  /** Attributes each metered request to its operation; the `Hera.agent` host passes its resolver. */
  readonly operationFor?: ((sessionId: string | undefined) => Promise<string | undefined>) | undefined
}

/**
 * pi-ai `Models` with one provider (`google`) whose models are the catalog rows routed through the
 * AI Gateway `google-ai-studio` route. Fails closed on a missing config value.
 */
function make(options: HeraAgentEgressOptions): MutableModels {
  const resolved = resolveEgressConfig(options.config)
  const route = { baseUrl: resolved.baseUrl, headers: egressHeaders(resolved, options.metadata) }
  const selection = options.fallback === undefined ? [options.model] : [options.model, options.fallback]
  const models = selection.map((m) => catalogModel(m.id, route))
  const api = meteredStreams(options.upstream ?? googleGenerativeAIApi(), {
    meter: options.meter,
    selection,
    fallback: options.fallback === undefined ? undefined : catalogModel(options.fallback.id, route),
    now: options.now ?? Date.now,
    operationFor: options.operationFor,
  })
  const registry = createModels()
  registry.setProvider(
    createProvider({
      id: HERA_AGENT_PROVIDER,
      name: "Gemini API via Cloudflare AI Gateway",
      baseUrl: resolved.baseUrl,
      auth: {
        apiKey: {
          name: "Gemini API key",
          resolve: async () => ({ auth: { apiKey: Redacted.value(resolved.apiKey) } }),
        },
      },
      models,
      api,
    })
  )
  return registry
}

export const HeraAgentEgress = { make } as const
