import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai"

/**
 * The closed set of models a Hera agent can run. Dan's rev-3 ruling: Gemini API (not
 * Vertex), `gemma-4-26b-a4b-it` by default, `gemini-4-argon` at thinking `low` as the only fallback,
 * and never `gemini-2.5-flash`. Widening the set is an edit here, never a string at a call site.
 */
export type HeraAgentModelId = "gemma-4-26b-a4b-it" | "gemini-4-argon" | "gemini-4-hydrogen"

/** A model choice: a catalog id and, when the model thinks, the level it thinks at. */
export interface HeraAgentModel {
  readonly id: HeraAgentModelId
  readonly thinkingLevel?: ModelThinkingLevel | undefined
}

/** The pi-ai provider id every catalog model is registered under. */
export const HERA_AGENT_PROVIDER = "google"

type CatalogRow = Omit<Model<"google-generative-ai">, "baseUrl" | "headers">

const INPUT_LIMITS = {
  maxRequestBytes: 20_971_520,
  images: { maxPerRequest: 3600, resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4_718_592, jpegQuality: 80 } },
} as const

/**
 * `gemini-4-hydrogen` is selectable by name (`{ id: "gemini-4-hydrogen" }`) and is neither the default nor the
 * fallback. Its id, thinking levels (`low`..`xhigh`, default `high`) and prices (input $1.50, output $7.50,
 * cache read $0.075 per 1M tokens) were read from https://ai.google.dev/gemini-api/docs/models,
 * /pricing and /thinking on Nov-18-2026. `xhigh` is left unmapped: pi-ai@1.4.0 resolves Google levels
 * only up to `high` and throws on `xhigh`.
 */

/**
 * The catalog rows, copied from pi-ai@1.4.0 `providers/data/google.json` and pinned here so a Pi
 * bump cannot move a context window, cost or thinking map under a consumer (the pins check moves Pi
 * as one group; this table moves with it by hand).
 */
const ROWS: Readonly<Record<HeraAgentModelId, CatalogRow>> = {
  "gemma-4-26b-a4b-it": {
    id: "gemma-4-26b-a4b-it",
    name: "Gemma 4 26B A4B IT",
    api: "google-generative-ai",
    provider: HERA_AGENT_PROVIDER,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262_144,
    maxTokens: 32_768,
    inputLimits: INPUT_LIMITS,
  },
  "gemini-4-argon": {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    api: "google-generative-ai",
    provider: HERA_AGENT_PROVIDER,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    input: ["text", "image"],
    cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    inputLimits: INPUT_LIMITS,
  },
  "gemini-4-hydrogen": {
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen",
    api: "google-generative-ai",
    provider: HERA_AGENT_PROVIDER,
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
    input: ["text", "image"],
    cost: { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    inputLimits: INPUT_LIMITS,
  },
}

/** The ruled defaults: Gemma with thinking off, and Argon at `low` as the only fallback. */
export const HeraAgentModels = {
  default: { id: "gemma-4-26b-a4b-it" } as HeraAgentModel,
  fallback: { id: "gemini-4-argon", thinkingLevel: "low" } as HeraAgentModel,
  ids: Object.keys(ROWS) as ReadonlyArray<HeraAgentModelId>,
} as const

/** The pi-ai `Model` for a catalog id, routed at `baseUrl` with `headers`. */
export function catalogModel(
  id: HeraAgentModelId,
  route: { readonly baseUrl: string; readonly headers: Readonly<Record<string, string>> }
): Model<Api> {
  return { ...ROWS[id], baseUrl: route.baseUrl, headers: { ...route.headers } }
}

/** The thinking level a stream for `modelId` must run at, or `undefined` for thinking off. */
export function thinkingLevelFor(
  modelId: string,
  selection: ReadonlyArray<HeraAgentModel>
): ModelThinkingLevel | undefined {
  return selection.find((m) => m.id === modelId)?.thinkingLevel
}
