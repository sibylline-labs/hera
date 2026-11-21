import type * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"

declare const HeraAgentToolBrand: unique symbol

/** What a tool handler gets besides its decoded input. */
export interface HeraAgentToolContext {
  /** Pi's call id: stable across a replay, so key side effects on it (`INSERT OR IGNORE`). */
  readonly callId: string
  /** Pi's conversation id as a string: the session the calling run belongs to. */
  readonly session: string
  /**
   * The `operationId` the run was submitted under, so two operations at once on one host each see their
   * own. `undefined` only outside a `Hera.agent` host (a hand-built Pi `Harness`, a bare `toRegistration`).
   */
  readonly operationId: string | undefined
}

/** A tool's answer to the model: text, or text flagged as a tool-level error. */
export type HeraAgentToolOutput = string | { readonly text: string; readonly isError?: boolean }

export interface HeraAgentToolDef<S extends Schema.ConstraintDecoder<unknown>, E> {
  readonly name: string
  readonly description: string
  /** The input schema: the model sees its JSON Schema; the raw arguments are decoded strictly. */
  readonly input: S
  readonly execute: (input: S["Type"], context: HeraAgentToolContext) => Effect.Effect<HeraAgentToolOutput, E, never>
  /**
   * Whether an execution an eviction interrupted reruns on recovery. Default `"safe"`: the handler
   * must then be idempotent by `callId`. Pi's own default is `"unsafe"` (never rerun).
   */
  readonly replay?: "safe" | "unsafe" | undefined
}

/**
 * A tool built through `Hera.agentTool`. The brand is the only door into `Hera.agent`'s
 * `tools`: a hand-written Pi `ToolRegistration` does not type-check there, and the
 * `hera-agent-tool-via-hera` lint flags one built anywhere else.
 */
export interface HeraAgentTool {
  readonly [HeraAgentToolBrand]: "HeraAgentTool"
  readonly name: string
  readonly description: string
  readonly input: Schema.ConstraintDecoder<unknown>
  readonly replay: "safe" | "unsafe"
  readonly execute: (input: unknown, context: HeraAgentToolContext) => Effect.Effect<HeraAgentToolOutput, unknown, never>
}

const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

/** Declares an agent tool over an Effect Schema input. Throws at module init on an invalid name. */
export function agentTool<S extends Schema.ConstraintDecoder<unknown>, E>(def: HeraAgentToolDef<S, E>): HeraAgentTool {
  if (!TOOL_NAME.test(def.name)) {
    throw new Error(`Hera.agentTool: "${def.name}" is not a valid tool name (${TOOL_NAME.source})`)
  }
  return {
    name: def.name,
    description: def.description,
    input: def.input,
    replay: def.replay ?? "safe",
    execute: def.execute as HeraAgentTool["execute"],
  } as unknown as HeraAgentTool
}
