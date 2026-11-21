import {
  GITLEAKS_SHAPES,
  isSecretKey,
  REDACTED_VALUE,
  scrubCredentialRuns,
  scrubLogString,
} from "../../../core/logger/index.js"
import { isContentEvent, isContentKey } from "./content-keys.js"
import type { AgentAttributes, AgentAttributeValue, EndedSpan } from "./span.js"

const RULES = { secretShapes: GITLEAKS_SHAPES }

/** Token counts are numbers under keys that look secret (`input_tokens`); only strings are keyed. */
const USAGE_PREFIX = "gen_ai.usage."

function scrubString(value: string, content: boolean): string {
  // Content is cut to the credential run, so one hit never blanks a whole message.
  return content ? scrubCredentialRuns(value, GITLEAKS_SHAPES) : scrubLogString(value, RULES)
}

function scrubValue(key: string, value: AgentAttributeValue): AgentAttributeValue {
  const content = isContentKey(key)
  if (typeof value === "string") {
    if (!content && !key.startsWith(USAGE_PREFIX) && isSecretKey(key)) return REDACTED_VALUE
    return scrubString(value, content)
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    if (!content && !key.startsWith(USAGE_PREFIX) && isSecretKey(key)) return REDACTED_VALUE
    return (value as ReadonlyArray<string>).map((item) => scrubString(item, content))
  }
  return value
}

/** `attributes` scrubbed; content keys are dropped unless `contentExport`. */
export function scrubAttributes(attributes: AgentAttributes | undefined, contentExport: boolean): AgentAttributes {
  const out: Record<string, AgentAttributeValue> = {}
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (!contentExport && isContentKey(key)) continue
    out[key] = scrubValue(key, value)
  }
  return out
}

/**
 * A copy of `span` with every exportable string scrubbed and, unless `contentExport`, every
 * content attribute and event removed. The exception is already scrubbed by `describeException`.
 */
export function redactSpan(span: EndedSpan, contentExport: boolean): EndedSpan {
  const events = span.events.filter((event) => contentExport || !isContentEvent(event.name))
  return {
    ...span,
    name: scrubLogString(span.name, RULES),
    attributes: scrubAttributes(span.attributes, contentExport),
    links: span.links.map((link) => ({ ...link, attributes: scrubAttributes(link.attributes, contentExport) })),
    events: events.map((event) => ({
      name: scrubLogString(event.name, RULES),
      timeMs: event.timeMs,
      attributes: scrubAttributes(event.attributes, contentExport),
    })),
    droppedEvents: span.droppedEvents + (span.events.length - events.length),
  }
}
