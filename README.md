# @sibylline-labs/hera

**An opinionated Effect v4 runtime for Cloudflare Workers, SQLite Durable Objects, and standalone TypeScript CLIs.**

Hera gives TypeScript teams one disciplined foundation across edge services and compiled CLIs: typed routes, RPC, and Durable Objects; fail-closed config and secrets; RFC 7807 errors; scrubbed logs and OTLP telemetry; and deterministic in-memory tests — with `effect` as its only runtime dependency.

```bash
bun add @sibylline-labs/hera effect
```

---

## Why Hera

Most TypeScript stacks accumulate the same boilerplate in every Worker and CLI: hand-rolled error envelopes, ad-hoc secret loading, inconsistent logging that leaks tokens, Durable Object alarm races, and sprawling Effect usage that drifts across files. Hera solves these once and enforces the boundaries at compile and lint time:

- **One constrained Effect v4 surface** — Domain logic uses a single generator form, `Hera.fn("Service.op")(function* () { ... })`. Raw `Effect.run*` calls, Effect v3 APIs, and hand-rolled context mocks are banned by shipped [`ast-grep` rules](rules/ast-grep/).
- **Auth and tenancy checked by the compiler** — Ambient context progresses from `HeraPublicCtx` to `HeraAuthedCtx` to `HeraTenantCtx` (plus an optional `HeraAuthorityVerifier` guard). A handler that yields `HeraTenantCtx` will not compile when wired to `Hera.publicRoute`.
- **SQLite Durable Objects without the footguns** — `TenantDurableObject` and `KeyedDurableObject` run migrations lazily on first write (constructors and reads write nothing), execute synchronous `transactSync` / `transactWithOutbox` transactions with ordered sequences and dead-lettering, multiplex cron jobs onto one composite alarm, and validate lifecycle graphs at compile time with `HeraStateMachine`.
- **Fail-closed defaults and zero secret leaks** — Value-stripping Schema decoders never echo rejected input, 3-state config readers distinguish `Unconfigured` / `Invalid` / `Valid` secrets and versioned keyrings, errors serialize as RFC 7807 `application/problem+json` (or deterministic CLI exit codes), and credential shapes are scrubbed across logs, CLI output, and OTLP spans.
- **Edge Workers and compiled CLIs in one SDK, cleanly isolated** — Four strict planes (`core`, `server`, `cli`, `testing`) ensure Worker bundles never pull in Node builtins and `bun build --compile` binaries never pull in `cloudflare:workers`. Pure CLI manifests (`/cli/manifest`) and the zero-dependency TUI (`/tui`) keep `--help` and shell completion sub-50ms.

---

## Use Cases

### Multi-tenant SaaS backends on Cloudflare Workers & Durable Objects
Build HTTP APIs, Worker-to-Worker RPC services (typed methods, or HTTP forwarded over a service binding as stream-free envelopes), Queue consumers, and per-tenant SQLite Durable Objects with consistent auth, error contracts, rate limiting, and observability out of the box.
- **Start with:** [Worker Routes, Routers, Webhooks & RPC](docs/guides/workers-and-routes.md), [Multi-Tenant Durable Objects](docs/guides/durable-objects.md), [Schemas & 3-State Config](docs/guides/schema-and-config.md), [Telemetry](docs/guides/telemetry.md)

