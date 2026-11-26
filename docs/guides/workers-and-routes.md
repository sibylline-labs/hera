# Worker Routes, Routers, Webhooks, Auth Progression, Typed RPC & Queue Consumers (`Hera.publicRoute`, `Hera.authedRoute`, `Hera.router`, `HeraWebhook`, `Hera.rpcClient`, `Hera.httpRpcMethod`, `Hera.queueConsumer`)

`@sibylline-labs/hera/server` (`@sibylline-labs/hera/routes` and `@sibylline-labs/hera/rpc`) provides HTTP route boundaries, compile-time auth capability gates, Worker-to-Worker RPC adapters and Cloudflare Queues consumers (`Hera.queueConsumer`, [section 3](#3-queue-consumers-heraqueueconsumer)) with automatic request validation, ambient request and tenant context, and RFC 7807 `application/problem+json` error responses (see [ERRORS.md](../ERRORS.md#2-error-envelope-wire-format)).

---

## 1. HTTP Route Boundaries & Capability Gates (`@sibylline-labs/hera/routes`)

Hera provides three route helpers matched to the three context tiers (`HeraPublicCtx`, `HeraAuthedCtx`, `HeraTenantCtx`):

| Helper | Mode 1: HTTP Boundary (`spec`) | Mode 2: Compile-Time Capability Gate (`effect` / `fn`) |
|---|---|---|
| `Hera.publicRoute` | Decodes `params`/`query`/`headers`/`body`, provides `HeraCtx`, returns `Response` | Constrains the handler's `R` channel to `HeraPublicRouteEnv` (rejects `HeraAuthedCtx` / `HeraTenantCtx` at compile time) |
| `Hera.authedRoute` | Verifies auth (`resolveAuth` or invoke options), enforces `scopes` (every entry required), `anyOfScopes` (at least one), and `actorKind` (one kind or an array of kinds), decodes request parts, provides `HeraTenantCtx`, returns `Response` | Constrains the handler's `R` channel to `HeraAuthedRouteEnv` |
| `Hera.tenantRoute` | Alias capability gate for tenant-scoped handlers | Constrains the handler's `R` channel to `HeraTenantRouteEnv` |

An `authedRoute` handler receives a `HeraAuthedRouteContext`: `request`, `requestId`, `heraCtx`, `params`, `query`, `headers`, `body`, `tenant`, `orgId`, `actorId`, `actorKind`, and `scopes`.

### Defining Public and Authenticated Routes

```ts
import * as Schema from "effect/Schema";
import {
  Hera,
  HeraError,
  HeraSchema,
  HeraTenantCtx,
  OrgId,
} from "@sibylline-labs/hera";

export const HealthRoute = Hera.publicRoute({
  method: "GET",
  path: "/healthz",
  service: "billing",
  handler: ({ requestId }) =>
    Hera.fn("Health.check")(function* () {
      return { ok: true, requestId };
    })(),
});

export const CreateSubscriptionRoute = Hera.authedRoute({
  method: "POST",
  path: "/v1/orgs/:orgId/subscriptions",
  service: "billing",
  scopes: ["subscriptions:write"],
  actorKind: ["user", "service"],
  params: Schema.Struct({ orgId: OrgId }),
  body: Schema.Struct({
    plan: HeraSchema.ServiceName,
  }),
  handler: ({ params, body }) =>
    Hera.fn("Subscriptions.create")(function* () {
      const ctx = yield* HeraTenantCtx.current;
      if (params.orgId !== ctx.orgId) {
        return yield* HeraError.unauthorized("Organization context mismatch", {
          code: "org_mismatch",
        });
      }
      yield* ctx.logger.info("subscription.created", { plan: body.plan });
      return { orgId: ctx.orgId, plan: body.plan };
    })(),
});
```

### Authority-Guarded Routes (`authority`)

A route that performs a privileged act declares `authority` on `Hera.authedRoute`. After tenant auth and request decoding, Hera asks the `HeraAuthorityVerifier` port (`@sibylline-labs/hera/authority`) before the handler runs, and the handler receives a second parameter, `HeraAuthorityCtx<V>`, typed by the declared verb. It is the route twin of `HeraCli.verb`'s `authority` ([guide](cli-and-http.md#authority-guarded-verbs-authority)).

- `verb`: the authority verb, by convention `"domain:action"`. Hera does not parse it; the verifier does.
- `credential(ctx)`: reads the caller's act-scoped bearer from the decoded request (a header, a body field). It is wrapped in `Redacted` and never rendered. `undefined` or empty refuses `403` with slug `authority-credential-missing`, and the verifier is not called.
- `params(ctx)`: optional string params the verifier matches against the grant (default `{}`).
- `verifier`: a `Layer<HeraAuthorityVerifier, HeraError>`, provided only to the one `verify` call. The request's `command` is the route's operation name.

A `HeraAuthorityRefusal` renders `403` `application/problem+json` with `code: "forbidden"` and the verifier's code as `slug`, plus its `what` / `fix`. A verifier transport failure (`HeraHttpError`, `RateLimitedError`), a failure outside the error catalogue, or a layer error whose `code` holds a credential renders a retryable `503 service_unavailable` with slug `authority-verifier-unavailable`, `retryable: true` (and `retry_after` from a rate limit) and no verifier text. A verifier layer that fails to build with any other `HeraError` renders its own code. When any part of the authority step throws (the `credential` or `params` reader, the verifier, its layer), the route dies with `HeraAuthorityVerifierDefect`, so the closed `503` and the `onDefect` log name that class and nothing that was thrown. On every path Hera cuts the exact credential from the rendered text first, then any other credential shape (a `Bearer` token, `sib_` / `sk_` keys, the gitleaks shapes), walking fields and their keys without a JSON round trip; a slug that holds either becomes `authority-refused`. The error carries no `cause` or `issues`, and the handler never runs. The slugs are in [ERRORS.md](../ERRORS.md#authority-guarded-route-slugs-heraauthedroute-authority).

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Hera } from "@sibylline-labs/hera";
import { HeraAuthorityVerifier } from "@sibylline-labs/hera/authority";

declare const verifier: HeraAuthorityVerifier["Service"];

export const skipGate = Hera.authedRoute({
  name: "Gates.skip",
  method: "POST",
  path: "/v1/gates/:gate/skip",
  params: Schema.Struct({ gate: Schema.String }),
  authority: {
    verb: "gate:skip",
    credential: ({ request }) => request.headers.get("x-grant") ?? undefined,
    params: ({ params }) => ({ gate: params.gate }),
    verifier: HeraAuthorityVerifier.layer(verifier),
  },
  handler: ({ params }, authority) =>
    // authority: HeraAuthorityCtx<"gate:skip">; authority.credential stays Redacted
    Effect.succeed({ gate: params.gate, grant: authority.grant.id }),
});
```

A route without `authority` keeps a one-parameter handler: a handler that asks for the ctx there does not compile, nor does a handler typed for another verb. No barrel or subpath exports the ctx constructor, so an object literal cannot stand in for a grant.

### Capping and Decoding the Request Body (`maxBodyBytes`, `bodyFormat`)

Both spec builders take two optional body options. Leaving both out keeps the default read: the
whole body, parsed as JSON whatever its `content-type`.

- **`maxBodyBytes`** (a positive integer; anything else throws when the route is built). A declared
  `content-length` over the cap is refused before a byte is read, and the body is then read only
  up to the cap, so a body with no length, or a false one, costs at most the cap in memory. Over
  the cap is `413 payload_too_large` problem+json, before the `body` schema or the handler runs.
  The streamed check is the real bound: workerd may not expose `content-length` at all, so a
  streamed overrun is refused at the body read, after `params`, `query` and `headers` decode. The cap
  applies only to a route with a `body` schema, since that is the only body Hera reads; a handler
  that gates before reading, or maps its own wire error, calls the same reader itself with
  [`HeraHttp.readBody`](cli-and-http.md#reading-a-capped-request-body-in-a-handler-herahttpreadbody).
- **`bodyFormat: "json-or-form"`** decodes an `application/x-www-form-urlencoded` body (media type
  parameters such as `; charset=UTF-8` ignored) as a flat string record, repeated keys last-wins,
  and runs it through the same `body` schema; any other `content-type` is parsed as JSON. A route
  that does not opt in answers a form body `400 invalid_json`.

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Hera } from "@sibylline-labs/hera";

// RFC 8628 §3.4 device access token request: form-encoded, capped at 4 KiB.
export const DeviceTokenRoute = Hera.publicRoute({
  method: "POST",
  path: "/device/token",
  maxBodyBytes: 4096,
  bodyFormat: "json-or-form",
  body: Schema.Struct({
    grant_type: Schema.Literal("urn:ietf:params:oauth:grant-type:device_code"),
    device_code: Schema.NonEmptyString,
    client_id: Schema.NonEmptyString,
  }),
  handler: ({ body }) => Effect.succeed({ device_code: body.device_code }),
});
```

### Automatic Boundary Guarantees

1. **Method & Schema Enforcement**: Wrong HTTP methods return `405 method_not_allowed`. Invalid `params`, `query`, `headers`, or JSON `body` return `400` (`invalid_path_params`, `invalid_query`, `invalid_headers`, `invalid_request_body`, or `invalid_json`) with value-stripped `issues`. On a route with `maxBodyBytes`, a declared over-cap `content-length` is `413 payload_too_large` before any of these decodes; a streamed overrun is `413` at the body read, after `params`, `query` and `headers`.
2. **Auth, Scope & Principal Enforcement**: A request with no resolvable tenant returns `401 unauthorized`; missing scopes return `403 scope_denied`; disallowed actor kinds return `403 actor_kind_denied`.
3. **Closed 503 Defect Catch**: Any uncaught defect (`Cause.die`) is logged with `extractSafeDefectName` and returns `503 internal_unavailable` as problem details (`application/problem+json`) with `X-Request-Id`. The `hera.boundary.defect` line carries the `request_id` the handler saw, and for an `authedRoute` the accepted tenant's `org_id` and `service`, whether the tenant came from `invokeOptions.tenant`, `resolveAuth` or an ambient `HeraTenantCtx` layer (a `publicRoute` logs `org_id` when its `heraCtx.orgId` is `Some`).

### Success Replies: Envelope or Raw

A handler's plain return value is wrapped as `{ ok: true, data: value, request_id }` (an object value's own keys are also spread at the top level), with the spec's `status` (default `200`) and `cache-control: no-store`.

