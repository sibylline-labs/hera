import { type RequestListener, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  HeraHttp,
  HeraHttpError,
  RateLimitedError,
  parseRetryAfter,
  readTextBounded,
  toProblemResponse,
} from "../src/core/http/index.js";
import { ErisError } from "../src/cli/index.js";
import { HeraError } from "../src/core/errors/index.js";
import { OrgId } from "../src/core/schema/index.js";

const activeServers: Server[] = [];

async function startTestServer(
  handler: RequestListener,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const server = createServer(handler);
  activeServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv && srv.listening) {
      srv.closeAllConnections?.();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
});

describe("@sibylline-labs/hera/http — parseRetryAfter (RFC 9110 §10.2.3)", () => {
  const FIXED_NOW = Date.parse("Sun, 06 Nov 1994 08:49:37 GMT");

  it("parses non-negative integer delta-seconds", () => {
    expect(parseRetryAfter("0", FIXED_NOW)).toEqual({
      retryAfterSeconds: 0,
      retryAfterMs: 0,
    });
    expect(parseRetryAfter("120", FIXED_NOW)).toEqual({
      retryAfterSeconds: 120,
      retryAfterMs: 120_000,
    });
    expect(parseRetryAfter("  45 \t", FIXED_NOW)).toEqual({
      retryAfterSeconds: 45,
      retryAfterMs: 45_000,
    });
  });

  it("parses IMF-fixdate, RFC 850, and ANSI C asctime() HTTP-dates", () => {
    // 90 seconds in the future (IMF-fixdate)
    expect(
      parseRetryAfter("Sun, 06 Nov 1994 08:51:07 GMT", FIXED_NOW),
    ).toEqual({
      retryAfterSeconds: 90,
      retryAfterMs: 90_000,
    });

    // Obsolete RFC 850 format (30 seconds in the future)
    expect(
      parseRetryAfter("Sunday, 06-Nov-94 08:50:07 GMT", FIXED_NOW),
    ).toEqual({
      retryAfterSeconds: 30,
      retryAfterMs: 30_000,
    });

    // ANSI C asctime() format (10 seconds in the future)
    expect(parseRetryAfter("Sun Nov  6 08:49:47 1994", FIXED_NOW)).toEqual({
      retryAfterSeconds: 10,
      retryAfterMs: 10_000,
    });

    // Past HTTP-date clamps to 0
    expect(
      parseRetryAfter("Sun, 06 Nov 1994 08:40:00 GMT", FIXED_NOW),
    ).toEqual({
      retryAfterSeconds: 0,
      retryAfterMs: 0,
    });
  });

  it("returns null fields for missing, negative, decimal, overflow, or malformed headers", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "   ",
      "-5",
      "1.5",
      "1e3",
      "NaN",
      "Infinity",
      "120s",
      "99999999999999999999999999",
      "not-a-date",
      "2026-10-23T00:00:00Z", // ISO-8601 is not a valid RFC 9110 HTTP-date
    ]) {
      expect(parseRetryAfter(bad, FIXED_NOW)).toEqual({
        retryAfterSeconds: null,
        retryAfterMs: null,
      });
    }
  });
});

