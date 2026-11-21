import * as Effect from "effect/Effect"
import {
  HeraFlags,
  type HeraFlagContext,
  type HeraFlagEvaluation,
  type HeraFlagReader,
  type HeraFlagSnapshot,
} from "../../core/flags/index.js"

/** One flag in a `HeraTest.flags` spec: its default, and the value per org (targeting key). */
export interface HeraTestFlagRule {
  readonly value: unknown
  readonly orgs?: Readonly<Record<string, unknown>> | undefined
}

export type HeraTestFlagSpec = Readonly<Record<string, HeraTestFlagRule>>

/** `HeraTest.flags(spec)`: a `HeraFlagReader` over an in-memory spec, plus toggles for tests. */
export interface HeraTestFlags extends HeraFlagReader {
  /** Sets (or, with `undefined`, removes) one flag's rule. */
  readonly set: (name: string, rule: HeraTestFlagRule | undefined) => void
  /** While true, every read is a whole-read `unreachable` failure, as an OFREP outage is. */
  readonly setUnreachable: (unreachable: boolean) => void
}

const UNREACHABLE: HeraFlagSnapshot = { ok: false, reason: "unreachable" }

/**
 * An in-memory flag source built on `HeraFlags.fromSource`, so a test falls back and
 * warns exactly as the OFREP reader does, and consumers never fake HTTP. Each context's snapshot is
 * held until the spec changes, as the OFREP reader holds one for its TTL.
 */
export function makeTestFlags(spec: HeraTestFlagSpec = {}): HeraTestFlags {
  const rules = new Map<string, HeraTestFlagRule>(Object.entries(spec))
  const held = new Map<string, HeraFlagSnapshot>()
  let unreachable = false

  const snapshotFor = (ctx: HeraFlagContext): HeraFlagSnapshot => {
    const flags = new Map<string, HeraFlagEvaluation>()
    for (const [name, rule] of rules) {
      const value = rule.orgs !== undefined && ctx.targetingKey in rule.orgs ? rule.orgs[ctx.targetingKey] : rule.value
      flags.set(name, value === undefined || value === null ? { ok: false, reason: "absent" } : { ok: true, value, variant: undefined })
    }
    return { ok: true, flags }
  }

  const reader = HeraFlags.fromSource((ctx) =>
    Effect.sync(() => {
      if (unreachable) return UNREACHABLE
      const key = HeraFlags.contextKey(ctx)
      const existing = held.get(key)
      if (existing !== undefined) return existing
      const snapshot = snapshotFor(ctx)
      held.set(key, snapshot)
      return snapshot
    })
  )

  return {
    ...reader,
    set: (name, rule) => {
      if (rule === undefined) rules.delete(name)
      else rules.set(name, rule)
      held.clear()
    },
    setUnreachable: (next) => {
      unreachable = next
    },
  }
}
