// HeraStateMachine.define as a consumer Worker sees it: every
// `@ts-expect-error` below is a declaration or call the funnel must refuse at compile time.
import {
  HeraStateMachine,
  type HeraKeyedSqlClient,
  type HeraSqlClient,
  type HeraStateTransitionResult,
} from "@sibylline-labs/hera/durable-object"

export const ASKS = HeraStateMachine.define({
  table: "asks",
  pk: "id",
  column: "state",
  states: ["open", "answered", "withdrawn"],
  initial: ["open"],
  terminal: ["answered", "withdrawn"],
  transitions: { open: ["answered", "withdrawn"] },
})

// The PRD's spelling, with `as const` tuples, is the same machine.
export const ASKS_AS_CONST = HeraStateMachine.define({
  table: "asks",
  pk: "id",
  column: "state",
  states: ["open", "answered", "withdrawn"] as const,
  initial: ["open"] as const,
  terminal: ["answered", "withdrawn"] as const,
  transitions: { open: ["answered", "withdrawn"] },
})

export const LABEL_PINS = HeraStateMachine.define({
  table: "label_pins",
  pk: ["team_id", "slot"],
  column: "status",
  states: ["pending", "pinned"],
  initial: ["pending"],
  terminal: ["pinned"],
  transitions: { pending: ["pinned"] },
})

declare const tenantDb: HeraSqlClient
declare const keyedDb: HeraKeyedSqlClient

export const answered = tenantDb.transactSync(function* (tx) {
  yield* ASKS.insert(tx, { id: "a1", state: "open", json: "{}" })
  const result = yield* ASKS.transition(tx, "a1", {
    from: ["open"],
    to: "answered",
    where: "door = ?",
    params: ["two-way"],
    set: { json: "{}", notice: "pending" },
  })
  const typed: HeraStateTransitionResult = result
  return typed.matched
})

export const pinned = keyedDb.transactWithOutbox(function* (tx) {
  return yield* LABEL_PINS.transition(tx, ["team_1", "docs"], { from: ["pending"], to: "pinned" })
})

export const refusedCalls = tenantDb.transactSync(function* (tx) {
  // @ts-expect-error answered is terminal: no answered -> withdrawn edge
  yield* ASKS.transition(tx, "a1", { from: ["answered"], to: "withdrawn" })
  // @ts-expect-error open is not a target of any transition
  yield* ASKS.transition(tx, "a1", { from: ["open"], to: "open" })
  // @ts-expect-error from must name at least one state
  yield* ASKS.transition(tx, "a1", { from: [], to: "answered" })
  // @ts-expect-error a row is born only in an initial state
  yield* ASKS.insert(tx, { id: "a2", state: "answered" })
  // @ts-expect-error the state column moves only through `to`
  yield* ASKS.transition(tx, "a1", { from: ["open"], to: "answered", set: { state: "withdrawn" } })
  // @ts-expect-error a key column is never rewritten
  yield* ASKS.transition(tx, "a1", { from: ["open"], to: "answered", set: { id: "a9" } })
  // @ts-expect-error a composite key names every key column
  yield* LABEL_PINS.transition(tx, ["team_1"], { from: ["pending"], to: "pinned" })
  // @ts-expect-error SQLite names are case-insensitive: STATE is the state column
  yield* ASKS.transition(tx, "a1", { from: ["open"], to: "answered", set: { STATE: "withdrawn" } })
  // @ts-expect-error ID is the key column
  yield* ASKS.transition(tx, "a1", { from: ["open"], to: "answered", set: { Id: "a9" } })
  // @ts-expect-error a second spelling of the state column smuggles a non-initial state
  yield* ASKS.insert(tx, { id: "a3", state: "open", STATE: "answered" })
  // @ts-expect-error set keys are known at compile time, so a wide map cannot hide the state column
  yield* ASKS.transition(tx, "a1", { from: ["open"], to: "answered", set: wideSet })
  // @ts-expect-error an empty where is not a predicate
  yield* ASKS.transition(tx, "a1", { from: ["open"], to: "answered", where: "" })
  return true
})

declare const wideSet: Record<string, string>
declare const userInput: string
const templated = `${userInput} OR 1=1` as const
export const templateWhere = tenantDb.transactSync((tx) =>
  // @ts-expect-error a template literal type still carries a runtime string
  ASKS.transition(tx, "a1", { from: ["open"], to: "answered", where: templated })
)

declare const door: string
export const nonLiteralWhere = tenantDb.transactSync((tx) =>
  // @ts-expect-error `where` is a literal SQL fragment; values go through `params`
  ASKS.transition(tx, "a1", { from: ["open"], to: "answered", where: `door = '${door}'` })
)

// @ts-expect-error the funnel runs on a transaction handle, never the object's `db`
export const outsideTx = ASKS.transition(tenantDb, "a1", { from: ["open"], to: "answered" })

export const unreachable = HeraStateMachine.define({
  table: "asks",
  pk: "id",
  column: "state",
  states: ["open", "answered", "expired"],
  initial: ["open"],
  terminal: ["answered", "expired"],
  // @ts-expect-error expired is declared but no transition reaches it
  transitions: { open: ["answered"] },
})

export const stranded = HeraStateMachine.define({
  table: "drift_cases",
  pk: "id",
  column: "status",
  states: ["new", "open", "resolved"],
  initial: ["new"],
  terminal: ["resolved"],
  // @ts-expect-error open is not terminal and has no way out
  transitions: { new: ["open", "resolved"] },
})

export const emptyExit = HeraStateMachine.define({
  table: "drift_cases",
  pk: "id",
  column: "status",
  states: ["new", "open", "resolved"],
  initial: ["new"],
  terminal: ["resolved"],
  // @ts-expect-error an empty exit list strands open as surely as a missing one
  transitions: { new: ["open", "resolved"], open: [] },
})

export const initialOutside = HeraStateMachine.define({
  table: "t",
  pk: "id",
  column: "status",
  states: ["new", "done"],
  // @ts-expect-error initial is a subset of states
  initial: ["fresh"],
  terminal: ["done"],
  transitions: { new: ["done"] },
})

export const terminalOutside = HeraStateMachine.define({
  table: "t",
  pk: "id",
  column: "status",
  states: ["new", "done"],
  initial: ["new"],
  // @ts-expect-error terminal is a subset of states
  terminal: ["finished"],
  transitions: { new: ["done"] },
})

export const columnIsKey = HeraStateMachine.define({
  table: "t",
  pk: "status",
  // @ts-expect-error the state column is never a key column
  column: "STATUS",
  states: ["new", "done"],
  initial: ["new"],
  terminal: ["done"],
  transitions: { new: ["done"] },
})

export const targetOutside = HeraStateMachine.define({
  table: "t",
  pk: "id",
  column: "status",
  states: ["new", "done"],
  initial: ["new"],
  terminal: ["done"],
  // @ts-expect-error every target is a declared state
  transitions: { new: ["done", "lost"] },
})
