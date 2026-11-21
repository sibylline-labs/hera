import { type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vitest";
import { HeraOAuth2, HeraOAuth2Error } from "../src/index.js";

const SECRET = "client-secret-SENTINEL";
const CODE = "auth-code-SENTINEL";
const REFRESH = "refresh-token-SENTINEL";
const BODY_SENTINEL = "body-description-SENTINEL";
const NOW = 1_700_000_000_000;

type Reply = (res: ServerResponse) => void;

const servers: Server[] = [];

async function fakeAuthServer(
  reply: (path: string) => Reply,
): Promise<{
  readonly base: string;
  readonly forms: Array<{ path: string; contentType: string | undefined; form: Record<string, string> }>;
}> {
  const forms: Array<{ path: string; contentType: string | undefined; form: Record<string, string> }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = req.url ?? "/";
      forms.push({ path, contentType: req.headers["content-type"], form: Object.fromEntries(new URLSearchParams(raw)) });
      reply(path)(res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, forms };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Reply =>
  (res) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.end(JSON.stringify(body));
  };

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    s?.closeAllConnections?.();
    await new Promise<void>((r) => s?.close(() => r()));
  }
});

function clientFor(base: string, extra: { revokeClientAuth?: boolean } = {}) {
  return HeraOAuth2.client({
    tokenUrl: `${base}/oauth/token`,
    revokeUrl: `${base}/oauth/revoke`,
    clientId: "client-id",
    clientSecret: Redacted.make(SECRET),
    nowMs: () => NOW,
    ...extra,
  });
}

async function failureOf<A>(effect: Effect.Effect<A, HeraOAuth2Error>): Promise<HeraOAuth2Error> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const reason = exit.cause.reasons[0];
  if (reason?._tag !== "Fail") throw new Error("expected a typed failure, not a defect");
  return reason.error;
}

function expectNoSecrets(err: HeraOAuth2Error): void {
  const rendered = `${JSON.stringify(err)} ${err.message}`;
  for (const s of [SECRET, CODE, REFRESH, BODY_SENTINEL]) expect(rendered).not.toContain(s);
}

const PAIR = { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "read write" };

