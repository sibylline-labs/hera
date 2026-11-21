import * as Tracer from "effect/Tracer"
import { describe, expect, it } from "vitest"
import { extractTrailingRpcMeta, formatTraceparent, parseTraceparent } from "../src/index"

const TRACE = "0af7651916cd43dd8448eb211c80319c"
const SPAN = "b7ad6b7169203331"

describe("W3C traceparent codec", () => {
  // admits: a wire string from another isolate; no type constrains its shape
  it.each([
    [`00-${TRACE}-${SPAN}-01`, { traceId: TRACE, spanId: SPAN, sampled: true }],
    [`00-${TRACE}-${SPAN}-00`, { traceId: TRACE, spanId: SPAN, sampled: false }],
    [`00-${TRACE.toUpperCase()}-${SPAN}-01`, undefined],
    [`00-${"0".repeat(32)}-${SPAN}-01`, undefined],
    [`00-${TRACE}-${"0".repeat(16)}-01`, undefined],
    [`ff-${TRACE}-${SPAN}-01`, undefined],
    [`00-${TRACE}-${SPAN}`, undefined],
    [`00-${TRACE}-${SPAN}-01-extra`, undefined],
    ["garbage", undefined],
    [42, undefined],
  ])("parses %s", (value, expected) => {
    const span = parseTraceparent(value)
    if (expected === undefined) {
      expect(span).toBeUndefined()
    } else {
      expect(span).toMatchObject({ _tag: "ExternalSpan", ...expected })
    }
  })

  // admits: format must round-trip what parse accepts
  it("formats a span and round-trips it", () => {
    const span = Tracer.externalSpan({ traceId: TRACE, spanId: SPAN, sampled: true })
    const tp = formatTraceparent(span)
    expect(tp).toBe(`00-${TRACE}-${SPAN}-01`)
    expect(parseTraceparent(tp)).toMatchObject({ traceId: TRACE, spanId: SPAN })
    expect(formatTraceparent(Tracer.externalSpan({ traceId: "abc", spanId: SPAN }))).toBeUndefined()
  })

  // admits: argument splitting is a runtime shape
  it("splits only a marked trailing meta", () => {
    expect(extractTrailingRpcMeta([{ a: 1 }, { __heraRpcMeta: true }]).args).toEqual([{ a: 1 }])
    expect(extractTrailingRpcMeta([{ a: 1 }, { requestId: "r" }]).meta).toBeUndefined()
    expect(extractTrailingRpcMeta([]).meta).toBeUndefined()
  })
})
