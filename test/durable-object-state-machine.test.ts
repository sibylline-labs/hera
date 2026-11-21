import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { describe, expect, it } from "vitest"
import {
  Hera,
  HeraStateMachine,
  HeraStateMachineError,
  type HeraKeyedSyncTx,
  type HeraMigration,
  type HeraSqlError,
  type HeraStateTransitionResult,
  type SyncEffect,
} from "../src/index"
import { makeTestDurableObjectState } from "../src/testing/durable-object/index"

const MIGRATIONS: ReadonlyArray<HeraMigration> = [
  {
    version: 1,
    name: "001_lifecycles",
    sql: [
      "CREATE TABLE asks (id TEXT PRIMARY KEY, state TEXT NOT NULL, door TEXT, notice TEXT, version INTEGER NOT NULL DEFAULT 0)",
      "CREATE INDEX asks_state ON asks (state)",
      "CREATE TABLE label_pins (team_id TEXT NOT NULL, slot TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY (team_id, slot))",
      'CREATE TABLE "order" ("order" INTEGER PRIMARY KEY, "state" TEXT NOT NULL)',
    ],
  },
]

class Lifecycles extends Hera.KeyedDurableObject.configure({
  service: "lifecycles",
  migrations: MIGRATIONS,
}) {}

const ASKS = HeraStateMachine.define({
  table: "asks",
  pk: "id",
  column: "state",
  states: ["open", "snoozed", "answered", "withdrawn"],
  initial: ["open"],
  terminal: ["answered", "withdrawn"],
  transitions: { open: ["snoozed", "answered", "withdrawn"], snoozed: ["open", "withdrawn"] },
})

const LABEL_PINS = HeraStateMachine.define({
  table: "label_pins",
  pk: ["team_id", "slot"],
  column: "status",
  states: ["pending", "pinned"],
  initial: ["pending"],
  terminal: ["pinned"],
  transitions: { pending: ["pinned"] },
})

function makeObject(): Lifecycles {
  const harness = makeTestDurableObjectState({ idName: "estate", initialTimeMs: 1_700_000_000_000 })
  return new Lifecycles(harness.state, {}, { deliverOutboxBatch: () => undefined })
}

function seedAsk(object: Lifecycles, id: string, door = "two-way"): void {
  Effect.runSync(
    object.db.transactSync((tx) => ASKS.insert(tx, { id, state: "open", door }))
  )
}

function askRow(object: Lifecycles, id: string): Record<string, unknown> | undefined {
  return Effect.runSync(object.db.query("SELECT * FROM asks WHERE id = ?", [id]))[0]
}

function refusalOf<A, E>(exit: Exit.Exit<A, E>): unknown {
  if (Exit.isSuccess(exit)) return undefined
  expect(Cause.hasDies(exit.cause)).toBe(true)
  return Cause.squash(exit.cause)
}

