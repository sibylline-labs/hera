import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { HeraError } from "../../../core/errors/index.js"
import type { HeraSqlError, SyncEffect } from "../types.js"

/** Typed error for a job request no handler can run: an unregistered name, a bad cron, a non-finite time. */
export const HeraJobError = HeraError.define("HeraJobError", {
  code: "internal_error",
  publicMessage: "Durable Object job request is invalid",
  fields: { operation: Schema.String, job: Schema.String, reason: Schema.String },
})
export type HeraJobError = InstanceType<typeof HeraJobError>

/**
 * One named job: given `nowMs` and the object, it does its work and answers the next time it is due,
 * or `null` when it is done. A failure is a failed attempt, retried after `alarmErrorBackoffMs`.
 */
export type HeraJobHandler<Self = any> = (
  nowMs: number,
  self: Self
) =>
  | Effect.Effect<number | null, unknown, never>
  | Promise<number | null>
  | number
  | null

/** The jobs a Durable Object class runs, declared as `static jobs = { ... }`. */
export type HeraJobRegistry<Self = any> = Readonly<Record<string, HeraJobHandler<Self>>>

/** The job names a class registers: `HeraJobScheduler<HeraJobNames<typeof MyDO>>`. */
export type HeraJobNames<Class> = Class extends { readonly jobs: infer R }
  ? Extract<keyof R, string>
  : string

/** `when` is epoch milliseconds, or a 5/6-field cron expression evaluated in UTC. */
export type HeraJobWhen = number | string

/**
 * `this.jobs` on a Hera Durable Object: named jobs in `_hera_jobs`, sharing the object's
 * one composite alarm. Every write is a `SyncEffect`, so it composes inside `db.transactSync`.
 */
export interface HeraJobScheduler<Name extends string = string> {
  /** Due at the earlier of the stored time and `when`; a cron also re-arms after every run. */
  schedule(name: Name, when: HeraJobWhen): SyncEffect<void, HeraJobError | HeraSqlError>
  /** Writes only a job that holds no row, so a waiting or backed-off job keeps its time. */
  ensure(name: Name, when: HeraJobWhen): SyncEffect<void, HeraJobError | HeraSqlError>
  /**
   * Moves the domain-alarm slot (`scheduleDomainAlarm`) onto this job: due at the earlier of the
   * slot and any stored time, and the slot cleared, in one transaction. With no slot it
   * writes nothing, and never initialises an empty object.
   */
  adoptDomainAlarm(name: Name): SyncEffect<void, HeraJobError | HeraSqlError>
  /** Drops the job's row; it does not run until scheduled again. */
  cancel(name: Name): SyncEffect<void, HeraSqlError>
  /** The job's due time, or `null` when it holds no row. */
  nextAt(name: Name): number | null
  /** The earliest due time of any job, or `null`. */
  earliestAt(): number | null
}
