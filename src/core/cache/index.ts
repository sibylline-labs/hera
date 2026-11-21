import { HERA_CACHE_DEFAULT_MAX_ENTRIES, makeHeraCache } from "./cache.js"

export * from "./cache.js"

/** `HeraCache` namespace: a keyed, Clock-timed, negative-cached, bounded TTL cache of
 *  settled answers, held per isolate. */
export const HeraCache = {
  make: makeHeraCache,
  DEFAULT_MAX_ENTRIES: HERA_CACHE_DEFAULT_MAX_ENTRIES,
} as const
