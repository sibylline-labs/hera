import { defineStateMachine } from "./define.js"

export {
  HeraStateMachineError,
  type HeraLiteralSql,
  type HeraSqlValue,
  type HeraStateKey,
  type HeraStateKeyColumnNames,
  type HeraStateKeyColumns,
  type HeraStateMachineDefinition,
  type HeraStateInsertRow,
  type HeraStateMachineSpec,
  type HeraStateSetColumns,
  type HeraStateSources,
  type HeraStateTargets,
  type HeraStateTransitionOptions,
  type HeraStateTransitionResult,
  type NoDeadEndNonTerminal,
  type NoUnreachableState,
} from "./types.js"

/**
 * One declarative transition funnel per stateful SQLite table:
 * `HeraStateMachine.define({ table, pk, column, states, initial, terminal, transitions })`.
 */
export const HeraStateMachine = {
  define: defineStateMachine,
} as const
