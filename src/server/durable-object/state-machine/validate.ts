import { isBalancedPredicate, isSqlIdentifier } from "./sql.js"
import { HeraStateMachineError, type HeraSqlValue } from "./types.js"

/** A declaration after its runtime checks: the same rules the types hold, for untyped callers. */
export interface StateGraph {
  readonly table: string
  readonly keyColumns: ReadonlyArray<string>
  readonly column: string
  readonly states: ReadonlySet<string>
  readonly initial: ReadonlySet<string>
  readonly exits: ReadonlyMap<string, ReadonlySet<string>>
}

export interface UntypedSpec {
  readonly table: unknown
  readonly pk: unknown
  readonly column: unknown
  readonly states: unknown
  readonly initial: unknown
  readonly terminal: unknown
  readonly transitions: unknown
}

function stringList(value: unknown): ReadonlyArray<string> | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
    ? (value as ReadonlyArray<string>)
    : undefined
}

/** SQLite resolves identifiers case-insensitively, so names compare folded. */
const fold = (name: string): string => name.toLowerCase()

function hasFoldedDuplicate(names: ReadonlyArray<string>): boolean {
  return new Set(names.map(fold)).size !== names.length
}

function specRefusal(spec: UntypedSpec): string | undefined {
  const keyColumns = typeof spec.pk === "string" ? [spec.pk] : stringList(spec.pk)
  if (!isSqlIdentifier(spec.table) || !isSqlIdentifier(spec.column)) {
    return "table and column must be plain SQL identifiers"
  }
  if (
    keyColumns === undefined ||
    keyColumns.length === 0 ||
    !keyColumns.every(isSqlIdentifier) ||
    hasFoldedDuplicate(keyColumns)
  ) {
    return "pk must be a plain SQL identifier or a non-empty list of them"
  }
  if (keyColumns.map(fold).includes(fold(spec.column))) {
    return "the state column cannot be a key column"
  }
  const states = stringList(spec.states)
  if (states === undefined || states.length === 0 || new Set(states).size !== states.length) {
    return "states must be a non-empty list of distinct names"
  }
  const declared = new Set(states)
  const initial = stringList(spec.initial)
  const terminal = stringList(spec.terminal)
  if (initial === undefined || initial.length === 0 || !initial.every((s) => declared.has(s))) {
    return "initial must be a non-empty subset of states"
  }
  if (terminal === undefined || !terminal.every((s) => declared.has(s))) {
    return "terminal must be a subset of states"
  }
  if (typeof spec.transitions !== "object" || spec.transitions === null) {
    return "transitions must be an object of state to target states"
  }
  const reached = new Set(initial)
  const exits = new Map<string, ReadonlyArray<string>>()
  for (const [from, targets] of Object.entries(spec.transitions)) {
    const list = stringList(targets)
    if (!declared.has(from) || list === undefined || !list.every((s) => declared.has(s))) {
      return `transitions from ${from} must name declared states`
    }
    exits.set(from, list)
    for (const target of list) reached.add(target)
  }
  const unreachable = states.filter((s) => !reached.has(s))
  if (unreachable.length > 0) {
    return `unreachable state: ${unreachable.join(", ")}`
  }
  const stranded = states.filter((s) => !terminal.includes(s) && (exits.get(s)?.length ?? 0) === 0)
  if (stranded.length > 0) {
    return `non-terminal state with no exit: ${stranded.join(", ")}`
  }
  return undefined
}

/** Checks a declaration; throws `HeraStateMachineError` naming the first rule it breaks. */
export function validateStateMachineSpec(spec: UntypedSpec): StateGraph {
  const reason = specRefusal(spec)
  const table = typeof spec.table === "string" ? spec.table : "<invalid>"
  if (reason !== undefined) {
    throw new HeraStateMachineError({ table, reason })
  }
  const exits = new Map<string, ReadonlySet<string>>()
  for (const [from, targets] of Object.entries(
    spec.transitions as Readonly<Record<string, ReadonlyArray<string>>>
  )) {
    exits.set(from, new Set(targets))
  }
  return {
    table,
    keyColumns: typeof spec.pk === "string" ? [spec.pk] : [...(spec.pk as ReadonlyArray<string>)],
    column: spec.column as string,
    states: new Set(spec.states as ReadonlyArray<string>),
    initial: new Set(spec.initial as ReadonlyArray<string>),
    exits,
  }
}

function isKeyValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number"
}

/** The key as one value per key column, or `undefined` when its arity or types are wrong. */
export function keyValues(graph: StateGraph, key: unknown): ReadonlyArray<string | number> | undefined {
  const values = graph.keyColumns.length === 1 && !Array.isArray(key) ? [key] : key
  return Array.isArray(values) &&
    values.length === graph.keyColumns.length &&
    values.every(isKeyValue)
    ? (values as ReadonlyArray<string | number>)
    : undefined
}

/** Why a column map cannot be written beside the state column, or `undefined` when it can. */
export function columnsRefusal(
  graph: StateGraph,
  columns: ReadonlyArray<string>,
  allowKeys: boolean
): string | undefined {
  const seen = new Set<string>()
  const fixed = new Set([graph.column, ...graph.keyColumns].map(fold))
  for (const name of columns) {
    if (!isSqlIdentifier(name)) return `${name} is not a plain SQL identifier`
    if (seen.has(fold(name))) return `the row names ${name} twice`
    seen.add(fold(name))
    if (!allowKeys && fixed.has(fold(name))) {
      return `set cannot write ${name}: the state column moves only through to, a key never moves`
    }
  }
  return undefined
}

/** Why a transition call is illegal for the graph, or `undefined` when it is legal. */
export function transitionRefusal(
  graph: StateGraph,
  from: unknown,
  to: unknown,
  where: unknown,
  params: ReadonlyArray<HeraSqlValue> | undefined
): string | undefined {
  if (!Array.isArray(from) || from.length === 0) return "from must name at least one state"
  for (const source of from) {
    if (typeof source !== "string" || graph.exits.get(source)?.has(to as string) !== true) {
      return `illegal transition ${String(source)} -> ${String(to)}`
    }
  }
  if (where !== undefined && (typeof where !== "string" || !isBalancedPredicate(where))) {
    return "where must be one balanced predicate (no ;, comments or unbalanced parentheses)"
  }
  if (params !== undefined && where === undefined) return "params bind only to a where clause"
  return undefined
}
