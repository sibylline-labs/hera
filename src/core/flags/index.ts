import { contextKey } from "./ofrep-wire.js"
import { FLAGS_DEFAULT_TIMEOUT_MS, FLAGS_DEFAULT_TTL_MS, OFREP_BULK_PATH, ofrep } from "./ofrep.js"
import { fromSource, HERA_FLAGS_FALLBACK } from "./reader.js"

export { FLAGS_DEFAULT_TIMEOUT_MS, FLAGS_DEFAULT_TTL_MS, OFREP_BULK_PATH } from "./ofrep.js"
export { HERA_FLAGS_FALLBACK } from "./reader.js"
export type * from "./types.js"

/**
 * `HeraFlags`: per-org feature flags. `ofrep` reads Logfire managed
 * variables over OFREP with the org as the targeting key; `fromSource` builds the same reader over
 * any source; `HeraTest.flags` is the in-memory reader for tests.
 */
export const HeraFlags = {
  ofrep,
  fromSource,
  contextKey,
  FALLBACK_EVENT: HERA_FLAGS_FALLBACK,
  DEFAULT_TTL_MS: FLAGS_DEFAULT_TTL_MS,
  DEFAULT_TIMEOUT_MS: FLAGS_DEFAULT_TIMEOUT_MS,
  OFREP_BULK_PATH,
} as const