describe("@sibylline-labs/hera/http — whole-exchange timeout, maxBytes streaming cap, and 429 RateLimitedError", () => {
  it("aborts the whole exchange when the server sends headers immediately and hangs mid-body stream", async () => {
    let streamCancelledOnServer = false;
    const srv = await startTestServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.write("partial-body-start:");
      req.on("close", () => {
        streamCancelledOnServer = true;
      });
      // Intentionally never call res.end()
    });

    const exit = await Effect.runPromiseExit(
      HeraHttp.get(`${srv.url}/hang-after-headers`, {
        timeoutMs: 80,
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const json = JSON.stringify(exit.cause);
      expect(json).toContain("HeraHttpError");
      expect(json).toContain("http-timeout");
    }

    const flipped = await Effect.runPromise(
      Effect.flip(
        HeraHttp.get(`${srv.url}/hang-after-headers`, {
          timeoutMs: 80,
        }),
      ),
    );
    expect(HeraHttpError.is(flipped)).toBe(true);
    if (HeraHttpError.is(flipped)) {
      expect(flipped.reason).toBe("Timeout");
      expect(flipped.slug).toBe("http-timeout");
      expect(flipped.timeoutMs).toBe(80);
      const asEris = ErisError.fromHttpError(flipped);
      expect(asEris.exitCode).toBe(124);
      expect(asEris.slug).toBe("http-timeout");
    }
    expect(streamCancelledOnServer).toBe(true);
  });

  it("enforces maxBytes on streaming responses by cancelling the stream early (fail and truncate modes)", async () => {
    let chunksWritten = 0;
    const srv = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      const chunk = "A".repeat(512);
      const interval = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(interval);
          return;
        }
        chunksWritten += 1;
        res.write(chunk);
        if (chunksWritten >= 50) {
          clearInterval(interval);
          res.end();
        }
      }, 5);
      res.on("close", () => clearInterval(interval));
    });

    // Default onMaxBytes === "fail" refuses oversized body
    const failErr = await Effect.runPromise(
      Effect.flip(
        HeraHttp.get(`${srv.url}/oversized`, {
          maxBytes: 1024,
        }),
      ),
    );
    expect(HeraHttpError.is(failErr)).toBe(true);
    if (HeraHttpError.is(failErr)) {
      expect(failErr.reason).toBe("PayloadTooLarge");
      expect(failErr.slug).toBe("http-payload-too-large");
      expect(failErr.maxBytes).toBe(1024);
    }

    // onMaxBytes === "truncate" returns bounded prefix and sets truncated: true
    chunksWritten = 0;
    const truncatedRes = await Effect.runPromise(
      HeraHttp.get(`${srv.url}/oversized`, {
        maxBytes: 1024,
        onMaxBytes: "truncate",
      }),
    );
    expect(truncatedRes.truncated).toBe(true);
    expect(truncatedRes.byteLength).toBe(1024);
    expect(truncatedRes.text).toHaveLength(1024);
    expect(chunksWritten).toBeLessThan(20);
  });

  it("surfaces RateLimitedError on 429 with delta-seconds and HTTP-date without auto-retrying", async () => {
    let callCount = 0;
    const fixedNow = Date.parse("Sun, 06 Nov 1994 08:49:37 GMT");

    const srv = await startTestServer((req, res) => {
      callCount += 1;
      if (req.url === "/rate-delta") {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "120",
        });
        res.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      if (req.url === "/rate-date") {
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "Sun, 06 Nov 1994 08:50:37 GMT",
        });
        res.end(JSON.stringify({ error: "rate_limited" }));
        return;
      }
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "rate_limited", retry_after: 42 }));
    });

    // 1. Delta-seconds header
    const deltaErr = await Effect.runPromise(
      Effect.flip(
        HeraHttp.post(`${srv.url}/rate-delta`, {
          body: { hello: "world" },
          nowMs: () => fixedNow,
        }),
      ),
    );
    expect(callCount).toBe(1);
    expect(RateLimitedError.is(deltaErr)).toBe(true);
    if (RateLimitedError.is(deltaErr)) {
      expect(deltaErr.status).toBe(429);
      expect(deltaErr.slug).toBe("http-rate-limited");
      expect(deltaErr.retryAfterSeconds).toBe(120);
      expect(deltaErr.retryAfterMs).toBe(120_000);
    }

    // 2. HTTP-date header
    const dateErr = await Effect.runPromise(
      Effect.flip(
        HeraHttp.get(`${srv.url}/rate-date`, {
          nowMs: () => fixedNow,
        }),
      ),
    );
    expect(callCount).toBe(2);
    expect(RateLimitedError.is(dateErr)).toBe(true);
    if (RateLimitedError.is(dateErr)) {
      expect(dateErr.retryAfterSeconds).toBe(60);
      expect(dateErr.retryAfterMs).toBe(60_000);
    }

    // 3. Body fallback when Retry-After header is absent
    const bodyFallbackErr = await Effect.runPromise(
      Effect.flip(
        HeraHttp.get(`${srv.url}/rate-body`, {
          nowMs: () => fixedNow,
        }),
      ),
    );
    expect(callCount).toBe(3);
    expect(RateLimitedError.is(bodyFallbackErr)).toBe(true);
    if (RateLimitedError.is(bodyFallbackErr)) {
      expect(bodyFallbackErr.retryAfterSeconds).toBe(42);
      expect(bodyFallbackErr.retryAfterMs).toBe(42_000);
    }
  });

  it("decodes JSON responses via HeraSchema, unwraps Redacted request headers on wire only, and strips rejected values on DecodeError", async () => {
    let seenAuthHeader = "";
    const ResponseSchema = Schema.Struct({
      orgId: OrgId,
      ok: Schema.Boolean,
    });

    const srv = await startTestServer((req, res) => {
      seenAuthHeader = req.headers.authorization ?? "";
      if (req.url === "/valid") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            orgId: "org_01JAWX9Z8K4M5N6P7Q8R9S0T1V",
            ok: true,
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          orgId: "bad-secret-org-value-should-never-leak",
          ok: true,
        }),
      );
    });

    const redactedToken = Redacted.make("Bearer sib_live_secret_token_123456");
    const validRes = await Effect.runPromise(
      HeraHttp.get(`${srv.url}/valid`, {
        headers: {
          authorization: redactedToken,
        },
        schema: ResponseSchema,
      }),
    );

    expect(seenAuthHeader).toBe("Bearer sib_live_secret_token_123456");
    expect(validRes.status).toBe(200);
    expect(validRes.data.ok).toBe(true);
    expect(validRes.data.orgId).toBe("org_01JAWX9Z8K4M5N6P7Q8R9S0T1V");

    const decodeErr = await Effect.runPromise(
      Effect.flip(
        HeraHttp.get(`${srv.url}/invalid`, {
          schema: ResponseSchema,
        }),
      ),
    );
    expect(HeraHttpError.is(decodeErr)).toBe(true);
    if (HeraHttpError.is(decodeErr)) {
      expect(decodeErr.reason).toBe("DecodeError");
      expect(decodeErr.slug).toBe("http-decode-error");
      expect(JSON.stringify(decodeErr)).not.toContain(
        "bad-secret-org-value-should-never-leak",
      );
    }
  });

  it("preserves toProblemResponse and constants", async () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(64 * 1024);
    expect(DEFAULT_HTTP_TIMEOUT_MS).toBe(10_000);
    const problemRes = toProblemResponse(HeraError.notFound("missing"));
    expect(problemRes.status).toBe(404);
    expect(problemRes.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    const emptyBounded = await readTextBounded(null);
    expect(emptyBounded).toEqual({
      text: "",
      truncated: false,
      byteLength: 0,
    });
  });
});

