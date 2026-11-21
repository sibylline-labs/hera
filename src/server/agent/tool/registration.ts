import type { ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable"
import type { TelemetrySpan } from "@earendil-works/pi-telemetry"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { AgentToolInputInvalidError } from "../errors.js"
import type { HeraAgentOperationResolver } from "../host/operation-resolver.js"
import { recordToolContent } from "../telemetry/content-recorder.js"
import type { HeraAgentTool, HeraAgentToolOutput } from "./agent-tool.js"

/** The tool's JSON Schema as Pi's `parameters` (a draft 2020-12 document; `$defs` kept). */
export function toolParameters(tool: HeraAgentTool): ToolRegistration["parameters"] {
  const document = Schema.toJsonSchemaDocument(tool.input)
  const defs = document.definitions
  return (Object.keys(defs).length === 0 ? document.schema : { ...document.schema, $defs: defs }) as ToolRegistration["parameters"]
}

/** The first line of a decode failure: what the model needs to retry, nothing more. */
function issueSummary(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause)
  const text = error instanceof Error ? error.message : String(error)
  return text.split("\n").slice(0, 3).join(" ").slice(0, 300)
}

const asResult = (output: HeraAgentToolOutput): ToolExecutionResult =>
  typeof output === "string"
    ? { output: [{ type: "text", text: output }] }
    : { output: [{ type: "text", text: output.text }], ...(output.isError === true ? { isError: true } : {}) }

/** A typed failure reaches the model as an error result naming its tag and code, never its text. */
function failureResult(cause: Cause.Cause<unknown>): ToolExecutionResult {
  const error = Cause.squash(cause)
  const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {}
  const tag = typeof record._tag === "string" ? record._tag : error instanceof Error ? error.name : "Error"
  const code = typeof record.code === "string" ? ` (${record.code})` : ""
  return { output: [{ type: "text", text: `tool failed: ${tag}${code}` }], isError: true }
}

/**
 * Pi's registration for a Hera tool. This module and its siblings under
 * `src/server/agent/` are the only place a raw `ToolRegistration` is built.
 *
 * Invariants:
 *  - `prepareArguments` strictly decodes the RAW model arguments, before Pi's validator coerces
 *    them (`{key:3}` → `{key:"3"}`). A failure throws `agent_tool_input_invalid`, which
 *    Pi turns into an error tool result; `execute` never runs.
 *  - `execute` decodes again with `Schema.decodeUnknownEffect` for the typed value and hands the
 *    handler Pi's `callId`, the `session` and, with a `resolver`, the running `operationId`.
 */
export function toRegistration(tool: HeraAgentTool, resolver?: HeraAgentOperationResolver): ToolRegistration {
  const strict = Schema.decodeUnknownExit(tool.input)
  return {
    name: tool.name,
    description: tool.description,
    parameters: toolParameters(tool),
    replay: tool.replay,
    prepareArguments(raw: unknown) {
      const decoded = strict(raw)
      if (Exit.isFailure(decoded)) {
        const error = new AgentToolInputInvalidError({ tool: tool.name })
        throw new Error(`${error.code}: ${issueSummary(decoded.cause)}`)
      }
      return raw as never
    },
    async execute(args: unknown, api: ToolExecutionApi, invocation?: { readonly telemetry?: TelemetrySpan }): Promise<ToolExecutionResult> {
      const operation = await resolver?.forConversation(api.conversationId)
      const context = { callId: api.callId, session: String(api.conversationId), operationId: operation?.operationId }
      const program = Effect.flatMap(Schema.decodeUnknownEffect(tool.input)(args), (input) => tool.execute(input, context))
      // The Pi tool boundary: a Promise API with no Hera runtime around it (rule ignores this file).
      const exit = await Effect.runPromiseExit(program)
      const result = Exit.isSuccess(exit) ? asResult(exit.value) : failureResult(exit.cause)
      recordToolContent(invocation?.telemetry, args, result)
      return result
    },
  }
}
