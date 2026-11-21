# Error Catalog, Error Envelope & CLI Exit Codes

`@sibylline-labs/hera` provides two purpose-built error systems matched to their execution plane:
1. **`HeraError` (`@sibylline-labs/hera/errors`, `src/core/errors/`)**: Closed-catalog yieldable `Data.TaggedError` for HTTP routes, Worker RPC, and Durable Objects, serializing to RFC 7807 problem details (`application/problem+json`) with `code` as an extension member.
2. **`ErisError` (`@sibylline-labs/hera/cli`, `src/cli/errors/`)**: Structured CLI error with deterministic exit codes (`1`, `2`, `3`, `124`) and a failure block (`ERROR <what>`, `slug:`, `fix:`, `docs:`).

---

## 1. `HeraError` & The Closed Error Catalog (`src/core/errors/`)

`HeraError` restricts HTTP status codes to the closed `HeraErrorStatus` union (`400 | 401 | 402 | 403 | 404 | 405 | 409 | 412 | 413 | 422 | 429 | 500 | 502 | 503`) and maps every refusal code in `HERA_ERROR_CATALOG` (plus template codes `${string}_unconfigured`, `${string}_invalid_config`, `${string}_unavailable`) to a deterministic status and public-safe message.

### Status Factory Methods & Catalog Codes