describe("HeraStateMachine.transition", () => {
  // admits: a CAS that reports success without moving the row, or skips the `set` columns
  it("moves a row in a from state and writes set columns in the same statement", () => {
    const object = makeObject()
    seedAsk(object, "a1")
    const result = Effect.runSync(
      object.db.transactSync((tx) =>
        ASKS.transition(tx, "a1", { from: ["open"], to: "answered", set: { notice: "pending" } })
      )
    )
    expect(result).toEqual({ matched: true, count: 1 })
    expect(askRow(object, "a1")).toMatchObject({ state: "answered", notice: "pending" })
  })

  // admits: a lost CAS race overwriting a row that already moved
  it("matches nothing once the row has left every from state", () => {
    const object = makeObject()
    seedAsk(object, "a1")
    Effect.runSync(
      object.db.transactSync((tx) => ASKS.transition(tx, "a1", { from: ["open"], to: "withdrawn" }))
    )
    const late = Effect.runSync(
      object.db.transactSync((tx) =>
        ASKS.transition(tx, "a1", { from: ["open"], to: "answered", set: { notice: "pending" } })
      )
    )
    expect(late).toEqual({ matched: false, count: 0 })
    expect(askRow(object, "a1")).toMatchObject({ state: "withdrawn", notice: null })
  })

  // admits: multi-source transitions, missing rows, and `where` predicates being ignored
  it("accepts any listed from state, a missing key, and narrows by where + params", () => {
    const object = makeObject()
    seedAsk(object, "a1")
    seedAsk(object, "a2", "one-way")
    const run = (
      body: (tx: HeraKeyedSyncTx<string>) => SyncEffect<HeraStateTransitionResult, HeraSqlError>
    ) => Effect.runSync(object.db.transactSync(body))
    expect(run((tx) => ASKS.transition(tx, "a1", { from: ["open"], to: "snoozed" }))).toEqual({ matched: true, count: 1 })
    expect(run((tx) => ASKS.transition(tx, "a1", { from: ["open", "snoozed"], to: "withdrawn" }))).toEqual({ matched: true, count: 1 })
    expect(run((tx) => ASKS.transition(tx, "missing", { from: ["open"], to: "answered" }))).toEqual({ matched: false, count: 0 })
    const gated = (id: string) =>
      run((tx) =>
        ASKS.transition(tx, id, { from: ["open"], to: "answered", where: "door = ?", params: ["two-way"] })
      )
    expect(gated("a2")).toEqual({ matched: false, count: 0 })
    expect(askRow(object, "a2")).toMatchObject({ state: "open" })
  })

  // admits: the ABA race on a cyclic graph (open -> snoozed -> open) when callers guard on version
  it("closes the ABA case on a cycle with a version column in where + set", () => {
    const object = makeObject()
    seedAsk(object, "a1")
    const staleVersion = 0
    const bump = (version: number) =>
      Effect.runSync(
        object.db.transactSync((tx) =>
          ASKS.transition(tx, "a1", {
            from: ["open"],
            to: "snoozed",
            where: "version = ?",
            params: [version],
            set: { version: version + 1 },
          })
        )
      )
    expect(bump(staleVersion)).toEqual({ matched: true, count: 1 })
    Effect.runSync(
      object.db.transactSync((tx) =>
        ASKS.transition(tx, "a1", { from: ["snoozed"], to: "open", where: "version = ?", params: [1], set: { version: 2 } })
      )
    )
    expect(askRow(object, "a1")).toMatchObject({ state: "open", version: 2 })
    expect(bump(staleVersion)).toEqual({ matched: false, count: 0 })
  })

  // admits: a composite key matching on only its first column
  it("addresses a composite key by every key column", () => {
    const object = makeObject()
    Effect.runSync(
      object.db.transactSync(function* (tx) {
        yield* LABEL_PINS.insert(tx, { team_id: "t1", slot: "docs", status: "pending" })
        yield* LABEL_PINS.insert(tx, { team_id: "t1", slot: "yak", status: "pending" })
      })
    )
    const result = Effect.runSync(
      object.db.transactSync((tx) =>
        LABEL_PINS.transition(tx, ["t1", "docs"], { from: ["pending"], to: "pinned" })
      )
    )
    expect(result).toEqual({ matched: true, count: 1 })
    const rows = Effect.runSync(object.db.query("SELECT slot, status FROM label_pins ORDER BY slot"))
    expect(rows).toEqual([
      { slot: "docs", status: "pinned" },
      { slot: "yak", status: "pending" },
    ])
  })

  // admits: a transition committing while the outbox write beside it rolls back, or vice versa
  it("commits with its outbox event, and a later defect rolls both back", () => {
    const object = makeObject()
    seedAsk(object, "a1")
    const exit = Effect.runSyncExit(
      object.db.transactWithOutbox(function* (tx) {
        yield* ASKS.transition(tx, "a1", { from: ["open"], to: "answered" })
        yield* tx.enqueueOutbox({ type: "ask.answered@1", payload: { id: "a1" } })
        return yield* tx.die(new Error("after the transition"))
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(askRow(object, "a1")).toMatchObject({ state: "open" })
    expect(object.getPendingOutboxRecords()).toHaveLength(0)

    Effect.runSync(
      object.db.transactWithOutbox(function* (tx) {
        yield* ASKS.transition(tx, "a1", { from: ["open"], to: "answered" })
        yield* tx.enqueueOutbox({ type: "ask.answered@1", payload: { id: "a1" } })
      })
    )
    expect(askRow(object, "a1")).toMatchObject({ state: "answered" })
    expect(object.getPendingOutboxRecords()).toHaveLength(1)
  })

  // admits: SQL keyword identifiers breaking the generated statement
  it("quotes identifiers so keyword-named tables and columns work", () => {
    const object = makeObject()
    const ORDERS = HeraStateMachine.define({
      table: "order",
      pk: "order",
      column: "state",
      states: ["placed", "shipped"],
      initial: ["placed"],
      terminal: ["shipped"],
      transitions: { placed: ["shipped"] },
    })
    const result = Effect.runSync(
      object.db.transactSync(function* (tx) {
        yield* ORDERS.insert(tx, { order: 7, state: "placed" })
        return yield* ORDERS.transition(tx, 7, { from: ["placed"], to: "shipped" })
      })
    )
    expect(result).toEqual({ matched: true, count: 1 })
  })
})

describe("HeraStateMachine refusals for untyped callers", () => {
  // admits: a call that bypassed the types writing anyway
  it.each([
    ["an illegal pair", "a1", { from: ["answered"], to: "withdrawn" }, /illegal transition answered -> withdrawn/],
    ["an empty from", "a1", { from: [], to: "answered" }, /from must name at least one state/],
    ["set on the state column", "a1", { from: ["open"], to: "answered", set: { state: "withdrawn" } }, /set cannot write state/],
    ["set on the key", "a1", { from: ["open"], to: "answered", set: { id: "a9" } }, /set cannot write id/],
    ["set on the state column in another case", "a1", { from: ["open"], to: "answered", set: { STATE: "bogus" } }, /set cannot write STATE/],
    ["set on the key in another case", "a1", { from: ["open"], to: "answered", set: { ID: "zzz" } }, /set cannot write ID/],
    ["a where that closes its parenthesis", "a1", { from: ["open"], to: "answered", where: "1=1) OR (1=1" }, /where must be one balanced predicate/],
    ["a where with a statement separator", "a1", { from: ["open"], to: "answered", where: "1=1; DELETE FROM asks" }, /where must be one balanced predicate/],
    ["a where with a comment", "a1", { from: ["open"], to: "answered", where: "1=1 --" }, /where must be one balanced predicate/],
    ["an empty where", "a1", { from: ["open"], to: "answered", where: " " }, /where must be one balanced predicate/],
    ["a where hiding a parenthesis in a $name( parameter", "a1", { from: ["open"], to: "answered", where: "$a(') IS NULL) OR (1=1 OR $b(') IS NULL" }, /where must be one balanced predicate/],
    ["a where with a named parameter", "a1", { from: ["open"], to: "answered", where: "door = :door" }, /where must be one balanced predicate/],
    ["a where with a numbered parameter", "a1", { from: ["open"], to: "answered", where: "door = ?1" }, /where must be one balanced predicate/],
    ["a non-identifier set column", "a1", { from: ["open"], to: "answered", set: { "x; DROP TABLE asks": 1 } }, /not a plain SQL identifier/],
    ["params without where", "a1", { from: ["open"], to: "answered", params: [1] }, /params bind only to a where clause/],
    ["a missing key", undefined, { from: ["open"], to: "answered" }, /key must be 1 string or number/],
  ])("dies on %s and rolls the transaction back", (_label, key, options, reason) => {
    const object = makeObject()
    seedAsk(object, "a1")
    const exit = Effect.runSyncExit(
      object.db.transactSync(function* (tx) {
        yield* tx.exec("UPDATE asks SET notice = 'touched' WHERE id = 'a1'")
        return yield* ASKS.transition(tx, key as never, options as never)
      })
    )
    const refusal = refusalOf(exit)
    expect(HeraStateMachineError.is(refusal)).toBe(true)
    expect((refusal as HeraStateMachineError).reason).toMatch(reason)
    expect(askRow(object, "a1")).toMatchObject({ state: "open", notice: null })
  })

  // admits: a composite key of the wrong arity matching more than one row
  it("dies on a composite key of the wrong arity", () => {
    const object = makeObject()
    const exit = Effect.runSyncExit(
      object.db.transactSync((tx) =>
        LABEL_PINS.transition(tx, ["t1"] as never, { from: ["pending"], to: "pinned" })
      )
    )
    expect((refusalOf(exit) as HeraStateMachineError).reason).toMatch(/key must be 2/)
  })

  // admits: a second, differently cased spelling of the state column smuggling a non-initial state
  it("dies on an insert that names a column twice in different cases", () => {
    const object = makeObject()
    seedAsk(object, "a0")
    const exit = Effect.runSyncExit(
      object.db.transactSync((tx) =>
        ASKS.insert(tx, { id: "b", STATE: "answered", state: "open" } as never)
      )
    )
    expect((refusalOf(exit) as HeraStateMachineError).reason).toMatch(/names state twice/)
    expect(askRow(object, "b")).toBeUndefined()
  })

  // admits: a row born in a non-initial state
  it("dies on an insert outside the initial states", () => {
    const object = makeObject()
    seedAsk(object, "a0")
    const exit = Effect.runSyncExit(
      object.db.transactSync((tx) => ASKS.insert(tx, { id: "a1", state: "answered" } as never))
    )
    expect((refusalOf(exit) as HeraStateMachineError).reason).toMatch(/initial state, got answered/)
    expect(askRow(object, "a1")).toBeUndefined()
  })
})

describe("HeraStateMachine.define refusals", () => {
  const base = {
    table: "asks",
    pk: "id",
    column: "state",
    states: ["open", "answered"],
    initial: ["open"],
    terminal: ["answered"],
    transitions: { open: ["answered"] },
  }
  // admits: an untyped declaration that the types would refuse being accepted at runtime
  it.each([
    ["a non-identifier table", { table: "asks; --" }, /plain SQL identifiers/],
    ["a non-identifier key column", { pk: ["id", "a b"] }, /pk must be/],
    ["the state column as a key", { pk: "state" }, /state column cannot be a key column/],
    ["empty states", { states: [], initial: [], terminal: [], transitions: {} }, /states must be a non-empty list/],
    ["duplicate states", { states: ["open", "open", "answered"] }, /distinct names/],
    ["an initial outside states", { initial: ["fresh"] }, /initial must be a non-empty subset/],
    ["a terminal outside states", { terminal: ["done"] }, /terminal must be a subset/],
    ["a target outside states", { transitions: { open: ["answered", "lost"] } }, /must name declared states/],
    ["an unreachable state", { states: ["open", "answered", "expired"], terminal: ["answered", "expired"] }, /unreachable state: expired/],
    ["a stranded state named like an Object member", { states: ["new", "constructor", "answered"], initial: ["new"], transitions: { new: ["constructor", "answered"] } }, /non-terminal state with no exit: constructor/],
    ["a state column that is a key in another case", { pk: "STATE" }, /state column cannot be a key column/],
    ["a key column listed twice in different cases", { pk: ["id", "ID"] }, /pk must be/],
    ["a stranded state", { states: ["new", "open", "answered"], initial: ["new"], transitions: { new: ["open", "answered"] } }, /non-terminal state with no exit: open/],
  ])("throws HeraStateMachineError on %s", (_label, override, reason) => {
    const define = HeraStateMachine.define as (spec: unknown) => unknown
    let thrown: unknown
    try {
      define({ ...base, ...override })
    } catch (error) {
      thrown = error
    }
    expect(HeraStateMachineError.is(thrown)).toBe(true)
    expect((thrown as HeraStateMachineError).reason).toMatch(reason)
  })

  // admits: the declared graph leaking a mutable alias of the caller's arrays
  it("exposes the declared graph frozen", () => {
    expect(ASKS.table).toBe("asks")
    expect(ASKS.transitions.open).toEqual(["snoozed", "answered", "withdrawn"])
    expect(Object.isFrozen(ASKS)).toBe(true)
    expect(Object.isFrozen(ASKS.transitions.open)).toBe(true)
    expect(LABEL_PINS.pk).toEqual(["team_id", "slot"])
  })
})