A wire contract that a client parses as the bare value (RFC 8628 device-token replies, OAuth and session replies, a published CLI) returns `HeraHttp.raw(value, { status?, cacheControl? })` instead. The body is exactly `JSON.stringify(value)` as `application/json`; `status` is a body-carrying 2xx (`200 | 201 | 202 | 203`, default `200`); `cache-control` is `no-store` unless `cacheControl` says otherwise. The boundary passes the `Response` through and adds `x-request-id`.

A streamed reply returns `HeraHttp.sse(source, options)`, a `200 text/event-stream` body with data frames, idle keepalives, an optional sentinel and a static error frame; the boundary passes it through the same way ([guide](cli-and-http.md#server-sent-events-herahttpsse)).

A handler that upgrades a connection returns the `Response` the runtime gave it (status `101`, or a non-null `webSocket`), and the boundary passes that exact object through: no `cache-control` and no `x-request-id` is added, because rebuilding it would drop the socket and workerd forbids changing an upgrade's headers. The request id still reaches the boundary's logs and span. `test/workerd/route-upgrade.test.ts` observes the handshake and frames both ways through `Hera.publicRoute` on workerd.

Failures are unchanged: a `HeraError` from the same handler still answers problem+json ([ERRORS.md](../ERRORS.md#2-error-envelope-wire-format)).

```ts
import * as Effect from "effect/Effect";
import { Hera, HeraHttp } from "@sibylline-labs/hera";

export const DeviceCodeRoute = Hera.publicRoute({
  method: "POST",
  path: "/v1/device/code",
  service: "gateway",
  handler: () =>
    Effect.succeed(
      HeraHttp.raw(
        { device_code: "dc_123", user_code: "WDJB-MJHT", expires_in: 900, interval: 5 },
        { status: 200 }
      )
    ),
});
```

### Routing a Route Table (`Hera.router`)

`Hera.router(routes, { prefix?, notFound?, methodNotAllowed? })` turns a table of `HeraRoute`s into one `(request, opts?) => Promise<Response>`. It matches each route's `method` and `path` (literal segments and `:param` or OpenAPI-form `{param}` segments, same segment count), calls the first match in table order with `opts` plus the extracted `params`, and answers:

- an unmatched path with `404 route_not_found` as `application/problem+json`;
- a matched path whose routes take other methods with `405 method_not_allowed` and an `Allow` header listing them in table order.

The path test is exported on its own as `matchRoutePath(pattern, pathname)`. A route with no `method` takes any method. A route with no `path` throws when the router is built. List a literal path before a `:param` path it overlaps (`/yaks/config` before `/yaks/:key`). `opts` passes straight through, so a ProductRpc `handle(request, ctx)` can map the gateway's ctx to a `HeraTenantCtxShape` and dispatch `authedRoute`s whose handlers are `Hera.tenantRoute`-gated. When the caller has no request id of its own, `resolveRequestId(request)` gives the one the boundary would use (a valid `x-request-id` or `cf-ray`, else a fresh `req_<ULID>`):

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Hera, HeraTenantCtx, OrgId, RequestId } from "@sibylline-labs/hera";

const YakStatusRoute = Hera.authedRoute({
  method: "GET",
  path: "/yaks/status",
  service: "yak",
  scopes: ["yak:read"],
  handler: () =>
    Hera.tenantRoute(
      Effect.gen(function* () {
        const tenant = yield* HeraTenantCtx;
        return { orgId: tenant.orgId };
      })
    ),
});

const YakReceiptRoute = Hera.authedRoute({
  method: "GET",
  path: "/yaks/receipts/:key",
  service: "yak",
  params: Schema.Struct({ key: Schema.NonEmptyString }),
  handler: ({ params }) => Hera.tenantRoute(Effect.succeed({ key: params.key })),
});

const yakRoutes = Hera.router([YakStatusRoute, YakReceiptRoute], { prefix: "/v1" });

interface GatewayCtx {
  readonly orgId: string;
  readonly requestId: string;
  readonly scopes: ReadonlyArray<string>;
}

export const handle = (request: Request, ctx: GatewayCtx): Promise<Response> =>
  yakRoutes(request, {
    tenant: {
      orgId: Schema.decodeUnknownSync(OrgId)(ctx.orgId),
      requestId: Schema.decodeUnknownSync(RequestId)(ctx.requestId),
      actorId: Option.none(),
      service: "yak",
      scopes: ctx.scopes,
    },
  });
```

### Gateway Prefix Rows (`Hera.prefixRouter`)

`Hera.prefixRouter(rows)` is the gateway shape: each row names a `prefix`, the service `binding` it forwards to, and an `access` map from HTTP method to the access level the gateway verifies (extra fields such as `product` ride along). Matching is longest-prefix on a segment boundary, so `/v1/yaks` matches `/v1/yaks` and `/v1/yaks/config` and never `/v1/yaksx`. A method the row's `access` does not name (checked with `Object.hasOwn`) is `405` with `Allow` in the map's key order, never a default access. A prefix ending in `/`, or listed twice, throws when the router is built.

The longest-prefix test is exported on its own as `matchPrefixRoute(pathname, rows)`. `match(request)` returns `Matched` (with `route` and `access`), `MethodNotAllowed` (with `allow`) or `NotFound`, with no I/O. `handle(request, forward)` answers the two refusals as problem+json and calls `forward({ request, route, access })` for a match, so verify-once and the binding call stay in the gateway:

```ts
import { Hera } from "@sibylline-labs/hera";

const gateway = Hera.prefixRouter([
  { prefix: "/v1/yaks", product: "yak", binding: "YAK", access: { POST: "write", PUT: "write", GET: "read" } },
  { prefix: "/v1/gates", product: "linear-proxy", binding: "GATES", access: { POST: "write", GET: "read" } },
] as const);

declare const verifyAndForward: (
  request: Request,
  binding: "YAK" | "GATES",
  access: "write" | "read"
) => Promise<Response>;

export const fetchGateway = (request: Request): Promise<Response> =>
  gateway.handle(request, ({ route, access }) => verifyAndForward(request, route.binding, access));
```

### Verifying Signed Webhooks (`HeraWebhook.verifyHmac`)

A webhook delivery carries no bearer token: its credential is an HMAC over the raw body. `HeraWebhook.verifyHmac(options)` builds a verifier once per provider, and `verifier(request)` is an `Effect` that succeeds with the body bytes or fails with `HeraError`:

- **Signature.** `header` names the signature header; `algo` (`"SHA-256"` default, `"SHA-384"`, `"SHA-512"`), `encoding` (`"hex"` default or `"base64"`) and an exact `prefix` (e.g. `"sha256="`) describe its value. The value must decode to exactly the digest length before any key is imported, and digests are compared only by `crypto.subtle.verify` (constant time).
- **Keys and rotation.** `secret` is one secret or a list (current first, then previous), each a `string`, `Redacted<string>`, `Keyring` or `Redacted<Keyring>`. Every key is verified and any match passes, so a rollover keeps the old key in the list until senders stop using it. A string loses one trailing line ending (`HeraConfig.stripTrailingNewline`); an empty one is unset and skipped. A keyring contributes every entry's bytes.
- **Timestamp.** `timestamp` is optional. `{ read, unit?, toleranceMs }` reads it from the signed body (Linear's `webhookTimestamp`), and `read` runs only after the signature verifies. `{ header, payload, unit?, toleranceMs }` reads decimal digits from a header, and the HMAC is verified over `payload(timestamp, body)`, the bytes the sender signs (Slack: `` (ts, body) => concat(`v0:${ts}:`, body) ``). A header timestamp outside the HMAC could be rewritten, letting a captured delivery replay forever, so `payload` is required: it is part of the type, and the verifier throws at construction without it. A timestamp outside `toleranceMs` of the Effect `Clock`, either way, or one that is absent or not finite, is refused.
- **Combined header (`parse`).** A provider that puts the timestamp and several signatures in one header (Stripe's `t=…,v1=…,v1=…`) sets `parse(value)`, returning `{ timestamp?, signatures }` or `undefined`. Each signature is decoded with `encoding` and `prefix` and undecodable ones are dropped; `undefined`, no usable signature, or more than 8 is `malformed_signature`, before any key is imported. The third timestamp arm, `{ signed: true, payload, unit?, toleranceMs }`, takes the timestamp `parse` returned (absent is `missing_timestamp`) and verifies the HMAC over `payload(timestamp, body)`; it throws at construction without `parse`. Every key is verified against every candidate with no early exit, and any match admits.
- **Stripe.** `HeraWebhook.stripe({ secret, toleranceMs = 300_000, maxBytes? })` is the preset: header `stripe-signature`, `t` kept only when it appears exactly once, every `v1` a candidate (other schemes ignored), signed bytes `${t}.${body}`, seconds, hex, SHA-256. A rotation header carries one `v1` per active secret, so it verifies under either secret alone.
- **Body cap.** `maxBytes` (default 64 KiB) is checked against a declared `content-length` and then while streaming, before any HMAC: over it is `413 payload_too_large`.
- **One refusal.** Every other refusal is `401 invalid_signature` with the same detail, so the response does not say which check failed. The reason (`unconfigured`, `missing_signature`, `malformed_signature`, `bad_signature`, `missing_timestamp`, `stale`, `too_large`) is the error's `cause`, read with `HeraWebhook.refusalReason(error)` for the caller's own log line. It never carries a secret, signature or body byte, and the verifier logs nothing.
- **Body consumed.** The verifier reads `request.body`, so the returned bytes are the caller's only copy.

```ts
import * as Effect from "effect/Effect";
import { Hera, HeraError, HeraWebhook } from "@sibylline-labs/hera";

declare const env: { LINEAR_WEBHOOK_SECRET?: string; LINEAR_WEBHOOK_SECRET_PREVIOUS?: string };

const verifyLinear = HeraWebhook.verifyHmac({
  secret: [env.LINEAR_WEBHOOK_SECRET ?? "", env.LINEAR_WEBHOOK_SECRET_PREVIOUS ?? ""],
  header: "linear-signature",
  timestamp: {
    read: (body) => {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
      const ts = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "webhookTimestamp") : undefined;
      return typeof ts === "number" ? ts : undefined;
    },
    toleranceMs: 60_000,
  },
});

export const receiveLinear = Hera.fn("Gateway.linearWebhook")(function* (request: Request) {
  const body = yield* verifyLinear(request).pipe(
    Effect.tapError((error: HeraError) =>
      Effect.logWarning("gateway.webhook_rejected", { reason: HeraWebhook.refusalReason(error) })
    )
  );
  return body.byteLength;
});
```

A Stripe endpoint is the preset:

```ts
import { HeraWebhook } from "@sibylline-labs/hera";

declare const env: { STRIPE_WEBHOOK_SECRET?: string };

export const verifyStripe = HeraWebhook.stripe({ secret: env.STRIPE_WEBHOOK_SECRET ?? "" });
```

---

## 2. Typed Worker-to-Worker RPC (`@sibylline-labs/hera/rpc`)

`Hera.rpcMethod` and `Hera.rpcClient` provide schema-validated RPC across Cloudflare Worker service bindings or Durable Object stubs. The callee returns a Structured-Clone-safe `HeraRpcResult<A>` wire envelope:

- Success: `{ ok: true, value }`.
- Failure: `{ ok: false, status, code, error, message, requestId?, retryAfter?, issues?, fields? }`.

### Server-Side `Hera.rpcMethod`

The spec is `{ name?, service?, input?, layer?, onDefect?, handler }`. `name` is the method name (required in the object form; `Hera.rpcMethod(name, spec)` also works). There is no `output` schema: the handler's return value becomes `value` after being copied into a plain object. The handler receives the decoded `input` and a `HeraRpcHandlerContext` (`method`, `service`, `requestId`, `heraCtx`, `tenant?`).

```ts
import * as Schema from "effect/Schema";
import { Hera, OrgId } from "@sibylline-labs/hera";

export const CheckEntitlementRpc = Hera.rpcMethod({
  name: "checkEntitlement",
  service: "accounts",
  input: Schema.Struct({
    orgId: OrgId,
    feature: Schema.String,
  }),
  handler: (input, ctx) =>
    Hera.fn("AccountsRpc.checkEntitlement")(function* () {
      return {
        allowed: input.feature !== "disabled",
        requestId: ctx.requestId,
      };
    })(),
});
```

### Caller-Side `Hera.rpcClient`

`Hera.rpcClient(binding | () => binding, { service?, codes?, onTransportError?, retry? })` wraps a service binding or Durable Object stub whose methods are `rpcMethod`s. Each method becomes an `Effect` that:

- Succeeds with the `value` of an `{ ok: true }` envelope.
- Fails with a `HeraError` rehydrated from an `{ ok: false }` envelope or an RFC 7807 problem details object (`type`, `code`, `status`), reading `code`, `status`, `fields`, `issues` and `retryAfter`/`retry_after`.
- Keeps a service domain code (and its declared status) only when its registry is in `codes` (`HeraError.codes`, see [ERRORS.md](../ERRORS.md)); any other non-catalog code becomes `${service}_unavailable`.
- Fails with `503 ${service}_unavailable` (e.g. `accounts_unavailable`; `service_unavailable` when no `service` is named) when the call itself rejects or times out. `fields.retryable` classifies the rejection (`retry.isRetryable`, default `isRetryableTransportError`; a timeout is always retryable, a thrown `HeraError` never), and the same facts, plus the 1-based `attempt` and `timedOut`, go to `onTransportError` once per failed attempt.

`rpcClient` retries only when asked, and forwards the calling fiber's correlation and trace context only when asked:

- **Retry is opt-in (`retry`).** `retry: { attempts, backoff?, timeoutMs?, isRetryable?, onRetry? }` re-runs a rejected or timed-out call up to `attempts` times in total (the first included), sleeping a full-jitter exponential backoff on the Effect `Clock` (`min(maxMs, baseMs * 2^(n-1) * random)`, default `{ baseMs: 50, maxMs: 1000 }`, so `TestClock` drives it in tests). Each attempt re-resolves a `() => stub` binding, because a stub that has thrown stays broken. An `{ ok: false }` or problem-details refusal is a returned value and is never retried. `timeoutMs` abandons an unsettled attempt and counts it as retryable; abandoning does not cancel the call, so set it only on calls that are safe to apply twice. On exhaustion the 503 carries `fields.attempts` and `fields.timedOut`. `onRetry({ service, method, attempt, backoffMs, errorName, timedOut })` fires before each sleep.
- **The default predicate follows Cloudflare's flags.** `isRetryableTransportError` never retries an `overloaded` error (retrying worsens the overload), retries a `retryable` one, never retries a `remote` one (thrown by the callee's own code), and otherwise matches transient `workerd` messages (`Network connection lost.`, `Durable Object reset`, ...). Pass `isRetryable` to override it. This also changes `fields.retryable` for clients without `retry`: an `overloaded` error, or a `remote` one that is not flagged `retryable`, now reports `false`. A throwing `isRetryable` or `onRetry` is a defect.
- **Without `retry`, retrying is the caller's concern.** Use `fields.retryable` to decide. A deterministic refusal (a 4xx `code`) is never retryable.
- **Propagation is opt-in (`propagate: true`).** With it, `rpcClient` appends one marked `HeraRpcInvokeMeta` (`{ __heraRpcMeta: true, requestId, orgId, actorId, traceparent, baggage }`) as the last argument, read from the calling fiber: the Hera ctx in scope, the active span as a W3C `traceparent` (`00-<trace id>-<span id>-<flags>`), and the inbound `baggage` of the RPC call the fiber serves. The receiving `rpcMethod` lifts it off its arguments (`extractTrailingRpcMeta`), so a zero-argument call still sees `input` as `undefined`. Its `rpc.<service>.<method>` span parents under the caller's client span, so one trace runs across the hop, and it runs under the caller's `requestId`. A malformed or all-zero `traceparent` is ignored and the callee starts a fresh trace.
- **A caller's org is log correlation, never a tenant.** An `orgId` / `actorId` that arrives only in the appended meta reaches the callee's log lines (`org_id`, `actor_id`) when the callee has no tenant of its own; it never builds `HeraTenantCtx` or `HeraCtx.actorId`. The callee's tenant still comes from `meta.tenant`, an explicit `meta.orgId` (the second argument), or an `orgId` field in the input. Put `orgId` in the input so the handler runs under `HeraTenantCtx`.
- **Explicit meta wins.** A second argument you pass yourself (`{ requestId }`, `{ orgId }`) keeps every field it sets; the appended meta fills only the rest. A forwarder whose last argument is already a marked meta has it merged, never duplicated.
- **`baggage` is opaque.** It is forwarded hop to hop and never logged or set as a span attribute. A value over `MAX_BAGGAGE_LENGTH` (8192) characters, or one with a line break, is dropped whole.
- **Why the default is off.** Without `propagate`, the caller's arguments cross untouched, exactly as before propagation existed. Turn it on only for a binding whose callee is an `rpcMethod` that strips a trailing meta, and only once every caller and callee on that edge runs such a Hera: an older `rpcMethod` reads a second argument as its tenant-bearing meta, so an appended meta would make it adopt the caller's org as its tenant, and a zero-argument call would hand it the meta as its input. A plain method (a Durable Object stub, a wrapper that calls `rpcMethod(...)()` itself) binds the extra argument into its next optional parameter. A test double from `makeTestRpcDouble` lifts an appended meta the same way `rpcMethod` does.

```ts
import {
  Hera,
  type HeraRpcInvokeMeta,
  type HeraRpcResult,
  type OrgId,
} from "@sibylline-labs/hera";

// The shape wrangler's generated types give the accounts service binding.
declare const env: {
  readonly ACCOUNTS: {
    checkEntitlement(
      input: { readonly orgId: string; readonly feature: string },
      meta?: HeraRpcInvokeMeta,
    ): Promise<HeraRpcResult<{ readonly allowed: boolean; readonly requestId: string }>>;
  };
};

const accounts = Hera.rpcClient(() => env.ACCOUNTS, {
  service: "accounts",
  retry: { attempts: 3, backoff: { baseMs: 50, maxMs: 1000 }, timeoutMs: 10_000 },
});

export const canUseFeature = Hera.fn("Entitlements.canUse")(function* (
  orgId: OrgId,
  feature: string,
) {
  const res = yield* accounts.checkEntitlement({ orgId, feature });
  return res.allowed;
});
```

### HTTP over RPC (`Hera.httpRpcMethod`, `Hera.httpRpcClient`)

Forward HTTP across a service binding with these, never with a method that takes a raw `Request` or returns a raw `Response`. A `Request` or `Response` with a body crosses Workers JS RPC as a stream plus a `StreamCanceler` capability, and workerd can cancel the callee as hung after it already answered, killing its `waitUntil` work ([cloudflare/workerd#8674](https://github.com/cloudflare/workerd/issues/8674)). Reading the body to the end does not always avoid it. The HTTP-over-RPC primitive sends plain structured-clone envelopes instead, which carry no stream:

- `HttpRpcRequest`: `{ url, method, headers, body }` and `HttpRpcReply`: `{ status, headers, body }`. `headers` is every `[name, value]` pair in order, each `set-cookie` its own pair; `body` is the whole body as an `ArrayBuffer`, or `null` for `GET` / `HEAD`, a null-body status (`101`, `204`, `205`, `304`) or no body.
- `toHttpRpcRequest(request, { maxBytes? })` and `toHttpRpcReply(response, { maxBytes? })` read the body whole up to `maxBytes` (default `MAX_HTTP_RPC_BYTES`, 25 MiB; at most `MAX_JS_RPC_MESSAGE_BYTES`, workerd's 32 MiB message limit). A request over the cap rejects with `413 payload_too_large`, refused on its declared `content-length` before a byte is read and otherwise as soon as the stream passes the cap; a reply over the cap rejects with `502 bad_gateway`.
- `fromHttpRpcRequest(input)` and `fromHttpRpcReply(reply)` take either the envelope or the raw Web value, so the caller and the callee can deploy in either order. Anything else is a `400 invalid_rpc_input` or a `502 bad_gateway`.

`Hera.httpRpcMethod(name, { service?, maxBytes?, layer?, onDefect?, telemetry?, handler | router })` is an `rpcMethod` that reads the request (envelope or raw `Request`), answers it with `handler(request, ctx)` (an Effect of a `Response`) or a `Hera.router` dispatched with the call's `heraCtx` and `tenant`, and returns `Promise<HeraRpcResult<HttpRpcReply>>`. It inherits `rpcMethod`'s span, invoke meta and defect trapping. Have the entrypoint method return its call:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  Hera,
  type HeraRouter,
  type HeraRpcInvokeMeta,
  type HeraRpcResult,
  type HttpRpcReply,
  type HttpRpcRequest,
} from "@sibylline-labs/hera";

declare const api: HeraRouter; // Hera.router([...]) over the Worker's routes

const handleMethod = Hera.httpRpcMethod("handle", { service: "api", router: api });

export class ApiEntrypoint extends WorkerEntrypoint {
  handle(input: HttpRpcRequest, meta?: HeraRpcInvokeMeta): Promise<HeraRpcResult<HttpRpcReply>> {
    return handleMethod(input, meta);
  }
}
```

`Hera.httpRpcClient(binding | () => binding, { method?, maxBytes?, ...rpcClient options })` gives `fetch(request): Effect<Response, HeraError>`. It sends an `HttpRpcRequest` to `method` (default `"handle"`), fails `413` before calling the binding when the body is over the cap, and rebuilds the callee's `Response`. It is an `rpcClient`, so `retry`, `propagate` and the `503 <service>_unavailable` mapping work as above. A callee still answering a raw `Response`, or a bare `HttpRpcReply` with no `{ ok }` envelope, is read as its reply.

```ts
import { Hera } from "@sibylline-labs/hera";

declare const env: { readonly API: { handle(input: unknown, meta?: unknown): Promise<unknown> } };

const api = Hera.httpRpcClient(() => env.API, { service: "api", propagate: true });

export const forward = Hera.fn("Gateway.forward")(function* (request: Request) {
  return yield* api.fetch(request);
});
```

`test/workerd/http-rpc.test.ts` observes it on workerd: a `POST` with a JSON body, the caller holding `waitUntil`, ends every callee invocation `ok` and returns the reply body, while a control method taking a raw `Request` it never reads is cancelled.

---

## 3. Queue Consumers (`Hera.queueConsumer`)

`Hera.queueConsumer` turns a `Hera.fn` handler into a Worker `queue` handler. It decodes every message body with an optional Effect Schema, provides `HeraCtx` (a fresh `requestId` per batch, `service` = `service ?? name`) and a span named `name`, then settles the whole batch exactly once from the handler's exit. The returned function never rejects.

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Hera, HeraError, type HeraQueueBatch } from "@sibylline-labs/hera";

const Envelope = Schema.Struct({ event_id: Schema.String, org_id: Schema.String });

interface Env {
  readonly ARCHIVE: { put(key: string, body: string): Promise<unknown> };
}

const archive = Hera.queueConsumer({
  name: "Events.archive",
  service: "events",
  schema: Envelope,
  retryDelaySeconds: 60,
  handler: Hera.fn("Events.archive")(function* (batch: HeraQueueBatch<typeof Envelope.Type>, env: Env) {
    // batch.messages: decoded bodies. batch.invalid: the ones that failed decode, with their
    // raw body and { path, code } issues. Park them here; they settle with the batch.
    const lines = batch.messages.map((m) => JSON.stringify(m.body)).join("\n");
    yield* Effect.tryPromise({
      try: () => env.ARCHIVE.put(`events/${batch.queue}.ndjson`, lines),
      catch: (cause) =>
        HeraError.serviceUnavailable("Archive unavailable", { fields: { retryable: true }, cause }),
    });
  }),
});

export default {
  queue: (batch: MessageBatch<unknown>, env: Env) => archive(batch, env),
};
```

| Handler exit | Batch call | Log line |
|---|---|---|
| Success | `ackAll()` | none |
| `HeraError` (or `HeraError.define` instance) with `fields.retryable === true` | `retryAll({ delaySeconds })`: the error's `retryAfter`, else `retryDelaySeconds` (default `30`), clamped to `0`–`43200` | `hera.queue.batch_retry` (warn) with `code`, `delaySeconds` |
| Any other typed failure | `retryAll()`, so the queue's `max_retries` moves it to the dead-letter queue instead of dropping it | `hera.queue.batch_failed` (error) with `code` |
| Defect (`Effect.die`, a throw while building the Effect) or interrupt | `retryAll()` | `hera.queue.batch_defect` (error) with the defect's class name only, never its message |

- **A poisoned message never stalls the batch.** A body that fails decode is not a failure: Hera logs `hera.queue.message_invalid` (error) with `queue`, `messageId`, `attempts` and `issues` (paths and codes, never values) and passes it to the handler in `batch.invalid`. It is acked or retried with the rest of the batch, so a handler that must keep it parks it before returning.
- **Settlement comes first.** The batch is settled before any outcome line is written, and a throwing log sink cannot skip it. If `ackAll`/`retryAll` itself throws, Hera logs `hera.queue.settle_failed` and resolves; workerd then redelivers.
- **Annotate `batch` in a `Hera.fn` generator.** `Hera.fn` (like `Effect.fn`) infers its parameters from the generator, not from `handler`'s type, so an unannotated `batch` is `any`. A plain arrow handler `(batch, env) => …` is typed from the spec without annotation.
- **Without `schema`,** bodies pass through as `unknown` and `batch.invalid` is always empty.
- **One consumer per queue shape.** A Worker bound to several queues dispatches on `batch.queue` and calls the matching consumer.
- **Producer links.** A body sent by `HeraOutbox.queueSink({ trace: true })` arrives as `{ __heraTrace: { v: 1, traceparent?, requestId? }, payload }`. The consumer unwraps it before decode (the schema sees `payload`), sets `traceparent` and `requestId` on the message, and opens its batch span (`kind: "consumer"`) with one `SpanLink` per message whose `traceparent` is valid, so the batch links back to every producer trace. When every traced message carries the same `requestId`, the batch's `HeraCtx` uses it instead of minting one. A body without a well-formed envelope passes through unchanged.