### Durable AI agents on Workers
Host long-lived tool-calling agents on a `TenantDurableObject` (per-org or per-run) with Schema-validated tools, AI Gateway egress allowlisting and metering, scrubbed GenAI OTLP span export, and scripted model tests that never import the agent runtime.
- **Start with:** [Agents](docs/guides/agent.md), [Agent Telemetry](docs/guides/agent-telemetry.md) *(uses optional peer dependencies — see [docs/README.md](docs/README.md#optional-peer-dependencies))*

### Fast standalone TypeScript CLIs (`bun build --compile`)
Declare each command's flags, operands, and lazy handler once (`HeraCli.program` over `/cli/manifest`) to derive routing, strict argv parsing, `--help`, machine-readable help JSON, and bash/zsh completions without loading handlers or `effect`. Pair with supervised subprocesses (`Runner`), atomic file/env-pair writes, PID-aware directory locks, and guided interactive prompts (`/tui`).
- **Start with:** [CLI Runtime, Process Runner, Atomic FS & HTTP](docs/guides/cli-and-http.md), [Guided Step TUI](docs/guides/tui.md)

### Deterministic, workerd-free unit & integration testing
Test routes, RPC fault paths, SQLite Durable Objects (including outbox draining and alarms), R2 object storage, feature flags, authority checks, and OTLP telemetry in memory with a controllable Effect clock — and run the same Worker code against real `miniflare` when needed.
- **Start with:** [Testing with `HeraTest`](docs/guides/testing.md)

---

## Quickstarts

### 1. Cloudflare Worker Route (`@sibylline-labs/hera`)

```ts
import * as Schema from "effect/Schema";
import {
  Hera,
  HeraError,
  HeraSchema,
  HeraTenantCtx,
  OrgId,
} from "@sibylline-labs/hera";

export const OrderId = HeraSchema.brandedId("OrderId", /^ord_[0-9A-HJKMNP-TV-Z]{26}$/);
export type OrderId = typeof OrderId.Type;

export class QuotaExceededError extends HeraError.define("QuotaExceededError", {
  code: "quota_exceeded",
  status: 429,
  publicMessage: "Order exceeds tenant quota",
  fields: { orgId: OrgId, limitCents: Schema.Number },
}) {}

export const createOrder = Hera.fn("Orders.create")(function* (input: {
  readonly orderId: OrderId;
  readonly amountCents: number;
}) {
  const ctx = yield* HeraTenantCtx.current;
  yield* ctx.logger.info("orders.creating", { orderId: input.orderId });

  if (input.amountCents > 100_000_00) {
    return yield* new QuotaExceededError({
      orgId: ctx.orgId,
      limitCents: 100_000_00,
    });
  }

  return {
    orderId: input.orderId,
    orgId: ctx.orgId,
    amountCents: input.amountCents,
  };
});

export const createOrderRoute = Hera.authedRoute({
  method: "POST",
  path: "/v1/orders",
  scopes: ["orders:write"],
  body: Schema.Struct({
    orderId: OrderId,
    amountCents: Schema.Number,
  }),
  handler: ({ body }) => createOrder(body),
});
```

Every entry in `scopes` must be granted (`anyOfScopes` needs only one), and `actorKind` accepts a single kind or an array. Pass `resolveAuth` on the route spec, or supply `tenant` in the invoke options.

### 2. Standalone CLI Verb (`@sibylline-labs/hera/cli`)

```ts
import * as Schema from "effect/Schema";
import { EnvName, HeraCli, fn } from "@sibylline-labs/hera/cli";

export const pullVerb = HeraCli.verb({
  name: "eris pull",
  slug: "pull-usage",
  args: Schema.Struct({
    env: EnvName,
  }),
  handler: (args, ctx) =>
    fn("PullCli.pull")(function* () {
      const runner = yield* HeraCli.Runner;
      const res = yield* runner.run({
        cmd: "git",
        args: ["rev-parse", "--show-toplevel"],
        cwd: ctx.cwd,
      });
      ctx.stdout(JSON.stringify({ env: args.env, root: res.stdout.trim() }) + "\n");
    })(),
});
```

The handler's error channel is `ErisError` (subprocess failures surface as typed errors with structured `ERROR` / `slug:` / `fix:` / `docs:` blocks), and invoking the verb resolves to the process exit code.

---

## Documentation

Full subpath exports, optional peers, and ambient type requirements live in the **[Documentation Index](docs/README.md)**.

### Core Reference
- [Documentation Index & Subpath Reference](docs/README.md)
- [Architecture & Plane Isolation](docs/ARCHITECTURE.md)
- [Error Catalog, Error Envelope & CLI Exit Codes](docs/ERRORS.md)
- [Repository Layout & Contributor Hygiene](docs/dev/LAYOUT.md)
- [Releasing & npm Publishing](docs/dev/RELEASING.md)

### Guides
- **Core:** [Schemas & 3-State Config](docs/guides/schema-and-config.md) · [Structured Logging](docs/guides/logging.md) · [Caching](docs/guides/caching.md) · [Rate Limiting](docs/guides/rate-limiting.md) · [Feature Flags](docs/guides/flags.md) · [Object Store (R2/S3)](docs/guides/object-store.md) · [OpenAPI 3.1](docs/guides/openapi.md) · [Telemetry](docs/guides/telemetry.md)
- **Workers & Agents:** [Worker Routes, Routers, Webhooks, RPC & Queues](docs/guides/workers-and-routes.md) · [Multi-Tenant Durable Objects](docs/guides/durable-objects.md) · [Agents](docs/guides/agent.md) · [Agent Telemetry](docs/guides/agent-telemetry.md)
- **CLI & Testing:** [CLI Runtime, Process Runner, Atomic FS & HTTP](docs/guides/cli-and-http.md) · [Guided Step TUI](docs/guides/tui.md) · [Testing with `HeraTest`](docs/guides/testing.md)

---

## Versioning & Stability (0.x)

`@sibylline-labs/hera` follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) under the `0.x` convention:

- **Minor releases (`0.x.0`)** may include breaking API changes (called out in [CHANGELOG.md](CHANGELOG.md)).
- **Patch releases (`0.x.y`)** contain bug fixes and backwards-compatible additions.
- Only the latest `0.x` release receives fixes ([SECURITY.md](SECURITY.md)).

Pin an exact `0.x.y` version or a tilde range (`~0.x.y`) for explicit control over breaking changes. Releases are published to npm from `sibylline-labs/hera` via GitHub Actions trusted publishing (OIDC) with SLSA provenance ([docs/dev/RELEASING.md](docs/dev/RELEASING.md)).

---

## Verification

```bash
bun run typecheck   # tsc --noEmit, 5 consumer-shape fixtures, and every ts snippet in README/docs/skills
bun run lint        # tsc --noEmit && ast-grep scan && ast-grep test --skip-snapshot-tests
bun run test        # vitest run (unit, property, workerd, cold-start, and repo-layout hygiene suites)
```

---

## License, Contributing & Security

Released under the [MIT License](LICENSE). Changes are tracked in [CHANGELOG.md](CHANGELOG.md). Hera does not accept outside contributions; forks are welcome ([CONTRIBUTING.md](CONTRIBUTING.md)). Report security vulnerabilities privately per [SECURITY.md](SECURITY.md).
