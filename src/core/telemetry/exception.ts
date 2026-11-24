import * as Cause from "effect/Cause"
import * as Option from "effect/Option"
import { isAnyHeraError } from "../errors/converters.js"
import { scrubLogString } from "../logger/redaction.js"
import { ERROR_MESSAGE_LIMIT, REDACTED_VALUE, type ScrubRules } from "../logger/types.js"
import { type ErrorFieldValue, exportableErrorFields } from "./error-fields.js"
import { exceptionFingerprint } from "./fingerprint.js"
import { frameFunctions, safeErrorName, scrubExceptionStack } from "./stack.js"
import type { DescribedException } from "./types.js"

/** What a failed span exports: an `exception` (and `errored`) only for a fault, an `errorCode` for a catalogued refusal, and the code-shaped `errorFields` a catalogued error carries. */
export interface DescribedFailure {
  readonly errored: boolean
  readonly exception?: DescribedException | undefined
  readonly errorCode?: string | undefined
  readonly errorFields?: Readonly<Record<string, ErrorFieldValue>> | undefined
}

function stringField(value: object, key: string): string | undefined {
  const field: unknown = Reflect.get(value, key)
  return typeof field === "string" && field !== "" ? field : undefined
}

function numberField(value: object, key: string): number | undefined {
  const field: unknown = Reflect.get(value, key)
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

/**
 * The exported exception for one thrown or failed value. The stack's header is always
 * `Name: [REDACTED]`; `exception.message` is `[REDACTED]`, a catalogued error's static
 * `publicMessage`, or (`errorMessages: "scrubbed"`) the scrubbed, bounded message.
 */
export function describeException(
  value: unknown,
  rules: ScrubRules,
  options: { readonly frames?: string | undefined } = {}
): DescribedException {
  const isObject = typeof value === "object" && value !== null
  const catalogued = isAnyHeraError(value)
  const tag = isObject ? stringField(value, "_tag") : undefined
  const type = safeErrorName(isObject ? (stringField(value, "name") ?? tag) : undefined)
  const code = catalogued && isObject ? stringField(value, "code") : undefined
  const rawMessage = isObject ? stringField(value, "message") : typeof value === "string" ? value : undefined
  const publicMessage = catalogued && isObject ? stringField(value, "publicMessage") : undefined
  const message =
    publicMessage !== undefined
      ? scrubLogString(publicMessage, rules)
      : rules.errorMessages === "scrubbed" && rawMessage !== undefined
        ? scrubLogString(rawMessage, rules).slice(0, ERROR_MESSAGE_LIMIT)
        : REDACTED_VALUE
  const rawStack = options.frames ?? (isObject ? stringField(value, "stack") : undefined) ?? ""
  const rawName = isObject ? (stringField(value, "name") ?? type) : type
  const stacktrace = scrubExceptionStack(rawStack, rawName, { rules, message: rawMessage ?? "" })
  return {
    type,
    message,
    stacktrace,
    fingerprint: exceptionFingerprint({ type, frames: frameFunctions(stacktrace), code }),
    ...(code !== undefined ? { code } : {}),
  }
}

/**
 * How a failed `Cause` exports. A defect, an interrupt, an uncatalogued error or a catalogued one
 * with status >= 500 is a fault: the span errors and carries the exception. A catalogued 4xx is a
 * refusal the caller caused: only its `error.code` is recorded.
 */
export function describeFailure(cause: Cause.Cause<unknown>, rules: ScrubRules): DescribedFailure {
  const dies = cause.reasons.filter(Cause.isDieReason)
  if (dies.length > 0) {
    return { errored: true, exception: describeException(dies[0]?.defect, rules) }
  }
  const failure = Cause.findErrorOption(cause)
  if (Option.isNone(failure)) {
    return { errored: true, exception: describeException({ name: "Interrupted" }, rules) }
  }
  const error: unknown = failure.value
  if (isAnyHeraError(error) && typeof error === "object" && error !== null) {
    const status = numberField(error, "httpStatus") ?? numberField(error, "status") ?? 500
    const code = stringField(error, "code")
    const errorFields = exportableErrorFields(error, rules)
    const fields = errorFields !== undefined ? { errorFields } : {}
    if (status < 500) {
      return { errored: false, ...(code !== undefined ? { errorCode: code } : {}), ...fields }
    }
    const exception = describeException(error, rules)
    return { errored: true, exception, ...(exception.code !== undefined ? { errorCode: exception.code } : {}), ...fields }
  }
  const exception = describeException(error, rules)
  return { errored: true, exception, ...(exception.code !== undefined ? { errorCode: exception.code } : {}) }
}
