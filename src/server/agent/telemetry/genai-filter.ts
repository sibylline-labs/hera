import type { EndedSpan } from "./span.js"

export const GENAI_OPERATION_KEY = "gen_ai.operation.name"
const GENAI_OPERATIONS: ReadonlySet<unknown> = new Set(["invoke_agent", "chat", "execute_tool"])

export function isGenAiSpan(span: EndedSpan): boolean {
  return GENAI_OPERATIONS.has(span.attributes[GENAI_OPERATION_KEY])
}

export function isInvokeAgent(span: EndedSpan): boolean {
  return span.attributes[GENAI_OPERATION_KEY] === "invoke_agent"
}

/** `span` with its parent replaced. */
function withParent(span: EndedSpan, parentSpanId: string | undefined): EndedSpan {
  const { parentSpanId: _replaced, ...rest } = span
  return parentSpanId === undefined ? rest : { ...rest, parentSpanId }
}

interface Ended {
  readonly parent: string | undefined
  readonly kept: boolean
}

/** What the instance knows beyond one batch: the spans it opened that have not ended, and the ones an earlier flush dropped. */
export interface KnownSpans {
  readonly open: ReadonlySet<string>
  /** Dropped span id → its parent. */
  readonly dropped: ReadonlyMap<string, string | undefined>
}

export interface KeptGenAi {
  /** GenAI spans to export now, each parented on a span that exports or on none. */
  readonly kept: EndedSpan[]
  /** GenAI spans whose parent is still open here: it may yet be dropped, so they wait for the next flush. */
  readonly held: EndedSpan[]
}

const NOTHING_KNOWN: KnownSpans = { open: new Set(), dropped: new Map() }

/**
 * The GenAI spans of `batch`, each re-parented to its nearest kept ancestor, walking through dropped
 * spans of this batch and of earlier ones. A span whose walk stops on a span still open here is held;
 * an ancestor the instance never saw (a caller's span) is left as the parent.
 */
export function keepGenAi(batch: ReadonlyArray<EndedSpan>, known: KnownSpans = NOTHING_KNOWN): KeptGenAi {
  const ended = new Map<string, Ended>()
  for (const span of batch) {
    ended.set(span.spanId, { parent: span.parentSpanId, kept: isGenAiSpan(span) })
  }
  const kept: EndedSpan[] = []
  const held: EndedSpan[] = []
  const maxHops = batch.length + known.dropped.size
  for (const span of batch) {
    if (!isGenAiSpan(span)) continue
    let parent = span.parentSpanId
    let open = false
    for (let hops = 0; parent !== undefined && hops <= maxHops; hops++) {
      const entry = ended.get(parent)
      if (entry !== undefined) {
        if (entry.kept) break
        parent = entry.parent
      } else if (known.dropped.has(parent)) {
        parent = known.dropped.get(parent)
      } else {
        open = known.open.has(parent)
        break
      }
    }
    if (open) held.push(span)
    else kept.push(parent === span.parentSpanId ? span : withParent(span, parent))
  }
  return { kept, held }
}
