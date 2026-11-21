import { HeraAgentMeter, type HeraAgentMeterRow, type MeterSql } from "../../server/agent/egress/meter.js"
import { type HeraAgentScriptStep, type ScriptedUsage, scriptedUpstream } from "./scripted-model.js"

export type { HeraAgentScriptStep, ScriptedUsage }

type StepExtras = { readonly usage?: ScriptedUsage; readonly logId?: string; readonly delayMs?: number }

/**
 * `@sibylline-labs/hera/testing/agent`: a scripted model served through the egress seam,
 * so a consumer's agent tests run Hera's allowlist, thinking level and meter without importing Pi.
 * Override the host's `createEgressUpstream()` with `HeraAgentTest.script([...])`.
 */
export const HeraAgentTest = {
  script: scriptedUpstream,
  toolCall: (name: string, args: unknown, extras: StepExtras = {}): HeraAgentScriptStep => ({
    kind: "toolCall",
    calls: [{ name, args }],
    ...extras,
  }),
  toolCalls: (calls: ReadonlyArray<{ readonly name: string; readonly args: unknown }>, extras: StepExtras = {}): HeraAgentScriptStep => ({
    kind: "toolCall",
    calls,
    ...extras,
  }),
  text: (text: string, extras: StepExtras = {}): HeraAgentScriptStep => ({ kind: "text", text, ...extras }),
  fail: (message: string, extras: StepExtras = {}): HeraAgentScriptStep => ({ kind: "fail", message, ...extras }),
  /** The meter rows an agent object wrote to its SQLite. */
  meterRows: (sql: MeterSql): ReadonlyArray<HeraAgentMeterRow> => HeraAgentMeter.sqlite(sql).rows(),
} as const
