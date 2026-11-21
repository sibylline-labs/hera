import type { HeraErrorCode, HeraErrorStatus } from "./catalog.js"

declare const HeraDomainErrorCodeBrand: unique symbol

/**
 * A failure code a consuming service declares in its own registry (`HeraError.codes`), outside
 * `HERA_ERROR_CATALOG`. Branded: a raw string never type-checks as one, so only a
 * registry's `codes`, `define` and `make` produce it. It still compares and assigns as its literal.
 */
export type HeraDomainErrorCode<K extends string = string> = K & {
  readonly [HeraDomainErrorCodeBrand]: true
}

/**
 * Every code that may cross a Hera boundary: the closed catalog, its templates, and a registry's
 * domain codes.
 */
export type HeraWireErrorCode = HeraErrorCode | HeraDomainErrorCode

/**
 * The resolved declaration of one domain code, as a registry answers it.
 */
export interface HeraDomainCodeResolution {
  readonly code: HeraDomainErrorCode
  readonly status: HeraErrorStatus
  readonly publicMessage: string
}

/**
 * What `Hera.rpcClient` needs from a registry to keep a domain code on the calling side.
 */
export interface HeraErrorCodeLookup {
  readonly service: string
  resolve(code: string): HeraDomainCodeResolution | undefined
}

/**
 * A domain code is lower snake_case: `member_deactivated`, `slow_down`.
 */
export const HERA_DOMAIN_CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
