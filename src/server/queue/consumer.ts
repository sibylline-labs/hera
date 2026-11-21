import * as Effect from "effect/Effect"
import { beginHooked, exitIsDefect } from "../../core/telemetry/hook.js"
import type { HeraTelemetryInvocation } from "../../core/telemetry/types.js"
import * as Option from "effect/Option"
import type * as Tracer from "effect/Tracer"
import type * as Schema from "effect/Schema"
import { HeraCtx, type HeraCtxShape } from "../../core/context/index.js"
import { mintRequestId } from "../../core/context/request-id.js"
import { createHeraLogger, type HeraLogger } from "../../core/logger/index.js"
import { RequestId } from "../../core/schema/index.js"
import { parseTraceparent } from "../rpc/trace-context.js"
import { decodeQueueBatch } from "./decode.js"
import {
  DEFAULT_QUEUE_RETRY_DELAY_SECONDS,
  type HeraQueueSettlement,
  settleQueueExit,
} from "./settle.js"
import type {
  HeraQueueBatchInput,
  HeraQueueConsumer,
  HeraQueueConsumerSpec,
  HeraQueueError,
} from "./types.js"

type LogLevel = "warn" | "error"

/** Writes one line; a throwing sink is swallowed so it can never skip settlement or reject. */
async function writeLog(
  invocation: HeraTelemetryInvocation,
  logger: HeraLogger,
  level: LogLevel,
  msg: string,
  fields: Readonly<Record<string, unknown>>
): Promise<void> {
  try {
    // hera-allow: raw-effect-run
    await Effect.runPromise(invocation.provide(logger[level](msg, fields)))
  } catch {
    // A log sink failure must not change how the batch settles.
  }
}

/** One link per traced message, to the producer span that enqueued it. */
function producerLinks(
  messages: ReadonlyArray<{ readonly id: string; readonly traceparent?: string | undefined }>
): ReadonlyArray<Tracer.SpanLink> {
  const links: Array<Tracer.SpanLink> = []
  for (const message of messages) {
    const span = parseTraceparent(message.traceparent)
    if (span !== undefined) {
      links.push({ span, attributes: { "messaging.message.id": message.id } })
    }
  }
  return links
}

/** The producers' request id when every traced message carries the same one. */
function sharedRequestId(
  messages: ReadonlyArray<{ readonly requestId?: string | undefined }>
): RequestId | undefined {
  const ids = new Set(messages.flatMap((m) => (m.requestId !== undefined ? [m.requestId] : [])))
  const [only] = ids
  return ids.size === 1 && RequestId.is(only) ? only : undefined
}

function applySettlement(batch: HeraQueueBatchInput, settlement: HeraQueueSettlement): unknown {
  try {
    if (settlement.kind === "ack") {
      batch.ackAll()
    } else if (settlement.delaySeconds !== undefined) {
      batch.retryAll({ delaySeconds: settlement.delaySeconds })
    } else {
      batch.retryAll()
    }
    return undefined
  } catch (error) {
    return error
  }
}

/**
 * Builds a Cloudflare Queues consumer boundary. Each body is decoded with `schema`; a
 * body that fails decode is logged (`hera.queue.message_invalid`, structure only) and handed to
 * the handler in `batch.invalid`, so it settles with its batch instead of failing it. The
 * handler's exit settles the whole batch exactly once (see `settleQueueExit`), and the returned
 * promise never rejects.
 */
export function queueConsumer<
  Env = unknown,
  S extends Schema.Top | undefined = undefined,
  E extends HeraQueueError = never,
>(spec: HeraQueueConsumerSpec<S, Env, E>): HeraQueueConsumer<Env> {
  const service = spec.service ?? spec.name
  const logger = spec.logger ?? createHeraLogger({ service })
  const defaultDelay = spec.retryDelaySeconds ?? DEFAULT_QUEUE_RETRY_DELAY_SECONDS

  return async (input, env, ctx) => {
    const telemetry = typeof spec.telemetry === "function" ? spec.telemetry(env) : spec.telemetry
    const invocation = beginHooked(
      telemetry === undefined || ctx === undefined ? undefined : { telemetry, waitUntil: (p) => ctx.waitUntil(p) },
      { name: spec.name, source: "internal" }
    )
    // Decoded before the span opens, so the span can link to the producers. A decode that throws
    // is retried inside the program, where it becomes the batch's defect, never a rejection.
    let decoded: ReturnType<typeof decodeQueueBatch<never>> | undefined
    try {
      decoded = decodeQueueBatch<never>(spec.schema, input)
    } catch {
      decoded = undefined
    }
    const traced = decoded === undefined ? [] : [...decoded.messages, ...decoded.invalid]
    const requestId = sharedRequestId(traced) ?? mintRequestId()
    const heraCtx: HeraCtxShape = {
      requestId,
      actorId: Option.none(),
      orgId: Option.none(),
      service,
    }
    const base = { queue: input.queue, requestId, size: input.messages.length }

    const program = Effect.suspend(() => {
      const batch = decoded ?? decodeQueueBatch<never>(spec.schema, input)
      return Effect.andThen(
        Effect.forEach(batch.invalid, (message) =>
          Effect.ignore(
            logger.error("hera.queue.message_invalid", {
              queue: input.queue,
              requestId,
              messageId: message.id,
              attempts: message.attempts,
              issues: message.issues,
            })
          )
        ),
        spec.handler(batch, env)
      )
    }).pipe(
      Effect.withSpan(spec.name, { kind: "consumer", links: producerLinks(traced) }),
      Effect.provide(HeraCtx.layer(heraCtx))
    )

    // hera-allow: raw-effect-run
    const exit = await Effect.runPromiseExit(invocation.provide(program as Effect.Effect<void, HeraQueueError>))
    const settlement = settleQueueExit(exit, defaultDelay)
    const settleError = applySettlement(input, settlement)

    if (settlement.kind === "retry") {
      await writeLog(
        invocation,
        logger,
        settlement.event === "hera.queue.batch_retry" ? "warn" : "error",
        settlement.event,
        { ...base, ...settlement.fields }
      )
    }
    if (settleError !== undefined) {
      await writeLog(invocation, logger, "error", "hera.queue.settle_failed", { ...base, kind: settlement.kind })
    }
    invocation.end({ defect: exitIsDefect(exit) })
  }
}
