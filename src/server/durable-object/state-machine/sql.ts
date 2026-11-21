const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether `value` may be interpolated as a SQL identifier: a plain `[A-Za-z_][A-Za-z0-9_]*` name. */
export function isSqlIdentifier(value: unknown): value is string {
  return typeof value === "string" && SQL_IDENTIFIER.test(value)
}

/**
 * Whether a literal `where` fragment is one balanced predicate: non-blank, parentheses balanced
 * outside quotes and never closing below its own level, and no `;`, `--` or `/*` outside quotes.
 * It is ANDed in as `(<where>)`, so a fragment that closes the parenthesis would OR past the
 * compare-and-set. Only bare `?` placeholders are allowed: SQLite reads `$name(...)`, `:name` and
 * `@name` as one token that can swallow a quote this scanner would count, and `?NNN` binds by
 * position into the statement's own parameters.
 */
export function isBalancedPredicate(where: string): boolean {
  if (where.trim().length === 0) return false
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < where.length; i += 1) {
    const ch = where[i]
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      continue
    }
    const pair = where.slice(i, i + 2)
    if (ch === ";" || pair === "--" || pair === "/*") return false
    if (ch === "$" || ch === ":" || ch === "@" || /^\?\d/.test(pair)) return false
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") quote = ch === "[" ? "]" : ch
    else if (ch === "(") depth += 1
    else if (ch === ")") {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0 && quote === undefined
}

/** Double-quotes a checked identifier, so a column named like a keyword (`order`) still parses. */
function quote(identifier: string): string {
  return `"${identifier}"`
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ")
}

/**
 * The compare-and-set statement of one transition. Every value is a `?`; parameters bind in the
 * order `to, ...set values, ...key values, ...from, ...where params`. `RETURNING` the first key
 * column makes the returned row count the match count (a cursor's `rowsWritten` also counts index
 * writes on workerd).
 */
export function buildTransitionSql(input: {
  readonly table: string
  readonly keyColumns: ReadonlyArray<string>
  readonly column: string
  readonly setColumns: ReadonlyArray<string>
  readonly fromCount: number
  readonly where: string | undefined
}): string {
  const assignments = [input.column, ...input.setColumns].map((name) => `${quote(name)} = ?`)
  const keyMatch = input.keyColumns.map((name) => `${quote(name)} = ?`)
  const conditions = [
    ...keyMatch,
    `${quote(input.column)} IN (${placeholders(input.fromCount)})`,
    ...(input.where === undefined ? [] : [`(${input.where})`]),
  ]
  const returning = quote(input.keyColumns[0] ?? input.column)
  return `UPDATE ${quote(input.table)} SET ${assignments.join(", ")} WHERE ${conditions.join(" AND ")} RETURNING ${returning}`
}

/** `INSERT INTO <table> (<columns>) VALUES (?, …)`, columns in the row's key order. */
export function buildInsertSql(table: string, columns: ReadonlyArray<string>): string {
  return `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${placeholders(columns.length)})`
}
