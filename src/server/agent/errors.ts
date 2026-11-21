import * as Schema from "effect/Schema"
import { HeraError } from "../../core/errors/index.js"

/** The model's raw tool arguments failed the tool's input schema. Reaches the model, not logs. */
export const AgentToolInputInvalidError = HeraError.define("AgentToolInputInvalidError", {
  code: "agent_tool_input_invalid",
  publicMessage: "Agent tool input does not match its schema",
  fields: { tool: Schema.String },
})
export type AgentToolInputInvalidError = InstanceType<typeof AgentToolInputInvalidError>

/** A model request aimed at a host outside `HERA_AGENT_EGRESS_HOSTS`; refused before it leaves. */
export const AgentEgressHostDeniedError = HeraError.define("AgentEgressHostDeniedError", {
  code: "agent_egress_host_denied",
  publicMessage: "Agent egress host is not on the allowlist",
  fields: { host: Schema.String },
})
export type AgentEgressHostDeniedError = InstanceType<typeof AgentEgressHostDeniedError>

/** `HeraAgentEgress` was built without a required value; names the field, never its value. */
export const AgentEgressUnconfiguredError = HeraError.define("AgentEgressUnconfiguredError", {
  code: "agent_egress_unconfigured",
  publicMessage: "Agent model egress is not configured",
  fields: { field: Schema.String },
})
export type AgentEgressUnconfiguredError = InstanceType<typeof AgentEgressUnconfiguredError>
