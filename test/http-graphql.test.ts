import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { HeraHttp, HeraHttpError, RateLimitedError } from "../src/core/http/index.js";

interface Seen {
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: unknown;
}

const servers: Server[] = [];

async function fakeGraphql(
  reply: (seen: Seen, res: ServerResponse) => void,
): Promise<{ readonly url: string; readonly seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const entry = {
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: JSON.parse(raw) as unknown,
      };
      seen.push(entry);
      reply(entry, res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const json = (status: number, body: unknown) => (_: Seen, res: ServerResponse) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    s?.closeAllConnections?.();
    await new Promise<void>((r) => s?.close(() => r()));
  }
});

const Viewer = Schema.Struct({ viewer: Schema.Struct({ id: Schema.String }) });

async function failureOf(effect: Effect.Effect<unknown, HeraHttpError | RateLimitedError>) {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const err = exit.cause.reasons[0];
  if (err?._tag !== "Fail") throw new Error("expected a typed failure, not a defect");
  return err.error;
}

describe("HeraHttp.graphql", () => {
  // admits: wire shape of the GraphQL POST drifts from {query,variables,operationName}; runtime payload, no static rung sees it
  it("POSTs query/variables/operationName and decodes data", async () => {
    const { url, seen } = await fakeGraphql(json(200, { data: { viewer: { id: "u1" } } }));
    const res = await Effect.runPromise(
      HeraHttp.graphql({
        url,
        query: "query V { viewer { id } }",
        variables: { a: 1 },
        operationName: "V",
        schema: Viewer,
      }),
    );
    expect(res.data).toEqual({ viewer: { id: "u1" } });
    expect(res.status).toBe(200);
    expect(seen[0]?.body).toEqual({ query: "query V { viewer { id } }", variables: { a: 1 }, operationName: "V" });
    expect(seen[0]?.contentType).toContain("application/json");
    expect(seen[0]?.authorization).toBeUndefined();
  });

  // admits: a Redacted credential sent in the wrong Authorization form; header rendering is runtime
  it("sends bearer auth as `Bearer <token>` and raw auth verbatim, both from Redacted", async () => {
    const { url, seen } = await fakeGraphql(json(200, { data: { viewer: { id: "u1" } } }));
    const token = Redacted.make("tok-123");
    await Effect.runPromise(HeraHttp.graphql({ url, query: "q", schema: Viewer, auth: { bearer: token } }));
    await Effect.runPromise(
      HeraHttp.graphql({ url, query: "q", schema: Viewer, auth: { authorization: Redacted.make("lin_api_x") } }),
    );
    expect(seen.map((s) => s.authorization)).toEqual(["Bearer tok-123", "lin_api_x"]);
  });

  // admits: a caller's own authorization header silently dropped when no auth is given, or auth losing to it; header merge is runtime
  it("headers.authorization passes through without auth; auth replaces it when given", async () => {
    const { url, seen } = await fakeGraphql(json(200, { data: { viewer: { id: "u1" } } }));
    const headers = { authorization: Redacted.make("from-headers") };
    await Effect.runPromise(HeraHttp.graphql({ url, query: "q", schema: Viewer, headers }));
    await Effect.runPromise(
      HeraHttp.graphql({ url, query: "q", schema: Viewer, headers, auth: { bearer: Redacted.make("t") } }),
    );
    expect(seen.map((s) => s.authorization)).toEqual(["from-headers", "Bearer t"]);
  });

  // admits: a redirect followed, sending the credential on or decoding another origin's data as success; fetch redirect mode is runtime
  it("never follows a redirect: a 3xx is an HttpStatusError and the other origin is never reached", async () => {
    const evil = await fakeGraphql(json(200, { data: { viewer: { id: "evil" } } }));
    const { url } = await fakeGraphql((_, res) => {
      res.statusCode = 307;
      res.setHeader("location", evil.url);
      res.end();
    });
    const err = (await failureOf(
      HeraHttp.graphql({ url, query: "q", schema: Viewer, auth: { bearer: Redacted.make("t") } }),
    )) as HeraHttpError;
    expect(err).toMatchObject({ reason: "HttpStatusError", status: 307 });
    expect(evil.seen).toEqual([]);
  });

  // admits: a 200 carrying errors[] read as success ("the 200 is not success"); reply shape is runtime
  it("a 200 with errors[] is a typed GraphqlError, even beside partial data", async () => {
    const { url } = await fakeGraphql(
      json(200, {
        data: { viewer: { id: "u1" } },
        errors: [
          { message: "Variable $input got invalid value secret-ish", path: ["issueCreate", 0], extensions: { code: "INVALID_INPUT" } },
          { nope: true },
        ],
      }),
    );
    const err = await failureOf(HeraHttp.graphql({ url, query: "q", schema: Viewer }));
    expect(HeraHttpError.is(err)).toBe(true);
    const e = err as HeraHttpError;
    expect(e.reason).toBe("GraphqlError");
    expect(e.slug).toBe("http-graphql-error");
    expect(e.status).toBe(200);
    expect(e.graphqlErrors).toEqual([
      { message: "Variable $input got invalid value secret-ish", path: ["issueCreate", 0], code: "INVALID_INPUT" },
      { message: "(no message)" },
    ]);
    expect(e.message).toBe(`GraphQL errors (2) from POST ${url}`);
  });

  // admits: a malformed errors member read as success, or an empty list read as failure; runtime payload
  it("a non-list errors member is a GraphqlError; an empty list is not", async () => {
    const bad = await fakeGraphql(json(200, { errors: "boom", data: null }));
    const err = (await failureOf(HeraHttp.graphql({ url: bad.url, query: "q", schema: Viewer }))) as HeraHttpError;
    expect(err.reason).toBe("GraphqlError");
    expect(err.graphqlErrors).toEqual([{ message: "(errors is not a list)" }]);

    const ok = await fakeGraphql(json(200, { errors: [], data: { viewer: { id: "u2" } } }));
    const res = await Effect.runPromise(HeraHttp.graphql({ url: ok.url, query: "q", schema: Viewer }));
    expect(res.data.viewer.id).toBe("u2");
  });

  // admits: an unbounded upstream errors[] copied whole onto the error; runtime size
  it("bounds the kept entries and message length", async () => {
    const errors = Array.from({ length: 50 }, () => ({ message: "x".repeat(1000) }));
    const { url } = await fakeGraphql(json(200, { errors }));
    const err = (await failureOf(HeraHttp.graphql({ url, query: "q", schema: Viewer }))) as HeraHttpError;
    expect(err.graphqlErrors).toHaveLength(20);
    expect(err.graphqlErrors?.[0]?.message).toHaveLength(500);
  });

  // admits: a non-object 200 body thrown or read as success instead of a typed DecodeError; runtime payload
  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["not JSON", "<html>"],
  ])("a 200 whose body is %s is a DecodeError", async (_label, body) => {
    const { url } = await fakeGraphql(json(200, body));
    const err = (await failureOf(HeraHttp.graphql({ url, query: "q", schema: Viewer }))) as HeraHttpError;
    expect(err.reason).toBe("DecodeError");
  });

  // admits: undecoded or missing data returned as success; Schema decode runs at runtime
  it("data that does not match the schema (or is missing) is a DecodeError with issues", async () => {
    const wrong = await fakeGraphql(json(200, { data: { viewer: { id: 7 } } }));
    const err = (await failureOf(HeraHttp.graphql({ url: wrong.url, query: "q", schema: Viewer }))) as HeraHttpError;
    expect(err.reason).toBe("DecodeError");
    expect(err.issues?.length).toBeGreaterThan(0);

    const missing = await fakeGraphql(json(200, {}));
    const err2 = (await failureOf(HeraHttp.graphql({ url: missing.url, query: "q", schema: Viewer }))) as HeraHttpError;
    expect(err2.reason).toBe("DecodeError");
  });

  // admits: graphql bypassing the exchange's non-2xx, 429 and maxBytes handling; wiring is runtime
  it("keeps HeraHttp's non-2xx, 429 and size bounds", async () => {
    const down = await fakeGraphql(json(502, { errors: [{ message: "bad gateway" }] }));
    expect(((await failureOf(HeraHttp.graphql({ url: down.url, query: "q", schema: Viewer }))) as HeraHttpError).reason).toBe(
      "HttpStatusError",
    );

    const limited = await fakeGraphql((_, res) => {
      res.statusCode = 429;
      res.setHeader("retry-after", "7");
      res.end("{}");
    });
    const rl = await failureOf(HeraHttp.graphql({ url: limited.url, query: "q", schema: Viewer }));
    expect(RateLimitedError.is(rl)).toBe(true);
    expect((rl as RateLimitedError).retryAfterSeconds).toBe(7);

    const big = await fakeGraphql(json(200, { data: { viewer: { id: "y".repeat(5000) } } }));
    const tooLarge = (await failureOf(
      HeraHttp.graphql({ url: big.url, query: "q", schema: Viewer, maxBytes: 1024 }),
    )) as HeraHttpError;
    expect(tooLarge.reason).toBe("PayloadTooLarge");
  });
});

