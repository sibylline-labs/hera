import type { HeraKeyedSyncTx, HeraSqlError, SyncEffect } from "../types.js"
import { SyncTx } from "./sync-tx.js"

/**
 * `hasSqlTable` for a `db` or a transaction handle: the probe runs through `query`, so inside
 * `transactSync` it reads the same snapshot as the statements around it.
 */
export function hasSqlTableTx(
  db: Pick<HeraKeyedSyncTx, "query">,
  name: string
): SyncEffect<boolean, HeraSqlError> {
  return SyncTx.map(
    db.query("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", [name]),
    (rows) => rows.length > 0
  )
}
