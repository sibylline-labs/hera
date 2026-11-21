import type { AssistantMessage, ImageContent, Message, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"
import { GITLEAKS_SHAPES, scrubCredentialRuns } from "../../../core/logger/index.js"

/**
 * Pi messages as OTel GenAI semantic-convention content (`gen_ai.input.messages`,
 * `gen_ai.output.messages`, `gen_ai.system_instructions`): a message is `{ role, parts }`, a part is
 * `text` / `reasoning` (`content`), `tool_call` (`id`, `name`, `arguments`), `tool_call_response`
 * (`id`, `response`) or `blob` (no bytes). Each string is scrubbed of credential runs, then capped,
 * so a cap never cuts a credential into a piece no shape matches, and a value stays valid JSON.
 */

/** Characters kept per text part; the rest is replaced by a count. */
export const MAX_PART_CHARS = 32_000

type Part =
  | { readonly type: "text" | "reasoning"; readonly content: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string; readonly arguments: unknown }
  | { readonly type: "tool_call_response"; readonly id: string; readonly response: string }
  | { readonly type: "blob"; readonly modality: "image"; readonly mime_type: string }

interface GenAiMessage {
  readonly role: "user" | "assistant" | "tool"
  readonly parts: ReadonlyArray<Part>
  readonly finish_reason?: string
}

export function capText(text: string): string {
  const scrubbed = scrubCredentialRuns(text, GITLEAKS_SHAPES)
  return scrubbed.length <= MAX_PART_CHARS
    ? scrubbed
    : `${scrubbed.slice(0, MAX_PART_CHARS)}…[truncated ${scrubbed.length - MAX_PART_CHARS} chars]`
}

/** `value` with every string inside it through {@link capText}; the shape is kept, so it stays JSON. */
export function capJson(value: unknown): unknown {
  if (typeof value === "string") return capText(value)
  if (Array.isArray(value)) return value.map(capJson)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, capJson(item)]))
  }
  return value
}

const textOf = (content: string | ReadonlyArray<TextContent>): string =>
  typeof content === "string" ? content : content.map((c) => c.text).join("\n")

function inputPart(part: TextContent | ImageContent): Part {
  return part.type === "text"
    ? { type: "text", content: capText(part.text) }
    : { type: "blob", modality: "image", mime_type: part.mimeType }
}

function assistantPart(part: TextContent | ThinkingContent | ToolCall): Part {
  if (part.type === "text") return { type: "text", content: capText(part.text) }
  if (part.type === "thinking") return { type: "reasoning", content: part.redacted === true ? "[redacted by provider]" : capText(part.thinking) }
  return { type: "tool_call", id: part.id, name: part.name, arguments: capJson(part.arguments) }
}

const resultText = (content: ReadonlyArray<TextContent | ImageContent>): string =>
  capText(content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n"))

/** The system messages' instructions, base prompt then sections in order; `undefined` when none. */
export function systemInstructionsOf(messages: ReadonlyArray<Message>): ReadonlyArray<Part> | undefined {
  const parts: Part[] = []
  for (const message of messages) {
    if (message.role !== "system") continue
    const base = textOf(message.content)
    if (base !== "") parts.push({ type: "text", content: capText(base) })
    for (const section of Object.values(message.sections ?? {})) {
      if (typeof section === "string" && section !== "") parts.push({ type: "text", content: capText(section) })
    }
  }
  return parts.length === 0 ? undefined : parts
}

/** The non-system messages of a request, in order. */
export function inputMessagesOf(messages: ReadonlyArray<Message>): ReadonlyArray<GenAiMessage> {
  const out: GenAiMessage[] = []
  for (const message of messages) {
    if (message.role === "user") {
      const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
      out.push({ role: "user", parts: content.map(inputPart) })
    } else if (message.role === "assistant") {
      out.push({ role: "assistant", parts: message.content.map(assistantPart) })
    } else if (message.role === "toolResult") {
      out.push({ role: "tool", parts: [{ type: "tool_call_response", id: message.toolCallId, response: resultText(message.content) }] })
    }
  }
  return out
}

/** The model's answer as one output message, with its stop reason as `finish_reason`. */
export function outputMessagesOf(message: AssistantMessage): ReadonlyArray<GenAiMessage> {
  return [{ role: "assistant", parts: message.content.map(assistantPart), finish_reason: message.stopReason }]
}

/** A tool's result as the text the model receives, with an error mark. */
export function toolCallResultOf(result: ToolExecutionResult): string {
  const text = resultText(result.output ?? [])
  return result.isError === true ? `[error] ${text}` : text
}