describe("HeraHttp.graphql: GraphQL errors in a non-2xx body", () => {
  const rateLimited = { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] };

  // admits: a Linear 400 RATELIMITED reply surfacing without its code, so callers re-parse body; runtime payload
  it("a 400 carrying errors[] keeps HttpStatusError and attaches the bounded entries", async () => {
    const { url } = await fakeGraphql(json(400, rateLimited));
    const err = (await failureOf(HeraHttp.graphql({ url, query: "q", schema: Viewer }))) as HeraHttpError;
    expect(err.reason).toBe("HttpStatusError");
    expect(err.status).toBe(400);
    expect(err.slug).toBe("http-status-error");
    expect(err.body).toBe(JSON.stringify(rateLimited));
    expect(err.graphqlErrors).toEqual([{ message: "Rate limit exceeded", code: "RATELIMITED" }]);
    expect(err.message).toBe(`HTTP 400 from POST ${url}`);
  });

  // admits: a non-GraphQL error body given invented entries; runtime parse outcome
  it.each([
    ["not JSON", "<html>rate limited</html>"],
    ["a JSON array", "[1]"],
    ["an object without errors", { message: "x" }],
    ["an empty errors list", { errors: [] }],
    ["errors that is not a list", { errors: "nope" }],
  ])("a 4xx whose body is %s carries no graphqlErrors", async (_label, body) => {
    const { url } = await fakeGraphql(json(400, body));
    const err = (await failureOf(HeraHttp.graphql({ url, query: "q", schema: Viewer }))) as HeraHttpError;
    expect(err.reason).toBe("HttpStatusError");
    expect(err.graphqlErrors).toBeUndefined();
    expect("graphqlErrors" in err).toBe(false);
  });

  // admits: a non-2xx errors[] copied unbounded, unlike the 2xx path; runtime size
  it("bounds non-2xx entries the same as a 2xx reply, on any non-2xx status", async () => {
    const errors = Array.from({ length: 25 }, () => ({ message: "y".repeat(800) }));
    const { url } = await fakeGraphql(json(502, { errors }));
    const err = (await failureOf(HeraHttp.graphql({ url, query: "q", schema: Viewer }))) as HeraHttpError;
    expect(err.reason).toBe("HttpStatusError");
    expect(err.graphqlErrors).toHaveLength(20);
    expect(err.graphqlErrors?.[0]?.message).toHaveLength(500);
  });

  // admits: a 429 with a GraphQL body re-typed away from RateLimitedError; runtime branch order
  it("a 429 with an errors[] body stays RateLimitedError", async () => {
    const { url } = await fakeGraphql((_, res) => {
      res.statusCode = 429;
      res.setHeader("retry-after", "3");
      res.end(JSON.stringify(rateLimited));
    });
    const err = await failureOf(HeraHttp.graphql({ url, query: "q", schema: Viewer }));
    expect(RateLimitedError.is(err)).toBe(true);
  });
});
