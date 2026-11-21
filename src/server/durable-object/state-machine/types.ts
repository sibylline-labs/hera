import * as Schema from "effect/Schema"
import { HeraError } from "../../../core/errors/index.js"
import type { HeraKeyedSyncTx, HeraSqlError, SyncEffect } from "../types.js"

/** A value `SqlStorage.exec` binds to a `?` placeholder. */
export type HeraSqlValue = string | number | null | ArrayBuffer

/**
 * Refusal of a `HeraStateMachine` declaration (thrown by `define`) or of a call that bypassed the
 * types (a defect inside the transaction, which rolls it back). Carries the table and a reason
 * built from the declaration's own literals, never row data.
 */
export const HeraStateMachineError = HeraError.define("HeraStateMachineError", {
  code: "internal_error",
  publicMessage: "Durable Object state machine refused a declaration or transition",
  fields: { table: Schema.String, reason: Schema.String },
})
export type HeraStateMachineError = InstanceType<typeof HeraStateMachineError>

/** The key column of a table, or every column of a composite primary key. */
export type HeraStateKeyColumns = string | readonly [string, ...ReadonlyArray<string>]

/** The key columns as a union of names. */
export type HeraStateKeyColumnNames<Pk> = Pk extends string
  ? Pk
  : Pk extends ReadonlyArray<infer C extends string>
    ? C
    : never

/** The value that addresses one row: a scalar, or one value per composite key column. */
export type HeraStateKey<Pk> = Pk extends string
  ? string | number
  : { readonly [Index in keyof Pk]: string | number }

type ExitsOf<T> = { readonly [K in keyof T]-?: NonNullable<T[K]> extends ReadonlyArray<infer X> ? X : never }

/** Every state some transition targets. */
export type HeraStateTargets<T> = ExitsOf<T>[keyof T]

/** The states with an edge to `To`: the legal members of a transition's `from`. */
export type HeraStateSources<T, To> = {
  readonly [K in keyof T]-?: NonNullable<T[K]> extends ReadonlyArray<infer X>
    ? [To] extends [X]
      ? K
      : never
    : never
}[keyof T] &
  string

type NonEmptyExitKeys<T> = {
  readonly [K in keyof T]-?: NonNullable<T[K]> extends readonly [] ? never : K
}[keyof T]

/**
 * `unknown` when every state is initial or the target of a transition; otherwise a property the
 * declaration cannot have, whose name and type report the unreachable states.
 */
export type NoUnreachableState<S extends string, I extends string, T> = [
  Exclude<S, I | HeraStateTargets<T>>,
] extends [never]
  ? unknown
  : { readonly "HeraStateMachine: unreachable state": Exclude<S, I | HeraStateTargets<T>> }

/**
 * `unknown` when every non-terminal state has at least one outgoing transition; otherwise a
 * property the declaration cannot have, naming the stranded states.
 */
export type NoDeadEndNonTerminal<S extends string, Term extends string, T> = [
  Exclude<S, Term | NonEmptyExitKeys<T>>,
] extends [never]
  ? unknown
  : {
      readonly "HeraStateMachine: non-terminal state with no exit": Exclude<
        S,
        Term | NonEmptyExitKeys<T>
      >
    }

type TransitionsShape<S extends string, T> = {
  readonly [K in keyof T]: K extends S ? ReadonlyArray<S> : never
}

/** The declaration `HeraStateMachine.define` takes; the totality checks sit on `transitions`. */
export interface HeraStateMachineSpec<
  Table extends string,
  Pk extends HeraStateKeyColumns,
  Col extends string,
  S extends string,
  I extends S,
  Term extends S,
  T,
> {
  readonly table: Table
  readonly pk: Pk
  readonly column: Col & NotNamedLike<Col, HeraStateKeyColumnNames<Pk>>
  readonly states: ReadonlyArray<S>
  readonly initial: ReadonlyArray<I>
  readonly terminal: ReadonlyArray<Term>
  readonly transitions: T &
    TransitionsShape<S, T> &
    NoUnreachableState<S, I, T> &
    NoDeadEndNonTerminal<S, Term, T>
}

