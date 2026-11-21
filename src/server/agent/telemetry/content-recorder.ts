import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"
import type { TelemetrySpan } from "@earendil-works/pi-telemetry"
import { capJson, inputMessagesOf, outputMessagesOf, systemInstructionsOf, toolCallResultOf } from "./genai-content.js"
import { PiSpan } from "./pi-adapter.js"

/**
 * Records GenAI content on the span Pi hands a seam. The gate is the span itself: a `PiSpan` of an
 * instance built with `contentExport: true`; anything else records nothing and costs nothing. A
 * recording failure is dropped here, never thrown into the agent. The pipeline's scrub on span end still
 * drops or scrubs every content key on export.
 */
function contentSpan(telemetry: TelemetrySpan | undefined): PiSpan | undefined {
  return telemetry instanceof PiSpan && telemetry.content ? telemetry : undefined
}

/** A model request's content on the chat span `telemetry` (the request's parent phase) has open. */
export function recordChatContent(
  telemetry: TelemetrySpan | undefined,
  messages: ReadonlyArray<Message>,
  message: AssistantMessage
): void {
  const chat = contentSpan(telemetry)?.openChat()
  if (chat === undefined) return
  try {
    const instructions = systemInstructionsOf(messages)
    chat.setAttributes({
      "gen_ai.input.messages": JSON.stringify(inputMessagesOf(messages)),
      "gen_ai.output.messages": JSON.stringify(outputMessagesOf(message)),
      ...(instructions === undefined ? {} : { "gen_ai.system_instructions": JSON.stringify(instructions) }),
    })
  } catch {
    // Content is telemetry; a value that will not serialize is not the agent's failure.
  }
}

/** A tool call's arguments and result on its `execute_tool` span. */
export function recordToolContent(telemetry: TelemetrySpan | undefined, args: unknown, result: ToolExecutionResult): void {
  const span = contentSpan(telemetry)
  if (span === undefined) return
  try {
    span.span.setAttributes({
      "gen_ai.tool.call.arguments": JSON.stringify(capJson(args ?? null)),
      "gen_ai.tool.call.result": toolCallResultOf(result),
    })
  } catch {
    // As above: never the agent's failure.
  }
}
