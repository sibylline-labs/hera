/**
 * The OFREP bulk-evaluation wire (`POST /v1/ofrep/v1/evaluate/flags`) as Logfire serves it
 * (observed Nov-07): the request body is `{ context }`, the answer is
 * `{ flags: [...], metadata?: { etag } }`. A resolved entry is `{ key, value, variant?, reason? }`;
 * an errored one is `{ key, errorCode, errorDetails? }`. A flag the project lacks is simply absent
 * from `flags`.
 */

import { Result } from "effect"
import * as Schema from "effect/Schema"
import { decodeResult } from "../schema/index.js"
import type { HeraFlagAttribute, HeraFlagContext, HeraFlagEvaluation } from "./types.js"

const Entry = Schema.Struct({
  key: Schema.String,
  value: Schema.optional(Schema.Unknown),
  variant: Schema.optional(Schema.NullOr(Schema.String)),
  errorCode: Schema.optional(Schema.NullOr(Schema.String)),
})

const Bulk = Schema.Struct({ flags: Schema.Array(Entry) })

/** The context with `org_id` defaulted to the targeting key, attributes in key order. */
function attributesOf(ctx: HeraFlagContext): ReadonlyArray<readonly [string, HeraFlagAttribute]> {
  const attributes: Record<string, HeraFlagAttribute> = { org_id: ctx.targetingKey, ...ctx.attributes }
  return Object.keys(attributes)
    .sort()
    .map((key) => [key, attributes[key]!] as const)
}

/** A stable string for `ctx`: equal contexts, in any attribute order, give equal keys. */
export function contextKey(ctx: HeraFlagContext): string {
  return JSON.stringify([ctx.targetingKey, attributesOf(ctx)])
}

/** The context a `contextKey` string was made from (`org_id` already defaulted in). */
export function contextFromKey(key: string): HeraFlagContext {
  const [targetingKey, attributes] = JSON.parse(key) as [string, ReadonlyArray<readonly [string, HeraFlagAttribute]>]
  return { targetingKey, attributes: Object.fromEntries(attributes) }
}

/** The OFREP request body: the targeting key plus every attribute, flat in `context`. */
export function requestBody(ctx: HeraFlagContext): Readonly<Record<string, unknown>> {
  return { context: { ...Object.fromEntries(attributesOf(ctx)), targetingKey: ctx.targetingKey } }
}

/** The bulk answer as a map of evaluations, or `undefined` for a body that is not OFREP. */
export function decodeBulk(text: string): ReadonlyMap<string, HeraFlagEvaluation> | undefined {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  const bulk = decodeResult(Bulk, json)
  if (Result.isFailure(bulk)) return undefined
  const flags = new Map<string, HeraFlagEvaluation>()
  for (const entry of bulk.success.flags) flags.set(entry.key, evaluationOf(entry))
  return flags
}

function evaluationOf(entry: Schema.Schema.Type<typeof Entry>): HeraFlagEvaluation {
  if (entry.errorCode !== undefined && entry.errorCode !== null) {
    return { ok: false, reason: entry.errorCode === "FLAG_NOT_FOUND" ? "absent" : "errored" }
  }
  if (entry.value === undefined || entry.value === null) return { ok: false, reason: "absent" }
  return { ok: true, value: entry.value, variant: entry.variant ?? undefined }
}
