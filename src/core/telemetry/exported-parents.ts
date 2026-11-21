import type * as Tracer from "effect/Tracer"
import type { CapturedLogRecord, CapturedSpan } from "./types.js"

/**
 * The span ids an export may name as a parent: the spans it sends, plus the remote parent when that
 * parent is sampled (its caller exports it). Any other id names a span nobody exports, which a
 * backend renders as an orphan.
 */
export function exportedParentIds(
  finished: ReadonlyArray<CapturedSpan>,
  parent: Tracer.ExternalSpan | undefined
): ReadonlySet<string> {
  const ids = new Set(finished.map((captured) => captured.span.spanId))
  if (parent?.sampled === true) ids.add(parent.spanId)
  return ids
}

/** `record` without a `spanId` outside `parents`; its `traceId` stays, so the line keeps its trace. */
export function withExportedSpan(record: CapturedLogRecord, parents: ReadonlySet<string>): CapturedLogRecord {
  if (record.spanId === undefined || parents.has(record.spanId)) return record
  const { spanId: _unexported, ...rest } = record
  return rest
}
