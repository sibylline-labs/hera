/**
 * A 2xx that carries a body. `204` / `205` carry none, and a failure is a `HeraError`
 * (`application/problem+json`), never a raw reply.
 */
export type HeraRawStatus = 200 | 201 | 202 | 203

export interface HeraRawOptions {
  /** Defaults to `200`. */
  readonly status?: HeraRawStatus | undefined
  /** Defaults to `no-store`: a raw success usually carries a token, session or device code. */
  readonly cacheControl?: string | undefined
}

/**
 * Answers a route success as the bare JSON value, with no `{ ok, data, request_id }` envelope.
 * A `Hera.publicRoute` / `Hera.authedRoute` handler returns it; the route boundary
 * passes a `Response` through unwrapped and adds `x-request-id`. The body is exactly
 * `JSON.stringify(value)`; a value with no JSON form (`undefined`, a function) throws a
 * `TypeError`, as `Response.json` does. The success-side sibling of `toProblemResponse`.
 */
export function raw(value: unknown, options?: HeraRawOptions): Response {
  const body = JSON.stringify(value) as string | undefined
  if (body === undefined) {
    throw new TypeError("HeraHttp.raw: value has no JSON representation")
  }
  return new Response(body, {
    status: options?.status ?? 200,
    headers: {
      "content-type": "application/json",
      "cache-control": options?.cacheControl ?? "no-store",
    },
  })
}
