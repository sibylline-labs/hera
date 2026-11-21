import type * as Schema from "effect/Schema"
import {
  type HeraErrorCode,
  type HeraErrorStatus,
  isHeraErrorCode,
  isHeraErrorStatus,
  resolveCatalogPublicMessage,
} from "./catalog.js"
import { defineHeraErrorClass } from "./converters.js"
import {
  HERA_DOMAIN_CODE_PATTERN,
  type HeraDomainCodeResolution,
  type HeraDomainErrorCode,
  type HeraErrorCodeLookup,
} from "./domain-code.js"
import type { HeraError } from "./hera-error.js"
import type {
  AnyHeraDefinedError,
  HeraDefinedErrorClass,
  HeraErrorFactoryOptions,
  HeraErrorResponseOptions,
  HeraErrorShape,
} from "./types.js"

/**
 * One declared domain code: the HTTP status it carries and, optionally, its public message
 * (default: the status's catalog message).
 */
export interface HeraDomainCodeSpec {
  readonly status: HeraErrorStatus
  readonly publicMessage?: string | undefined
}

export type HeraDomainCodeSpecs = Readonly<Record<string, HeraDomainCodeSpec>>

/**
 * Maps any key that is a catalog code or ends in a template suffix to `never`, so a registry cannot
 * shadow Hera's own vocabulary.
 */
export type HeraDomainCodeSpecsGuard<Spec> = {
  readonly [K in keyof Spec]: K extends HeraErrorCode ? never : Spec[K]
}

type CodeOf<Spec> = keyof Spec & string

/**
 * Options for a registry's `define(tag, options)`; the status comes from the registry.
 */
export interface HeraDomainErrorDefineOptions<
  K extends string,
  Fields extends Schema.Struct.Fields = {},
> {
  readonly code: K
  readonly publicMessage?: string | undefined
  readonly fields?: Fields | undefined
}

export type HeraDomainErrorMakeOptions = Omit<HeraErrorFactoryOptions, "code">

/**
 * A service's declared domain error codes, returned by `HeraError.codes(service, spec)`.
 */
export interface HeraErrorCodeRegistry<Spec extends HeraDomainCodeSpecs>
  extends HeraErrorCodeLookup {
  readonly codes: { readonly [K in CodeOf<Spec>]: HeraDomainErrorCode<K> }
  has(u: unknown): u is HeraDomainErrorCode<CodeOf<Spec>>
  status<K extends CodeOf<Spec>>(code: K): Spec[K]["status"]
  define<
    const Tag extends string,
    const K extends CodeOf<Spec>,
    const Fields extends Schema.Struct.Fields = {},
  >(
    tag: Tag,
    options: HeraDomainErrorDefineOptions<K, Fields>
  ): HeraDefinedErrorClass<Tag, HeraDomainErrorCode<K>, Spec[K]["status"], Fields>
  make<K extends CodeOf<Spec>>(
    code: K,
    options?: HeraDomainErrorMakeOptions
  ): HeraError
}

/**
 * Throws on a key that is not lower snake_case, collides with the catalog or a template suffix, or
 * declares a status outside `HeraErrorStatus`. Runs once, when the registry is built.
 */
export function assertDomainCodeSpecs(
  service: string,
  spec: HeraDomainCodeSpecs
): void {
  for (const [code, entry] of Object.entries(spec)) {
    if (!HERA_DOMAIN_CODE_PATTERN.test(code)) {
      throw new Error(
        `HeraError.codes(${service}): "${code}" is not a lower snake_case code`
      )
    }
    if (isHeraErrorCode(code)) {
      throw new Error(
        `HeraError.codes(${service}): "${code}" collides with a Hera catalog code or template suffix`
      )
    }
    if (!isHeraErrorStatus(entry?.status)) {
      throw new Error(
        `HeraError.codes(${service}): "${code}" declares a status outside HeraErrorStatus`
      )
    }
  }
}

export function makeHeraErrorCodeRegistry<const Spec extends HeraDomainCodeSpecs>(
  service: string,
  spec: Spec,
  makeHeraError: (shape: HeraErrorShape) => HeraError,
  renderResponse: (
    error: AnyHeraDefinedError,
    opts?: HeraErrorResponseOptions
  ) => Response
): HeraErrorCodeRegistry<Spec> {
  assertDomainCodeSpecs(service, spec)
  const entries: Readonly<Record<string, HeraDomainCodeResolution>> =
    Object.freeze(
      Object.fromEntries(
        Object.entries(spec).map(([code, entry]) => [
          code,
          Object.freeze({
            code: code as HeraDomainErrorCode,
            status: entry.status,
            publicMessage:
              entry.publicMessage ??
              resolveCatalogPublicMessage(
                code as HeraDomainErrorCode,
                entry.status
              ),
          }),
        ])
      )
    )
  const resolve = (code: string): HeraDomainCodeResolution | undefined =>
    Object.hasOwn(entries, code) ? entries[code] : undefined
  const mustResolve = (code: string): HeraDomainCodeResolution => {
    const entry = resolve(code)
    if (entry === undefined) {
      throw new Error(`HeraError.codes(${service}): "${code}" is not declared`)
    }
    return entry
  }

  return {
    service,
    codes: Object.freeze(
      Object.fromEntries(Object.keys(entries).map((code) => [code, code]))
    ) as HeraErrorCodeRegistry<Spec>["codes"],
    resolve,
    has: (u: unknown): u is HeraDomainErrorCode<CodeOf<Spec>> =>
      typeof u === "string" && resolve(u) !== undefined,
    status: <K extends CodeOf<Spec>>(code: K) =>
      mustResolve(code).status as Spec[K]["status"],
    define: (tag, options) => {
      const entry = mustResolve(options.code)
      return defineHeraErrorClass(
        tag,
        {
          code: entry.code,
          status: entry.status,
          publicMessage: options.publicMessage ?? entry.publicMessage,
          ...(options.fields !== undefined ? { fields: options.fields } : {}),
        },
        makeHeraError,
        renderResponse
      ) as never
    },
    make: (code, options) => {
      const entry = mustResolve(code)
      return makeHeraError({
        ...options,
        code: entry.code,
        httpStatus: entry.status,
        publicMessage: options?.publicMessage ?? entry.publicMessage,
      })
    },
  }
}
