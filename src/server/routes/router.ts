import { extractPathParams } from "./headers.js"
import { joinRoutePath, matchRoutePath } from "./path-match.js"
import { methodNotAllowedResponse, routeNotFoundResponse } from "./refusal.js"
import type { HeraRoute, HeraRouteInvokeOptions } from "./types.js"

/**
 * Options for `Hera.router`.
 */
export interface HeraRouterOptions {
  /** Joined in front of every route's `path`, e.g. `"/v1"`. */
  readonly prefix?: string | undefined
  /** Replaces the default `404 route_not_found` problem response. */
  readonly notFound?: ((request: Request) => Response | Promise<Response>) | undefined
  /** Replaces the default `405 method_not_allowed` problem response; `allow` is in table order. */
  readonly methodNotAllowed?:
    | ((request: Request, allow: ReadonlyArray<string>) => Response | Promise<Response>)
    | undefined
}

/**
 * Method + path dispatcher returned by `Hera.router`. Call it with the request and the same
 * invoke options a single `HeraRoute` takes (`tenant`, `heraCtx`, `layer`, `onDefect`); the
 * matched route also receives the path `params`.
 */
export interface HeraRouter<R = never> {
  (request: Request, options?: HeraRouteInvokeOptions<R>): Promise<Response>
  readonly routes: ReadonlyArray<HeraRoute<unknown, R>>
}

interface CompiledRoute<R> {
  readonly route: HeraRoute<unknown, R>
  readonly pattern: string
  readonly method: string | undefined
}

function compile<R>(
  routes: ReadonlyArray<HeraRoute<unknown, R>>,
  prefix: string | undefined
): ReadonlyArray<CompiledRoute<R>> {
  return routes.map((route) => {
    if (route.path === undefined) {
      throw new TypeError(
        `Hera.router: route "${route.operationName}" has no path; every routed route declares one`
      )
    }
    return {
      route,
      pattern: joinRoutePath(prefix, route.path),
      method: route.method?.toUpperCase(),
    }
  })
}

/**
 * Builds a dispatcher over a table of `HeraRoute`s. The first route, in table order,
 * whose path and method match wins, so list a literal path before a `:param` path it overlaps.
 * A route with no `method` takes any method. An unmatched path is `404 route_not_found`; a
 * matched path with no route for the method is `405 method_not_allowed` with `Allow`. Both are
 * `application/problem+json`. A route without a `path` throws at construction.
 */
export function router<R = never>(
  routes: ReadonlyArray<HeraRoute<unknown, R>>,
  options?: HeraRouterOptions
): HeraRouter<R> {
  const table = compile(routes, options?.prefix)

  const dispatch = async (
    request: Request,
    invokeOptions?: HeraRouteInvokeOptions<R>
  ): Promise<Response> => {
    const pathname = new URL(request.url).pathname
    const method = request.method.toUpperCase()
    const allow: Array<string> = []
    for (const entry of table) {
      if (!matchRoutePath(entry.pattern, pathname)) {
        continue
      }
      if (entry.method === undefined || entry.method === method) {
        return entry.route(request, {
          ...invokeOptions,
          params: extractPathParams(entry.pattern, pathname),
        })
      }
      if (!allow.includes(entry.method)) {
        allow.push(entry.method)
      }
    }
    const requestId =
      invokeOptions?.tenant?.requestId ?? invokeOptions?.heraCtx?.requestId
    if (allow.length === 0) {
      return options?.notFound !== undefined
        ? options.notFound(request)
        : routeNotFoundResponse(request, requestId)
    }
    return options?.methodNotAllowed !== undefined
      ? options.methodNotAllowed(request, allow)
      : methodNotAllowedResponse(request, allow, requestId)
  }

  return Object.assign(dispatch, { routes })
}
