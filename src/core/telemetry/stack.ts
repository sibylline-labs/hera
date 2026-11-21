import { scrubLogString } from "../logger/redaction.js"
import { GITLEAKS_SHAPES } from "../logger/gitleaks.js"
import type { RedactionRules } from "../logger/types.js"
import { MAX_STACK_FRAMES } from "./types.js"

const DEFAULT_RULES: RedactionRules = { secretShapes: GITLEAKS_SHAPES }
const MAX_FRAME_LENGTH = 300
/** A V8 frame (`    at fn (file:1:2)`) or a JavaScriptCore frame (`fn@file:1:2`). */
const V8_FRAME = /^\s*at\s/
const JSC_FRAME = /^[^\s@]*@\S*:\d+:\d+$/
/** An identifier-shaped name; anything else is not trusted as one. */
const SAFE_NAME = /^[A-Za-z_$][\w$.]{0,63}$/
const SAFE_FN = /^[\w$.<>[\]]{1,128}$/
/** A URL query or fragment, kept off the frame up to its `:line:col` when there is one. */
const QUERY = /[?#][^\s)]*?(?=:\d+:\d+\)?$|\)|$)/g

function isFrame(line: string): boolean {
  return V8_FRAME.test(line) || JSC_FRAME.test(line.trim())
}

/**
 * The error's type as safe to export: an identifier that no credential shape touches, else
 * `"Error"`. A name is caller text: `ghp_…` is identifier-shaped too.
 */
export function safeErrorName(name: unknown): string {
  return typeof name === "string" && SAFE_NAME.test(name) && scrubLogString(name, DEFAULT_RULES) === name ? name : "Error"
}

function scrubFrame(line: string, rules: RedactionRules): string {
  const withoutQuery = line.replace(QUERY, "")
  return scrubLogString(withoutQuery, rules).slice(0, MAX_FRAME_LENGTH)
}

export interface ScrubStackOptions {
  readonly rules?: RedactionRules | undefined
  /** The error's raw message: its header is cut by length, so a message line shaped like a frame never survives. */
  readonly message?: string | undefined
}

/** `stack` minus its `Name: message` header when the header is exactly that. */
function cutHeader(stack: string, name: string, message: string | undefined): string {
  if (message === undefined) return stack
  const head = message === "" ? name : `${name}: ${message}`
  return stack.startsWith(head) ? stack.slice(head.length) : stack
}

/**
 * `stack` with every line before the first frame (the `Name: message` header, which may span
 * lines) replaced by `Name: [REDACTED]`, each frame stripped of URL queries and scrubbed with
 * Hera's shapes, `GITLEAKS_SHAPES` and the consumer's `rules`, and at most 50 frames kept.
 */
export function scrubExceptionStack(stack: string, name: string, options: ScrubStackOptions = {}): string {
  const rules = options.rules
  const merged: RedactionRules = {
    ...(rules?.secretKeys !== undefined ? { secretKeys: rules.secretKeys } : {}),
    secretShapes: [...GITLEAKS_SHAPES, ...(rules?.secretShapes ?? [])],
  }
  const frames = cutHeader(stack, name, options.message)
    .split("\n")
    .filter(isFrame)
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => scrubFrame(line, rules === undefined ? DEFAULT_RULES : merged))
  return [`${safeErrorName(name)}: [REDACTED]`, ...frames].join("\n")
}

function frameFunction(line: string): string {
  const trimmed = line.trim()
  let fn: string
  if (V8_FRAME.test(line)) {
    const body = trimmed.replace(/^at\s+/, "").replace(/^async\s+/, "").replace(/^new\s+/, "")
    const open = body.lastIndexOf(" (")
    fn = open > 0 ? body.slice(0, open).replace(/\s+\[as [^\]]*\]$/, "") : "<anonymous>"
  } else {
    const at = trimmed.indexOf("@")
    fn = at > 0 ? trimmed.slice(0, at) : "<anonymous>"
  }
  return SAFE_FN.test(fn) && scrubLogString(fn) === fn ? fn : "<anonymous>"
}

/** The function names of a stack's frames, in order; a name that is not identifier-shaped reads `<anonymous>`. */
export function frameFunctions(stack: string): ReadonlyArray<string> {
  return stack.split("\n").filter(isFrame).slice(0, MAX_STACK_FRAMES).map(frameFunction)
}
