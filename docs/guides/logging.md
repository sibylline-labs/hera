# Structured Logging (`createHeraLogger`, `HeraEventLogger`)

`@sibylline-labs/hera/logger` (`src/core/logger/`) writes one JSON line per call. Every line has
the standard fields `timestamp`, `level`, `service`, `msg`, `request_id`, `org_id`, `actor_id` and
`span`, plus the caller's fields with their credentials redacted. Inside an Effect span a line
also has the span's W3C `trace_id` (32 hex) and `span_id` (16 hex), and under a tenant or authed
context `actor_kind`. It is pure core: it writes through `console` by default, so it runs under
any Worker, CLI or test runner.

**Ambient correlation.** A slot the logger left `null` is filled from the fiber the line is
written in, so a module-level logger used inside a route or a tenant Durable Object still keys
its line. Per slot, the first value wins: the logger's own binding (`createHeraLogger({ orgId })`,
`child`), an event logger call's `orgId` / `requestId` / `actorId`, the slots another logger's
`layer` bound into the fiber, then `HeraTenantCtx`, `HeraAuthedCtx`, `HeraCtx` and `HeraPublicCtx`.
`trace_id`, `span_id` and `actor_kind` come only from the fiber; a call field with those names is
dropped. A `log.sync` line written inside a running fiber (a hera callback such as `rpcClient`'s `onTransportError`) reads that
fiber's slots the same way; outside any fiber it has only its logger's own slots.

---

## 1. Event loggers: a typed registry (`events`)

Pass the service's `as const` event registry and `createHeraLogger` returns a
`HeraEventLogger<E>`. An event outside the registry is a type error at the call, and so is a
wide `string[]` registry. Each line's `msg` and `event` are the event name. Free text goes in
fields.

```ts
import { Hera } from "@sibylline-labs/hera";
import { createHeraLogger } from "@sibylline-labs/hera/logger";

export const ORDERS_LOG_EVENTS = ["orders.created", "orders.charge_failed"] as const;

const log = createHeraLogger({
  service: "orders",
  events: ORDERS_LOG_EVENTS,
  fields: { product: "orders" }, // pinned on every line; no call field can overwrite it
});

export const created = Hera.fn("Orders.created")(function* (orgId: string) {
  yield* log.info("orders.created", { orgId, items: 3 });
});

export function onQueueFailure(error: unknown): void {
  // The `sync` twin returns void, for code that logs outside an Effect.
  log.sync.error("orders.charge_failed", { error });
}
```

- **Effect and sync surfaces.** `log.info(event, fields)` returns an `Effect<void>` that never fails.
  It reads the fiber's clock, span and log annotations. `log.sync.info(...)` writes the same line
  with the wall clock, or the running fiber's ambient when called inside one, and returns `void`. Use it from a queue handler or a plain `catch`, so no
  `Effect.runSync` is needed (`hera-no-raw-effect-run`).
- **Tenant key.** A call's `orgId` (and `requestId`, `actorId`) fills the line's slot. A slot
  already bound by `child({ orgId })` wins, so a call cannot re-key a line. An `org_id` field
  is refused by the type (`HeraLogFields`) and dropped at runtime.
- **Pinned fields.** Fields bound at creation or by `child` are written after the call's fields.
  The standard fields and `event` are written last. A field named `level`, `msg`, `event`, `org_id`
  or a pinned key therefore cannot spoof the line.
- **Narrow slots.** The members are properties, so a slot typed
  `HeraEventLoggerSync<"orders.charge_failed">` accepts this logger, but not another service's.

## 2. Redaction

Each field passes through Hera's rules before it is written:

| What | Rule |
|---|---|
| `Redacted<T>` | `[REDACTED]` |
| A credential-named key (`authorization`, `api_key`, `client_secret`, `password`, `cookie`, `key_hash`, ...) | its value is `[REDACTED]` |
| A credential-shaped run inside any string or key (`sib_<ULID>_<secret>`, `lin_<kind>_<secret>`, `Bearer <cred>`, 64+ hex) | the run becomes `[REDACTED]` and the rest of the text stays readable |
| Other credential prefixes (`sk_live_`, `ol_test_`, ...) | the whole string becomes `[REDACTED]` |
| `Error` / `HeraError` | `{ name, code, message: [REDACTED] }`, with the message kept (scrubbed, at most 300 characters) only for `whitelistedErrorCodes`, or for every error under `errorMessages: "scrubbed"` |
| A function or symbol | dropped, never written as its source |
| Cycles, depth > 8 | `[CIRCULAR]`, `[TRUNCATED]` |

A consumer adds rules of its own. They are applied as a union with Hera's, so they can only
redact more:

```ts
import { createHeraLogger } from "@sibylline-labs/hera/logger";

export const log = createHeraLogger({
  service: "accounts",
  events: ["accounts.device_expired"] as const,
  secretKeys: /hash|kek|dek|sealed/i, // key names this service uses for credential material
  secretShapes: [/sibdc_[BCDFGHJKLMNPQRSTVWXZ]{8}_[A-Za-z0-9_-]+/], // a credential it mints
});
```

`GITLEAKS_SHAPES` (with `GITLEAKS_RULES`, the same patterns by gitleaks rule id) is a ready-made `secretShapes` list for third-party credentials: GitHub, AWS, GCP, Anthropic, OpenAI, Slack, Stripe, GitLab, npm, SendGrid, Hugging Face, JWTs and PEM private keys. The heads are fixed, so `ghp_short` or a 40-hex git SHA stays readable. `HeraAgentTelemetry` applies them to every exported span ([guide](agent-telemetry.md)).

### Keeping an error's reason (`errorMessages`)

By default an `Error` field writes `message: [REDACTED]`, because a message can quote a secret no
rule recognises (`db password is xyz`). A service whose failure lines need their reason opts in:

```ts
import { createHeraLogger } from "@sibylline-labs/hera/logger";

export const log = createHeraLogger({
  service: "yak",
  events: ["yak.drain_failed"] as const,
  errorMessages: "scrubbed",
});

// `{ error: { name: "Error", code: "unclassified_error", message: "Linear 500: upstream down" } }`
log.sync.error("yak.drain_failed", { error: new Error("Linear 500: upstream down") });
```

Each message, and a string `cause`, passes through the redaction above first and is then cut to
`ERROR_MESSAGE_LIMIT` (300) characters. The scrub runs before the cut, so a credential the cut
would split is already `[REDACTED]` whole and no prefix of it reaches the line. `name`, `code` and
`_tag` are handled as before. Credential shapes are the only text this mode removes, so opt in only
where error messages do not carry free-prose secrets.

## 3. Never throws

A log call runs inside catch blocks and queue handlers, where a throw would lose the failure it
was reporting. So no log call throws, on either surface:

- A field whose getter, `toJSON` or Proxy trap throws degrades the line's fields to
  `log_error: "unserializable_metadata"`. The pinned fields, the event and `org_id` are kept.
- A sink or clock that throws degrades to a minimal line, `log_error: "log_write_failed"`, still
  keyed by the bound `org_id`. That line goes through the sink, then `console`, and
  then it gives up.

## 4. Plain loggers

Without `events`, `createHeraLogger` returns the free-text `HeraLogger`. Its
`info(msg, metadata)` returns an `Effect`. Its `child(fields)` binds correlation fields, and its
`layer` provides `HeraLoggerService`. Route and RPC boundaries give `ctx.logger` this shape. Its
redaction and never-throw contracts are the same as an event logger's.

## 5. Sinks under telemetry (`sink`, `teeSinkWhenCaptured`)

A line goes to `sink` (default: `console`). While an exporting `HeraTelemetry` invocation runs, the
invocation takes the line as an OTLP log record and the sink is skipped, whichever sink the logger
has, so one line ships once. A logger made with `teeSinkWhenCaptured: true` keeps writing to its
sink as well; `child` loggers inherit the setting. Outside an invocation the sink always writes
([telemetry guide](telemetry.md)).