| Factory Method | Default Code | HTTP Status | Selected Catalog Codes in Band |
|---|---|---|---|
| `HeraError.badRequest(msg?, opts?)` | `bad_request` | `400` | `bad_request`, `invalid_request`, `invalid_body`, `invalid_query`, `invalid_headers`, `invalid_params`, `invalid_json`, `invalid_rpc_input`, `invalid_cursor`, `agent_tool_input_invalid` |
| `HeraError.unauthorized(msg?, opts?)` | `unauthorized` | `401` | `unauthorized`, `invalid_token`, `revoked`, `org_mismatch`, `invalid_session`, `invalid_signature`, `token_expired` |
| `HeraError.paymentRequired(msg?, opts?)` | `entitlement_lapsed` | `402` | `entitlement_lapsed`, `no_seat` |
| `HeraError.forbidden(msg?, opts?)` | `forbidden` | `403` | `forbidden`, `scope_denied`, `insufficient_scope`, `origin_denied`, `admin_required`, `actor_kind_denied`, `linear_input_forbidden`, `agent_egress_host_denied` |
| `HeraError.notFound(msg?, opts?)` | `not_found` | `404` | `not_found`, `route_not_found`, `org_not_found`, `receipt_not_found`, `cluster_not_found`, `resource_not_found` |
| `HeraError.methodNotAllowed(msg?, opts?)` | `method_not_allowed` | `405` | `method_not_allowed` |
| `HeraError.conflict(msg?, opts?)` | `conflict` | `409` | `conflict`, `linear_disconnected`, `org_one_bound`, `already_bound`, `workspace_taken`, `idempotency_conflict` |
| `HeraError.preconditionFailed(msg?, opts?)` | `precondition_failed` | `412` | `precondition_failed` (a failed `If-Match` / `If-None-Match`, e.g. [`HeraObjectStore`](guides/object-store.md#4-errors)) |
| `HeraError.payloadTooLarge(msg?, opts?)` | `payload_too_large` | `413` | `payload_too_large` |
| `HeraError.unprocessable(msg?, opts?)` | `unprocessable_entity` | `422` | `unprocessable_entity`, `invalid_spec`, `unsupported_contract_version` |
| `HeraError.rateLimited(msg?, opts?)` | `rate_limited` | `429` | `rate_limited`, `quota_exceeded` |
| `HeraError.internal(msg?, opts?)` | `internal_error` | `500` | `internal_error` |
| `HeraError.badGateway(msg?, opts?)` | `bad_gateway` | `502` | `bad_gateway`, `upstream_error` |
| `HeraError.serviceUnavailable(msg?, opts?)` | `service_unavailable` | `503` | `service_unavailable`, `internal_unavailable`, `secret_unconfigured`, `secret_invalid`, `agent_egress_unconfigured`, `${service}_unavailable` |

### Agent plane codes (`@sibylline-labs/hera/agent`)

These codes are raised inside an agent Durable Object. They never reach an HTTP client directly, so a consumer that surfaces one on a route maps it at its own door. See [the agent guide](guides/agent.md).

#### `agent_tool_input_invalid`

`400`. The model's raw tool arguments failed the tool's Effect Schema. Hera decodes the raw arguments strictly in Pi's `prepareArguments`, before Pi coerces them (for example, `{key:3}` against a string schema). Pi records the call as an error tool result for the model, and `execute` never runs. Fix: correct the tool's `input` schema or the prompt. The issue summary goes to the model and never to logs.

#### `agent_egress_host_denied`

`403`. A model request's `baseUrl` host is not in `HERA_AGENT_EGRESS_HOSTS` (`gateway.ai.cloudflare.com`), or the URL is not `https`. The request is refused before it leaves the object, and the generation ends `stopReason: "error"`. Fix: route through `HeraAgentEgress`, whose base URL is the AI Gateway `google-ai-studio` route. Widen only by editing the allowlist.

#### `agent_egress_unconfigured`

`503`. `HeraAgentEgress` was built without a required value (`accountId`, `gateway` or `apiKey`). Fix: bind the consumer's Worker secrets and vars. The Gemini API key is a Worker secret. The gateway token is optional and is sent as `cf-aig-authorization` only when set.

### Defining Domain Errors (`HeraError.define`)

Use `HeraError.define` to create typed, yieldable domain error classes with schema-validated extension fields:

```ts
import * as Schema from "effect/Schema";
import { HeraError, OrgId } from "@sibylline-labs/hera";

export class WorkspaceTakenError extends HeraError.define("WorkspaceTakenError", {
  code: "workspace_taken",
  status: 409,
  fields: {
    orgId: OrgId,
    workspaceSlug: Schema.String,
  },
}) {}
```

`HeraError.define` accepts catalog codes only. A service's own vocabulary goes through a registry.

### Service Domain Codes (`HeraError.codes`)

A consuming service declares the failure codes it owns, each with its status, in a registry. This keeps
product vocabulary out of `HERA_ERROR_CATALOG` while those codes still cross `rpcMethod` and problem+json
at their declared status (a code the catalog does not know otherwise falls to `503`).

```ts
import * as Schema from "effect/Schema";
import { HeraError } from "@sibylline-labs/hera";

export const AccountsCodes = HeraError.codes("accounts", {
  member_deactivated: { status: 403 },
  slow_down: { status: 400, publicMessage: "Polling too fast" },
});

export const MemberDeactivated = AccountsCodes.define("MemberDeactivated", {
  code: "member_deactivated",
});
export const DeviceCodeSlowDown = AccountsCodes.define("DeviceCodeSlowDown", {
  code: "slow_down",
  fields: { interval: Schema.Number },
});

// In a handler: `yield* new DeviceCodeSlowDown({ interval: 10 })`,
// or, with no class: `Effect.fail(AccountsCodes.make("member_deactivated"))`.
```

| Member | What it does |
|---|---|
| `codes.<code>` | The code as a `HeraDomainErrorCode<"<code>">`. A raw string never type-checks as one. |
| `define(tag, { code, publicMessage?, fields? })` | A `HeraError.define`-style class at the registry's status. |
| `make(code, options?)` | A plain `HeraError` at the registry's status. |
| `has(u)`, `status(code)`, `resolve(code)` | Lookups. `resolve` is what `Hera.rpcClient`'s `codes` option reads. |

Rules, checked when the registry is built (a type error for a literal spec, and a thrown `Error` at module
init):

- A code is lower snake_case.
- A code cannot be a catalog code or end in a template suffix (`_unconfigured`, `_invalid_config`,
  `_unavailable`).
- A status is a `HeraErrorStatus`.

**Extra wire values ride `fields`.** A defined error's `fields` reach the RPC wire as
`HeraRpcFail.fields`, and problem+json both as `fields` and spread at the top level (Section 2). So an
RFC 8628 `slow_down` carries its raised poll interval as `fields.interval` on the RPC wire and as
`interval` in problem+json. `HeraRpcFail` has no per-code top-level keys.

**The caller keeps the code only when it knows the registry.** Pass it to the client:
`Hera.rpcClient(env.ACCOUNTS, { service: "accounts", codes: [AccountsCodes] })`. A declared code then
rehydrates with the registry's status and message; a code no registry declares maps to
`<service>_unavailable`.

**A transport failure is `<service>_unavailable` whatever the retry policy.** A rejected or timed-out
call (`Hera.rpcClient`'s opt-in `retry`, see the [RPC guide](guides/workers-and-routes.md)) fails
`503 <service>_unavailable` (`service_unavailable` for an unnamed client) with `fields.retryable`,
and, when `retry` is set, `fields.attempts` and `fields.timedOut`. No new code is added for a timeout.

---

## 2. Error Envelope Wire Format

Route boundaries (`publicRoute`, `authedRoute`, `tenantRoute`) answer every expected `HeraError`, decode failure and caught defect through `HeraError.toResponse(error, { requestId })`. The body is an RFC 7807 problem details object. The response is `Content-Type: application/problem+json; charset=utf-8` with `Cache-Control: no-store` and `X-Request-Id`, plus `WWW-Authenticate: Bearer` on a 401 and `Retry-After` when `retry_after` is set. A `POST` whose body fails `Schema.Struct({ orgId: OrgId })` returns:

```json
{
  "type": "urn:hera:error:invalid_request_body",
  "title": "Invalid request body",
  "status": 400,
  "detail": "Invalid request body",
  "code": "invalid_request_body",
  "issues": [
    {
      "path": ["orgId"],
      "code": "Filter",
      "expected": "OrgId matching /^(?:org_)?[0-9A-HJKMNP-TV-Z]{26}$/",
      "message": "Expected OrgId matching /^(?:org_)?[0-9A-HJKMNP-TV-Z]{26}$/"
    }
  ],
  "request_id": "req_01HZX8VQXZ9K0M1N2P3Q4R5S6T"
}
```

- RFC 7807 members: `type` is `urn:hera:error:<code>` (`HERA_PROBLEM_TYPE_PREFIX`), `title` is the catalog message for the code (the same for every occurrence of a `type`), `status` mirrors the HTTP status, and `detail` is this error's public message.
- Extension members: `code` is the closed-catalog code, so a consumer can switch on `code` or `type`. `request_id`, `retry_after`, `issues` and `fields` appear only when set. Sanitized `fields` from `HeraError.define` are also spread at the top level, except reserved keys (RFC members included).
- There is no `ok` member. The `{ ok: false, status, code, … }` POJO is the Worker RPC contract that `Hera.rpcMethod` returns, not the HTTP wire.
- `error.toProblemDetails({ requestId })` returns this body as a typed `HeraProblemDetails`, without the top-level `fields` spread.
- `HeraHttp.toProblemResponse(error, init?)` is the same serializer: it delegates to `HeraError.toResponse` and merges `init.headers`.
- A raw success (`HeraHttp.raw`, see [workers-and-routes.md](guides/workers-and-routes.md#success-replies-envelope-or-raw)) changes only the success side: a failure from the same route is still this problem+json body.

### Security & Redaction Guarantees

- **Zero Rejected Value Echoing**: `HeraSchema` decoders strip rejected input values so a malformed secret or token sent in a request payload is never echoed back in `issues`.
- **Forbidden Field Stripping**: `sanitizeErrorFields` strips reserved envelope keys and any secret-like field names (`secret`, `token`, `password`, `authorization`, `cookie`, `api_key`, `private_key`) before serialization.
- **Closed 503 Defect Boundary**: Unhandled defects (`Cause.die`) caught at HTTP or RPC boundaries log the defect metadata internally and return a closed `503 internal_unavailable` problem details response without stack traces or internal SQL details.
- **Authority-Guarded Routes**: `Hera.authedRoute` with `authority` cuts the exact held credential, then credential shapes, from every field it renders, drops the error's `cause` and `issues`, and dies with `HeraAuthorityVerifierDefect` when any part of the authority step throws. Its slugs are below.
- **Queue Consumer Boundary**: `Hera.queueConsumer` adds no error code. It reads `fields.retryable === true` on a `HeraError` (`definedFields` on a `HeraError.define` instance) to choose a delayed `retryAll`, and logs `hera.queue.batch_retry` (warn), `hera.queue.batch_failed`, `hera.queue.batch_defect` (defect class name only), `hera.queue.message_invalid` (decode paths and codes only) and `hera.queue.settle_failed` (all error). See [the guide](guides/workers-and-routes.md#3-queue-consumers-heraqueueconsumer).


### Authority-guarded route slugs (`Hera.authedRoute` `authority`)

A refusal is `403` `code: forbidden` with the verifier's own code in `slug` (see [the guide](guides/workers-and-routes.md#authority-guarded-routes-authority)). Hera adds these:

#### `authority-credential-missing`

`403`. The route's `credential` reader returned `undefined` or an empty value, so the verifier was not called and the handler did not run. Fix: send the credential the route reads (its header or body field) and retry.

#### `authority-refused`

`403`. The verifier refused with a code that contained the credential or a credential shape, so Hera replaced the code. Fix: build refusal codes from fixed kebab-case words, never from request input; the verifier's `what` and `fix` are shown with the credential redacted.

#### `authority-verifier-unavailable`

`503` `service_unavailable`, `retryable: true`, with `retry_after` when the verifier was rate limited. The verifier's transport failed, it failed outside the error catalogue, or its layer failed with a code Hera could not show. Fix: retry after `retry_after` under the caller's idempotency key; if it persists, check the verifier's own service.

---

## 3. CLI Error Taxonomy & Exit Codes (`ErisError`, `src/cli/errors/`)

In `@sibylline-labs/hera/cli`, `ErisError` (fields `slug`, `what`, `fix?`, `docs?`, `exitCode`, `cause?`) maps every failure class to a deterministic exit code and renders a human diagnostic block with automatic credential scrubbing (`scrubFreeText`):

```
ERROR <what>
slug: <slug>
fix: <fix line>
docs: <ERIS_HOME>/docs/ERRORS.md#<slug>
docs: <docs base>/docs/ERRORS.md#<slug>
```

The `docs/ERRORS.md` path is the default for an error that carries no `docs`, including the errors `HeraCli.verb` builds itself (argument-decode `usage`, `cli-internal-error`) and authority refusals. A CLI with a different catalog file or docs site sets `docs: { base?, path? }` on the verb, or `docsBase` / `docsPath` in the per-run `HeraCliCtxInput`, which wins over the verb's value.

Each non-blank line of `fix` prints as its own `fix: ` row. When `fix` is omitted or blank the block has no `fix:` line.

| Factory Method | Exit Code | Typical Cause |
|---|---|---|
| *(Success)* | `0` | Verb completed normally |
| `ErisError.operational(slug, fields)` | `1` | Runtime, subprocess, or local operational failure; also any unexpected defect (`cli-internal-error`) |
| `ErisError.usage(slug, fields)` | `2` | Invalid CLI flags or schema decode failure on argv |
| `ErisError.precondition(slug, fields)` | `3` | A required precondition is not met (for example a missing credential or lock) |
| `ErisError.timeout(slug, fields)` | `124` | Command or network timeout |

Filesystem slugs from `@sibylline-labs/hera/cli/fs`:

- `lock-held`: `DirLock` found the lock held by a live, non-stale process.
- `pair-writer-failed`: `writePairEffect` did not land the `.env` set; the previous set is intact and the stage removed.
- `pair-writer-rollback-failed`: a rollback inside `writePairEffect` failed; `what` names the snapshot under the kept `.eris-pull.*/prev/` to recover from.

`ErisError.fromHttpError(err)` maps a `HeraHttpError` or `RateLimitedError` from `HeraHttp`: a timeout becomes `timeout` (`124`), and a rate limit becomes `operational` (`1`) with the `Retry-After` hint in `fix`, as does any other HTTP failure (`GraphqlError` included).

## 4. Outbound HTTP Errors (`src/core/http/`)

Outbound calls fail with tagged errors, not `HeraError`: they describe what an upstream did, not a refusal this service serves.

| Error | `reason` | `slug` | When |
|---|---|---|---|
| `HeraHttpError` | `Timeout` | `http-timeout` | The whole exchange exceeded `timeoutMs` |
| `HeraHttpError` | `PayloadTooLarge` | `http-payload-too-large` | The body exceeded `maxBytes` |
| `HeraHttpError` | `NetworkError` | `http-network-error` | `fetch` or the body read threw |
| `HeraHttpError` | `HttpStatusError` | `http-status-error` | Any other non-2xx (for `HeraHttp.graphql`, a 3xx too: it never follows redirects); `body` holds the bounded text. For `HeraHttp.graphql`, a body that is a JSON object with a non-empty `errors` list also fills `graphqlErrors` (bounded as for `GraphqlError`) |
| `HeraHttpError` | `DecodeError` | `http-decode-error` | The body was not JSON, or failed `schema` (GraphQL: not a JSON object, or `data` failed `schema`) |
| `HeraHttpError` | `GraphqlError` | `http-graphql-error` | A GraphQL reply carried a non-empty or non-list `errors`; entries on `graphqlErrors` hold the upstream's raw message text (at most 20, 500 chars each), while `message` carries the count only |
| `RateLimitedError` | — | `http-rate-limited` | HTTP `429`; `retryAfterSeconds` / `retryAfterMs` from `Retry-After`, never auto-retried |
| `HeraOAuth2Error` | `invalid_grant` | `oauth2-invalid-grant` | Token endpoint answered 400 with `error=invalid_grant`: the code or refresh token is dead |
| `HeraOAuth2Error` | `invalid_client` | `oauth2-invalid-client` | Token endpoint answered 400/401 with `error=invalid_client`: our client credentials are wrong |
| `HeraOAuth2Error` | `upstream` | `oauth2-upstream` | Anything else, a 3xx included (redirects are never followed); `upstream` names the `HeraHttpError` reason, `RateLimited` (with `retryAfterMs`) or `DecodeError` for an unusable token pair |

`HeraOAuth2Error` carries `op`, `url`, `status` and a registered RFC 6749 / RFC 7009 `oauthCode` only: never the response body, a form field or a token, so it is safe to log and serialize.

## 5. Telemetry and Worker Guard Events (`src/core/telemetry/`, `src/server/worker/`)

Each event is one structured log line carrying `defect_name` and `exception_fingerprint` only: never
a message, a stack or a field the caller supplied.

| Event | Level | Slug | When |
|---|---|---|---|
| `hera.telemetry.unconfigured` | warn | `telemetry-unconfigured` | A `HeraTelemetry` instance with no token began its first invocation: nothing exports, loggers keep the console sink |
| `hera.worker.defect` | error | `worker-defect` | A `Hera.worker` `fetch` (answered `503 internal_unavailable`), `queue` or `scheduled` handler threw (rethrown as `HeraBoundaryDefect`) |
| `hera.worker.wait_until_rejected` | error | `worker-wait-until-rejected` | A promise passed to a guarded `ctx.waitUntil` rejected |
| `hera.alarm.defect` | error | `alarm-defect` | A Durable Object alarm pass rejected; rethrown as `HeraBoundaryDefect` so the alarm retries |

`HeraConfigError` (`status: "invalid"`, `envKey: "LOGFIRE_BASE_URL"`) is thrown by `HeraTelemetry.make`
when a token is set without `sink.baseUrl`.

