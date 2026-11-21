import { fn } from "../../core/fn/index.js"
import { agent } from "./host/agent-host.js"
import { agentTool } from "./tool/agent-tool.js"

export { AI_GATEWAY_HOST, type HeraAgentEgressConfig } from "./egress/config.js"
export { HERA_AGENT_EGRESS_HOSTS } from "./egress/allowlist.js"
export { HeraAgentEgress, type HeraAgentEgressOptions, type HeraAgentUpstream } from "./egress/egress.js"
export { HERA_AGENT_METER_TABLE, HeraAgentMeter, type HeraAgentMeterRow } from "./egress/meter.js"
export { type HeraAgentModel, type HeraAgentModelId, HeraAgentModels } from "./models/catalog.js"
export {
  AgentEgressHostDeniedError,
  AgentEgressUnconfiguredError,
  AgentToolInputInvalidError,
} from "./errors.js"
export type {
  HeraAgentDef,
  HeraAgentHost,
  HeraAgentReceipt,
  HeraAgentSubmit,
  HeraAgentTelemetryConfig,
} from "./host/agent-host.js"
export { HERA_COMPOSITE_JOB } from "./host/lifecycle-driver.js"
export type { HeraAgentTool, HeraAgentToolContext, HeraAgentToolDef, HeraAgentToolOutput } from "./tool/agent-tool.js"

/**
 * The agent plane's namespace (`@sibylline-labs/hera/agent`). It lives on its own subpath
 * so Pi, pi-ai and `agents` stay out of the root bundle; `Hera.fn` is repeated here so an agent
 * module needs one import.
 */
export const Hera = { fn, agent, agentTool } as const