/** The outcome of one compare-and-set transition: `count` rows moved; `matched` when any did. */
export interface HeraStateTransitionResult {
  readonly matched: boolean
  readonly count: number
}

/**
 * `W` when it is a non-empty string literal type. `never` for the wide `string` and for a template
 * literal type (`${string} OR 1=1`): both carry a runtime value. `{} extends Record<W, 1>` holds
 * exactly when `W` has no literal member to require.
 */
export type HeraLiteralSql<W extends string> = W &
  ({} extends Record<W, 1> ? never : W extends "" ? never : unknown)

/**
 * `unknown` when `Name` differs from every name in `Fixed` ignoring case (SQLite resolves
 * identifiers case-insensitively); otherwise `never`.
 */
type NotNamedLike<Name extends string, Fixed extends string> =
  Lowercase<Name> extends Lowercase<Fixed> ? never : unknown

/**
 * A `set` map whose keys are known at compile time and name neither the state column nor a key
 * column in any case. A wide `Record<string, …>` is refused: its keys are runtime values.
 */
export type HeraStateSetColumns<Set, Fixed extends string> = string extends keyof Set
  ? never
  : {
      readonly [K in keyof Set]: K extends string
        ? Lowercase<K> extends Lowercase<Fixed>
          ? never
          : HeraSqlValue
        : never
    }

/**
 * An `insert` row: the state column under its declared spelling in an initial state, and no other
 * key spelling the state column in another case.
 */
export type HeraStateInsertRow<Row, Col extends string, I extends string> = {
  readonly [K in keyof Row]: K extends Col
    ? I
    : K extends string
      ? Lowercase<K> extends Lowercase<Col>
        ? never
        : HeraSqlValue
      : never
} & { readonly [K in Col]: I }

export interface HeraStateTransitionOptions<
  From extends string,
  To extends string,
  Fixed extends string,
  W extends string,
  Set,
> {
  /** The states the row may be in; the update matches only while it is still in one of them. */
  readonly from: readonly [From, ...ReadonlyArray<From>]
  readonly to: To
  /** An extra literal SQL predicate ANDed into the `WHERE`; its `?` values go in `params`. */
  readonly where?: HeraLiteralSql<W>
  readonly params?: ReadonlyArray<HeraSqlValue>
  /** Other columns written in the same statement; never the state column or a key column. */
  readonly set?: Set & HeraStateSetColumns<Set, Fixed>
}

/** A declared state graph over one SQLite table, and the only writes its state column takes. */
export interface HeraStateMachineDefinition<
  Table extends string,
  Pk extends HeraStateKeyColumns,
  Col extends string,
  S extends string,
  I extends S,
  Term extends S,
  T,
> {
  readonly table: Table
  readonly pk: Pk
  readonly column: Col
  readonly states: ReadonlyArray<S>
  readonly initial: ReadonlyArray<I>
  readonly terminal: ReadonlyArray<Term>
  readonly transitions: T
  /**
   * `UPDATE … SET <column> = to WHERE <key> AND <column> IN (from) [AND (where)] RETURNING`, on the
   * transaction handle. A row that already left `from` is not touched: `{ matched: false }`.
   */
  readonly transition: <
    Owner extends string,
    To extends HeraStateTargets<T> & string,
    W extends string = never,
    Set extends Readonly<Record<string, HeraSqlValue>> = {},
  >(
    tx: HeraKeyedSyncTx<Owner>,
    key: HeraStateKey<Pk>,
    options: HeraStateTransitionOptions<
      HeraStateSources<T, To>,
      To,
      Col | HeraStateKeyColumnNames<Pk>,
      W,
      Set
    >
  ) => SyncEffect<HeraStateTransitionResult, HeraSqlError>
  /** `INSERT INTO <table> (…) VALUES (…)` with the state column in an initial state. */
  readonly insert: <Owner extends string, Row extends Readonly<Record<string, HeraSqlValue>>>(
    tx: HeraKeyedSyncTx<Owner>,
    row: Row & HeraStateInsertRow<Row, Col, I>
  ) => SyncEffect<void, HeraSqlError>
}
