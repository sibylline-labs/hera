/**
 * The service keys of the Hera request contexts. A leaf, so the logger can read a context from a
 * fiber without importing `context.ts`, which imports the logger.
 */
export const HERA_PUBLIC_CTX_KEY = "@sibylline-labs/hera/HeraPublicCtx"
export const HERA_AUTHED_CTX_KEY = "@sibylline-labs/hera/HeraAuthedCtx"
export const HERA_CTX_KEY = "@sibylline-labs/hera/HeraCtx"
export const HERA_TENANT_CTX_KEY = "@sibylline-labs/hera/HeraTenantCtx"
