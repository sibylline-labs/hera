/**
 * Splits a route pattern or URL pathname into its non-empty `/` segments.
 */
function segmentsOf(path: string): ReadonlyArray<string> {
  return path.split("/").filter(Boolean)
}

/**
 * The parameter name of a route pattern segment: `:name` (Hera form) or `{name}` (OpenAPI form,
 * as in a `HeraOpenApiOperation` path), or `undefined` for a literal segment.
 */
export function pathParamName(segment: string): string | undefined {
  if (segment.startsWith(":")) {
    return segment.slice(1)
  }
  if (segment.length > 2 && segment.startsWith("{") && segment.endsWith("}")) {
    return segment.slice(1, -1)
  }
  return undefined
}

/**
 * Whether `pathname` matches a route pattern like `"/v1/orgs/:orgId/keys/{keyId}"`: the same
 * segment count, every literal segment equal, every `:param` / `{param}` segment non-empty. A
 * trailing `/` on either side is ignored. `extractPathParams` reads the values once this holds.
 */
export function matchRoutePath(pattern: string, pathname: string): boolean {
  const patternParts = segmentsOf(pattern)
  const pathParts = segmentsOf(pathname)
  if (patternParts.length !== pathParts.length) {
    return false
  }
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i] as string
    if (pathParamName(part) === undefined && part !== pathParts[i]) {
      return false
    }
  }
  return true
}

/**
 * Joins a router prefix (`"/v1"`) and a route path (`"/yaks/:id"`) into one pattern, with exactly
 * one `/` between segments.
 */
export function joinRoutePath(prefix: string | undefined, path: string): string {
  if (prefix === undefined) {
    return path
  }
  return `/${[...segmentsOf(prefix), ...segmentsOf(path)].join("/")}`
}

/**
 * Whether `pathname` is `prefix` or extends it at a `/` boundary, so `/v1/yaks` matches
 * `/v1/yaks` and `/v1/yaks/x` and never `/v1/yaksx`.
 */
export function isUnderPrefix(prefix: string, pathname: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}
