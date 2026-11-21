import { isUnderPrefix } from "./path-match.js"
import { methodNotAllowedResponse, routeNotFoundResponse } from "./refusal.js"

/**
 * One gateway prefix row: requests at or under `prefix` go to the service binding
 * named `binding`. `access` maps an HTTP method to the access level the caller verifies for it;
 * a method it does not name is 405, never a default. Its key order is the `Allow` order. A row
 * may carry more fields (e.g. `product`); the router hands the whole row back on a match.
 */
export interface HeraPrefixRoute<B extends string = string, A extends string = string> {
  readonly prefix: `/${string}`
  readonly binding: B
  readonly access: Readonly<Partial<Record<string, A>>>
}

/** The access levels a row's `access` map can resolve to, distributed over a union of rows. */
export type HeraPrefixAccess<Row extends HeraPrefixRoute> = Row extends HeraPrefixRoute
  ? NonNullable<Row["access"][keyof Row["access"]]>
  : never

/** The outcome of matching one request against a prefix table. */
export type HeraPrefixMatch<Row extends HeraPrefixRoute> =
  | { readonly _tag: "Matched"; readonly route: Row; readonly access: HeraPrefixAccess<Row> }
  | { readonly _tag: "MethodNotAllowed"; readonly route: Row; readonly allow: ReadonlyArray<string> }
  | { readonly _tag: "NotFound" }

/** What a `handle` forward callback receives for a matched request. */
export interface HeraPrefixForward<Row extends HeraPrefixRoute> {
  readonly request: Request
  readonly route: Row
  readonly access: HeraPrefixAccess<Row>
}

/** The prefix dispatcher returned by `Hera.prefixRouter`. */
export interface HeraPrefixRouter<Row extends HeraPrefixRoute> {
  readonly routes: ReadonlyArray<Row>
  /** Matches by path and method only; no I/O. */
  match(request: Request): HeraPrefixMatch<Row>
  /**
   * Answers a `NotFound` / `MethodNotAllowed` match with its problem+json refusal (405 carries
   * `Allow`) and hands a `Matched` one to `forward`, which owns verify and the binding call.
   */
  handle(
    request: Request,
    forward: (matched: HeraPrefixForward<Row>) => Response | Promise<Response>,
    options?: { readonly requestId?: string | undefined }
  ): Promise<Response>
}

/**
 * The row with the longest prefix that `pathname` equals or extends at a `/`, so `/v1/graph`
 * matches `/v1/graph` and `/v1/graph/x` and not `/v1/graphql`. Row order does not matter.
 */
export function matchPrefixRoute<Row extends HeraPrefixRoute>(
  pathname: string,
  routes: ReadonlyArray<Row>
): Row | undefined {
  let best: Row | undefined
  for (const route of routes) {
    if (
      isUnderPrefix(route.prefix, pathname) &&
      (best === undefined || route.prefix.length > best.prefix.length)
    ) {
      best = route
    }
  }
  return best
}

function validate(routes: ReadonlyArray<HeraPrefixRoute>): void {
  const seen = new Set<string>()
  for (const { prefix } of routes) {
    if (prefix.endsWith("/")) {
      throw new TypeError(`Hera.prefixRouter: prefix "${prefix}" ends in "/"`)
    }
    if (seen.has(prefix)) {
      throw new TypeError(`Hera.prefixRouter: prefix "${prefix}" is listed twice`)
    }
    seen.add(prefix)
  }
}

/**
 * Builds a gateway-shaped prefix dispatcher. Matching is longest-prefix on a segment
 * boundary; the access level comes from the row's own `access` keys (`Object.hasOwn`, so a
 * method named like an `Object.prototype` member never reads an inherited value). A prefix that
 * ends in `/` or is listed twice throws at construction.
 */
export function prefixRouter<const Row extends HeraPrefixRoute>(
  routes: ReadonlyArray<Row>
): HeraPrefixRouter<Row> {
  validate(routes)

  const match = (request: Request): HeraPrefixMatch<Row> => {
    const route = matchPrefixRoute(new URL(request.url).pathname, routes)
    if (route === undefined) {
      return { _tag: "NotFound" }
    }
    const access = Object.hasOwn(route.access, request.method)
      ? route.access[request.method]
      : undefined
    if (access === undefined) {
      const allow = Object.keys(route.access).filter((key) => route.access[key] !== undefined)
      return { _tag: "MethodNotAllowed", route, allow }
    }
    return { _tag: "Matched", route, access: access as HeraPrefixAccess<Row> }
  }

  const handle: HeraPrefixRouter<Row>["handle"] = async (request, forward, options) => {
    const matched = match(request)
    switch (matched._tag) {
      case "NotFound":
        return routeNotFoundResponse(request, options?.requestId)
      case "MethodNotAllowed":
        return methodNotAllowedResponse(request, matched.allow, options?.requestId)
      case "Matched":
        return forward({ request, route: matched.route, access: matched.access })
    }
  }

  return { routes, match, handle }
}