describe("HeraOAuth2.client", () => {
  // admits: the code exchange sends the wrong grant form or mis-stamps expiry/scopes; form wire and payload are runtime
  it("exchangeCode posts the authorization_code grant with client creds and returns a Redacted pair", async () => {
    const { base, forms } = await fakeAuthServer(() => json(200, PAIR));
    const pair = await Effect.runPromise(clientFor(base).exchangeCode({ code: CODE, redirectUri: "https://app/cb" }));
    expect(forms[0]).toEqual({
      path: "/oauth/token",
      contentType: "application/x-www-form-urlencoded",
      form: {
        grant_type: "authorization_code",
        code: CODE,
        redirect_uri: "https://app/cb",
        client_id: "client-id",
        client_secret: SECRET,
      },
    });
    expect(Redacted.value(pair.accessToken)).toBe("at-1");
    expect(Redacted.value(pair.refreshToken)).toBe("rt-1");
    expect(String(pair.accessToken)).not.toContain("at-1");
    expect(pair.expiresAt).toBe(NOW + 3_600_000);
    expect(pair.scopes).toEqual(["read", "write"]);
  });

  // admits: the refresh grant sends the wrong form or drops array-form scopes; runtime wire and payload
  it("refresh posts the refresh_token grant and reads array scopes", async () => {
    const { base, forms } = await fakeAuthServer(() => json(200, { ...PAIR, scope: ["read", 7, ""] }));
    const pair = await Effect.runPromise(clientFor(base).refresh(Redacted.make(REFRESH)));
    expect(forms[0]?.form).toEqual({
      grant_type: "refresh_token",
      refresh_token: REFRESH,
      client_id: "client-id",
      client_secret: SECRET,
    });
    expect(pair.scopes).toEqual(["read"]);
  });

  // admits: a token-endpoint failure mapped to the wrong reason (a false invalid_grant disconnects a working org), or leaking the body; runtime status/body pairs
  it.each([
    [400, { error: "invalid_grant", error_description: BODY_SENTINEL }, "invalid_grant", "invalid_grant"],
    [400, { error: "invalid_client" }, "invalid_client", "invalid_client"],
    [401, { error: "invalid_client" }, "invalid_client", "invalid_client"],
    [401, { error: "invalid_grant" }, "upstream", "invalid_grant"],
    [400, { error: "Token not found", error_description: BODY_SENTINEL }, "upstream", undefined],
    [400, { error: "refresh_token_sentinel" }, "upstream", undefined],
    [500, { error: "server_error" }, "upstream", "server_error"],
  ] as const)("HTTP %i %j is %s", async (status, body, reason, oauthCode) => {
    const { base } = await fakeAuthServer(() => json(status, body));
    for (const op of [
      clientFor(base).exchangeCode({ code: CODE, redirectUri: "https://app/cb" }),
      clientFor(base).refresh(Redacted.make(REFRESH)),
    ]) {
      const err = await failureOf(op);
      expect(HeraOAuth2Error.is(err)).toBe(true);
      expect(err.reason).toBe(reason);
      expect(err.status).toBe(status);
      expect(err.oauthCode).toBe(oauthCode);
      expect(err.slug).toBe(`oauth2-${reason.replace("_", "-")}`);
      expectNoSecrets(err);
    }
  });

  // admits: a 429 or an oversized reply escaping as an untyped error or dropping Retry-After; runtime exchange wiring
  it("429 and oversized replies are upstream, keeping retryAfterMs", async () => {
    const limited = await fakeAuthServer(() => json(429, {}, { "retry-after": "30" }));
    const rl = await failureOf(clientFor(limited.base).refresh(Redacted.make(REFRESH)));
    expect(rl).toMatchObject({ reason: "upstream", upstream: "RateLimited", status: 429, retryAfterMs: 30_000 });

    const big = await fakeAuthServer(() => json(200, { ...PAIR, pad: "z".repeat(100_000) }));
    const tooLarge = await failureOf(clientFor(big.base).refresh(Redacted.make(REFRESH)));
    expect(tooLarge).toMatchObject({ reason: "upstream", upstream: "PayloadTooLarge" });
  });

  // admits: a half-formed 200 taken as a pair, stranding a connection on a token that cannot refresh; runtime payload
  it.each([
    ["no refresh_token", { access_token: "at", expires_in: 10 }],
    ["empty access_token", { ...PAIR, access_token: "" }],
    ["zero expires_in", { ...PAIR, expires_in: 0 }],
    ["string expires_in", { ...PAIR, expires_in: "3600" }],
    ["not JSON", "<html>"],
    ["an expires_in whose expiry overflows", { ...PAIR, expires_in: 1e308 }],
  ])("a 200 with %s is upstream DecodeError", async (_label, body) => {
    const { base } = await fakeAuthServer(() => json(200, body));
    const err = await failureOf(clientFor(base).exchangeCode({ code: CODE, redirectUri: "https://app/cb" }));
    expect(err).toMatchObject({ reason: "upstream", upstream: "DecodeError", status: 200 });
    expectNoSecrets(err);
  });

  // admits: revoke treating a dead token as failure (a retry loop that never ends) or a 5xx as success; runtime status mapping
  it("revoke: 200 revoked, 400/401 already_invalid, 503 upstream; no client secret by default", async () => {
    const statuses = [200, 400, 401, 503];
    let i = 0;
    const { base, forms } = await fakeAuthServer(() => json(statuses[i++] ?? 500, {}));
    const c = clientFor(base);
    const token = Redacted.make("at-1");
    expect(await Effect.runPromise(c.revoke(token, "access_token"))).toBe("revoked");
    expect(await Effect.runPromise(c.revoke(token, "access_token"))).toBe("already_invalid");
    expect(await Effect.runPromise(c.revoke(token, "refresh_token"))).toBe("already_invalid");
    expect(await failureOf(c.revoke(token, "access_token"))).toMatchObject({ reason: "upstream", op: "revoke", status: 503 });
    expect(forms[0]).toEqual({
      path: "/oauth/revoke",
      contentType: "application/x-www-form-urlencoded",
      form: { token: "at-1", token_type_hint: "access_token" },
    });
  });

  // admits: with client auth on, a rejected client read as already_invalid, leaving the token live; runtime mapping
  it("revoke with revokeClientAuth sends creds and keeps invalid_client a failure", async () => {
    const { base, forms } = await fakeAuthServer(() => json(401, { error: "invalid_client" }));
    const err = await failureOf(clientFor(base, { revokeClientAuth: true }).revoke(Redacted.make("at-1"), "access_token"));
    expect(err.reason).toBe("invalid_client");
    expect(forms[0]?.form.client_secret).toBe(SECRET);
    expectNoSecrets(err);
  });

  // admits: a 3xx followed, re-sending the client secret and grant to another origin and taking its pair; fetch redirect mode is runtime
  it("never follows a redirect: the form reaches only the configured origin and a 3xx is upstream", async () => {
    const evil = await fakeAuthServer(() => json(200, PAIR));
    for (const status of [302, 307]) {
      const { base } = await fakeAuthServer(() => (res) => {
        res.statusCode = status;
        res.setHeader("location", `${evil.base}/oauth/token`);
        res.end();
      });
      const err = await failureOf(clientFor(base).refresh(Redacted.make(REFRESH)));
      expect(err).toMatchObject({ reason: "upstream", upstream: "HttpStatusError", status });
      const revoked = await failureOf(clientFor(base).revoke(Redacted.make("at-1"), "access_token"));
      expect(revoked).toMatchObject({ reason: "upstream", op: "revoke", status });
    }
    expect(evil.forms).toEqual([]);
  });

  // admits: a revoke whose endpoint rejected the client read as already_invalid, leaving the token live; runtime mapping
  it("revoke keeps invalid_client a failure even without revokeClientAuth", async () => {
    const { base } = await fakeAuthServer(() => json(401, { error: "invalid_client" }));
    const err = await failureOf(clientFor(base).revoke(Redacted.make("at-1"), "access_token"));
    expect(err).toMatchObject({ reason: "invalid_client", op: "revoke", status: 401 });
  });
});
