import type { HeraProblemDetails } from "../../core/errors/index.js";
import { SAMPLE_IDS } from "../fixtures/sample-ids.js";

export interface MakeTestRouteRequestOptions {
  readonly method?: string | undefined;
  readonly path?: string | undefined;
  readonly headers?: Record<string, string> | undefined;
  readonly body?: unknown;
  readonly requestId?: string | undefined;
}

/**
 * Builds a deterministic HTTP `Request` for exercising Hera Worker route handlers in tests.
 */
export function makeTestRouteRequest(
  options?: MakeTestRouteRequestOptions,
): Request {
  const method = (options?.method ?? "GET").toUpperCase();
  const path = options?.path ?? "/";
  const url = path.startsWith("http") ? path : `https://hera.test${path}`;
  const headers = new Headers(options?.headers);
  if (!headers.has("x-request-id")) {
    headers.set("x-request-id", options?.requestId ?? SAMPLE_IDS.requestId);
  }
  const hasJsonBody =
    options?.body !== undefined && method !== "GET" && method !== "HEAD";
  if (hasJsonBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const serializedBody =
    hasJsonBody && typeof options?.body !== "string"
      ? JSON.stringify(options?.body)
      : (options?.body as BodyInit | undefined);

  return new Request(url, {
    method,
    headers,
    ...(serializedBody !== undefined ? { body: serializedBody } : {}),
  });
}

/**
 * Parses the RFC 7807 `application/problem+json` body a route handler returns into a `HeraProblemDetails`.
 */
export async function parseProblemDetailsResponse(
  response: Response,
): Promise<HeraProblemDetails> {
  const payload = (await response.json()) as HeraProblemDetails;
  return payload;
}