describe("@sibylline-labs/hera/http — redirect passthrough and requestBytes", () => {
  it("passes redirect to fetch and, under manual, resolves a 3xx without reading its body", async () => {
    // admits: a consumer that pins a credential to one host re-checks `location` itself;
    // if `redirect` is dropped, fetch follows and sends the credential on, and no type sees it.
    const seen: RequestInit[] = [];
    let pulled = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push(init ?? {});
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          pulled += 1;
          c.enqueue(new Uint8Array(1024));
        },
      });
      return new Response(body, {
        status: 302,
        headers: { location: "https://elsewhere.example.test/x", "content-length": "999999999" },
      });
    }) as unknown as typeof fetch;

    const res = await Effect.runPromise(
      HeraHttp.requestBytes({ url: "https://a.example.test/x", redirect: "manual", fetch: fetchImpl, maxBytes: 10 }),
    );
    expect(seen[0]?.redirect).toBe("manual");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://elsewhere.example.test/x");
    expect(res.byteLength).toBe(0);
    expect(pulled).toBeLessThan(3);

    // Without manual, a 3xx is still a status error, as before.
    const err = await Effect.runPromise(
      Effect.flip(HeraHttp.request({ url: "https://a.example.test/x", fetch: fetchImpl, maxBytes: 10, onMaxBytes: "truncate" })),
    );
    expect(HeraHttpError.is(err) && err.reason).toBe("HttpStatusError");
  });

  it("requestBytes returns the exact bytes of a non-UTF-8 body", async () => {
    // admits: text decoding replaces invalid UTF-8 with U+FFFD, so a hash over `text` is wrong
    // for any binary asset; the response types are identical, so only the bytes can show it.
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc3]);
    const srv = await startTestServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from(raw));
    });
    const res = await Effect.runPromise(HeraHttp.requestBytes({ url: `${srv.url}/bin` }));
    expect(res.bytes).toEqual(raw);
    expect(res.byteLength).toBe(raw.byteLength);
  });

  it("requestBytes fails PayloadTooLarge past maxBytes and cancels the stream", async () => {
    // admits: the bytes path reads up to a caller cap (MiB-scale), so the cap and the cancel
    // must hold on it as on the text path; an undeclared stream is a runtime property.
    let cancelled = false;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new Uint8Array(256));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const err = await Effect.runPromise(
      Effect.flip(HeraHttp.requestBytes({ url: "https://a.example.test/x", fetch: fetchImpl, maxBytes: 1000 })),
    );
    expect(HeraHttpError.is(err) && err.reason).toBe("PayloadTooLarge");
    expect(cancelled).toBe(true);
  });
});
