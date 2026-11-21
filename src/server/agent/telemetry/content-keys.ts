/**
 * What counts as content: the GenAI semconv attributes and events that carry prompts, answers,
 * instructions or tool payloads. Metadata (model, token counts, tool names, ids) is not content.
 */
const CONTENT_KEYS: ReadonlySet<string> = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
])

const LEGACY_CONTENT_KEY = /^gen_ai\.(?:prompt|completion)(?:\.|$)/

const CONTENT_EVENTS: ReadonlySet<string> = new Set([
  "gen_ai.client.inference.operation.details",
  "gen_ai.system.message",
  "gen_ai.user.message",
  "gen_ai.assistant.message",
  "gen_ai.tool.message",
  "gen_ai.choice",
])

export function isContentKey(key: string): boolean {
  return CONTENT_KEYS.has(key) || LEGACY_CONTENT_KEY.test(key)
}

export function isContentEvent(name: string): boolean {
  return CONTENT_EVENTS.has(name) || name.startsWith("gen_ai.content.")
}
