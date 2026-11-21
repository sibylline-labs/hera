import { SyncTx } from "../sql/sync-tx.js"
import type { HeraKeyedSyncTx, HeraSqlError, SyncEffect } from "../types.js"
import { buildInsertSql, buildTransitionSql } from "./sql.js"
import {
  HeraStateMachineError,
  type HeraSqlValue,
  type HeraStateKeyColumns,
  type HeraStateMachineDefinition,
  type HeraStateMachineSpec,
  type HeraStateTransitionResult,
} from "./types.js"
import {
  columnsRefusal,
  keyValues,
  type StateGraph,
  transitionRefusal,
  validateStateMachineSpec,
} from "./validate.js"

interface UntypedTransition {
  readonly from: unknown
  readonly to: unknown
  readonly where?: unknown
  readonly params?: ReadonlyArray<HeraSqlValue> | undefined
  readonly set?: Readonly<Record<string, HeraSqlValue>> | undefined
}

function refuse(graph: StateGraph, reason: string): SyncEffect<never> {
  return SyncTx.die(new HeraStateMachineError({ table: graph.table, reason }))
}

function runTransition(
  graph: StateGraph,
  tx: HeraKeyedSyncTx<string>,
  key: unknown,
  options: UntypedTransition
): SyncEffect<HeraStateTransitionResult, HeraSqlError> {
  const refusal = transitionRefusal(graph, options.from, options.to, options.where, options.params)
  if (refusal !== undefined) return refuse(graph, refusal)
  const keys = keyValues(graph, key)
  if (keys === undefined) {
    return refuse(graph, `key must be ${graph.keyColumns.length} string or number value(s)`)
  }
  const set = Object.entries(options.set ?? {})
  const setColumns = set.map(([name]) => name)
  const columnRefusal = columnsRefusal(graph, setColumns, false)
  if (columnRefusal !== undefined) return refuse(graph, columnRefusal)
  const from = options.from as ReadonlyArray<string>
  const sql = buildTransitionSql({
    table: graph.table,
    keyColumns: graph.keyColumns,
    column: graph.column,
    setColumns,
    fromCount: from.length,
    where: options.where as string | undefined,
  })
  const params = [
    options.to,
    ...set.map(([, value]) => value),
    ...keys,
    ...from,
    ...(options.params ?? []),
  ]
  return SyncTx.map(tx.exec(sql, params), (result) => ({
    matched: result.rows.length > 0,
    count: result.rows.length,
  }))
}

function runInsert(
  graph: StateGraph,
  tx: HeraKeyedSyncTx<string>,
  row: Readonly<Record<string, HeraSqlValue>>
): SyncEffect<void, HeraSqlError> {
  const entries = Object.entries(row)
  const stateSpellings = entries.filter(([name]) => name.toLowerCase() === graph.column.toLowerCase())
  if (stateSpellings.length > 1) {
    return refuse(graph, `the row names ${graph.column} twice`)
  }
  const state = row[graph.column]
  if (typeof state !== "string" || !graph.initial.has(state)) {
    return refuse(graph, `insert must start in an initial state, got ${String(state)}`)
  }
  const columnRefusal = columnsRefusal(graph, entries.map(([name]) => name), true)
  if (columnRefusal !== undefined) return refuse(graph, columnRefusal)
  const sql = buildInsertSql(graph.table, entries.map(([name]) => name))
  return SyncTx.map(tx.exec(sql, entries.map(([, value]) => value)), () => undefined)
}

function frozenCopy<A>(value: A): A {
  if (Array.isArray(value)) return Object.freeze([...value]) as A
  if (typeof value === "object" && value !== null) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([k, v]) => [k, frozenCopy(v)]))
    ) as A
  }
  return value
}

/**
 * Declares the state graph of one SQLite table's lifecycle column. The types refuse a declaration
 * with an unreachable state, a non-terminal state without an exit, or a name outside `states`; the
 * same rules run here for untyped callers, throwing `HeraStateMachineError` at declaration time.
 * Does no I/O.
 */
export function defineStateMachine<
  const Table extends string,
  const Pk extends HeraStateKeyColumns,
  const Col extends string,
  const S extends string,
  const I extends S,
  const Term extends S,
  const T extends { readonly [K in S]?: ReadonlyArray<S> },
>(
  spec: HeraStateMachineSpec<Table, Pk, Col, S, I, Term, T>
): HeraStateMachineDefinition<Table, Pk, Col, S, I, Term, T> {
  const graph = validateStateMachineSpec(spec)
  const machine: HeraStateMachineDefinition<Table, Pk, Col, S, I, Term, T> = {
    table: spec.table,
    pk: frozenCopy(spec.pk),
    column: spec.column,
    states: frozenCopy(spec.states),
    initial: frozenCopy(spec.initial),
    terminal: frozenCopy(spec.terminal),
    transitions: frozenCopy(spec.transitions) as T,
    transition: (tx, key, options) =>
      runTransition(graph, tx, key, options as UntypedTransition),
    insert: (tx, row) => runInsert(graph, tx, row),
  }
  return Object.freeze(machine)
}
