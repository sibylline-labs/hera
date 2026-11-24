import { describe, expect, it } from "vitest"
import { givenOptional, HERA_RPC_META_MARK, type HeraFilledStub, propagatingStub } from "../src/server/rpc/index"

const TP = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`

interface Door {
  list(orgId: string, limit?: number): Promise<ReadonlyArray<string>>
  fetch(request: Request): Promise<Response>
}

function makeStub() {
  const calls: Array<{ readonly key: string; readonly args: ReadonlyArray<unknown> }> = []
  const record =
    (key: string) =>
    (...args: ReadonlyArray<unknown>) => {
      calls.push({ key, args })
      return Promise.resolve([])
    }
  const stub = {
    list: record("list"),
    fetch: record("fetch"),
    connect: record("connect"),
    [Symbol.dispose]: record("dispose"),
    name: "door",
  }
  return { calls, stub: stub as unknown as Door & typeof stub }
}

describe("propagatingStub", () => {
  // admits: algorithmic: the Proxy appends the meta after every declared argument on method calls
  // only, and passes fetch/connect/then and symbol-keyed members through; runtime dispatch no type sees.
  it("appends the marked meta to method calls and passes the transport members through", async () => {
    const { calls, stub } = makeStub()
    const door: HeraFilledStub<Door> = propagatingStub(stub, TP)
    // @ts-expect-error type rung: an omitted optional would leave a slot for the meta to fall into
    void (() => door.list("org"))
    await door.list("org", undefined)
    await door.fetch(new Request("https://do.test/"))
    await (door as unknown as { connect: () => Promise<unknown> }).connect()
    await (door as unknown as Record<symbol, () => Promise<unknown>>)[Symbol.dispose]?.()
    expect((door as unknown as { name: string }).name).toBe("door")
    expect(calls[0]?.args).toEqual(["org", undefined, { [HERA_RPC_META_MARK]: true, traceparent: TP }])
    expect(calls.slice(1).map((c) => [c.key, c.args.length])).toEqual([["fetch", 1], ["connect", 0], ["dispose", 0]])
    expect(propagatingStub(stub, undefined)).toBe(stub)
  })

  // admits: algorithmic: a callee reads a meta that landed in an optional's slot as omitted.
  it("givenOptional reads a slotted meta as omitted", () => {
    expect(givenOptional<number>({ [HERA_RPC_META_MARK]: true, traceparent: TP } as unknown as number)).toBeUndefined()
    expect(givenOptional(5)).toBe(5)
    expect(givenOptional(undefined)).toBeUndefined()
  })
})
