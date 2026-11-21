# Agents (`Hera.agent`, `Hera.agentTool`, `HeraAgentEgress`)

`@sibylline-labs/hera/agent` hosts a [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable) agent on a `TenantDurableObject`. The agent runs Gemini models through the Cloudflare AI Gateway, and every model request is metered. The subpath is separate from the root barrel, so Pi, pi-ai and `agents` stay out of a Worker that does not run agents.

Five pieces make up the plane:

| Piece | What it is |
|---|---|
| `Hera.agent(def)` | an abstract `TenantDurableObject` class with `submit`, `cancel`, `dispose` and `purgeStorage` doors |
| `Hera.agentTool({ name, description, input, execute })` | a tool over an Effect Schema input, decoded strictly from the model's raw arguments |
| `HeraAgentEgress` | the Gemini API route through the gateway, with a host allowlist and one meter row per request |
| `HeraAgentModels` | the closed model catalog: `gemma-4-26b-a4b-it` by default, `gemini-4-argon` at thinking `low` as the only fallback |
| `HeraAgentTest` (`@sibylline-labs/hera/testing/agent`) | a scripted model served at the egress seam, so tests never import Pi |

**Install the agent packages yourself.** `agents@0.30.1` and `@earendil-works/chord`, `pi-ai`, `pi-durable` and `pi-telemetry` at `1.4.0` are Hera's optional peer dependencies, not hard ones, so a consumer that only uses the CLI or core planes never downloads them. A consumer of `@sibylline-labs/hera/agent`, `/agent/telemetry` or `/testing/agent` adds them to its own `package.json` at exactly these versions:

```bash
bun add agents@0.30.1 @earendil-works/chord@1.4.0 @earendil-works/pi-ai@1.4.0 @earendil-works/pi-durable@1.4.0 @earendil-works/pi-telemetry@1.4.0
```

Hera's own dev install runs the same pins, and `test/hygiene/agent-pins.test.ts` moves them as one group.

## 1. A host and a tool

```ts
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { Hera, HeraAgentModels } from "@sibylline-labs/hera/agent"

interface Env {
  readonly CF_ACCOUNT_ID: string
  readonly AI_GATEWAY_ID: string
  readonly GEMINI_API_KEY: string
  readonly AI_GATEWAY_TOKEN?: string
}

export class CanonAgent extends Hera.agent<Env>({
  service: "support-agents",
  agent: "triage",
  instructions: "You audit a candidate entry against canon. Report a contradiction with the tool.",
  tools: (host) => [
    Hera.agentTool({
      name: "report_contradiction",
      description: "Record that a candidate contradicts a canon entry.",
      input: Schema.Struct({ section: Schema.String, entry: Schema.String, reason: Schema.String }),
      // Replay-safe by default: key the side effect on callId so a rerun after an eviction is a no-op.
      execute: ({ section, entry, reason }, { callId }) =>
        Effect.sync(() => {
          host.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO findings (call_id, section, entry, reason) VALUES (?, ?, ?, ?)",
            callId, section, entry, reason
          )
          return "recorded"
        }),
    }),
  ],
  model: HeraAgentModels.default,
  fallback: HeraAgentModels.fallback,
  egress: (env) => ({
    accountId: env.CF_ACCOUNT_ID,
    gateway: env.AI_GATEWAY_ID,
    apiKey: Redacted.make(env.GEMINI_API_KEY),
    gatewayToken: env.AI_GATEWAY_TOKEN === undefined ? undefined : Redacted.make(env.AI_GATEWAY_TOKEN),
  }),
}) {}
```

A caller submits through the stub. `submit` resolves once the input is durable, before the model runs. `operationId` is the idempotency key, so a resubmit answers `accepted: false`.

```ts no-check
const receipt = await env.AGENTS.getByName(orgDoName(orgId)).submit({ operationId, prompt })
await env.AGENTS.getByName(orgDoName(orgId)).cancel({ operationId })
```

### One object per run

Pass `durableObject: { runKeyed: true }` to host each run on its own object, named `org:<OrgId>:run:<runKey>` ([Durable Objects §1](durable-objects.md#one-object-per-run-runkeyed)). Pi's tables, the meter and the alarm then belong to that run alone, and `purgeStorage()` deletes one run without touching the org's others. `this.orgId` is the org from the name, so the egress metadata, telemetry `tenant` and logs stay per org; `this.runKey` is the run. `submit`, `cancel`, `wait` and the alarm path work as on a per-org agent; the workerd test proves isolation, alarm resume after a forced eviction and single-run purge.

```ts no-check
export class ResolveAgent extends Hera.agent<Env>({ ...definition, durableObject: { runKeyed: true } }) {}

const run = getTenantRunStub(env.RESOLVE_AGENTS, orgId, runKey)
const receipt = await run.submit({ operationId, prompt })
```

### What the host does

- **Lifecycle.** Pi's `Lifecycle` is installed on first use (`Lifecycle.install(this).use(harness)`), so construction writes nothing. Lifecycle owns the platform alarm. Hera's composite pass (outbox, named jobs, domain slot) runs as its one host job, `hera:composite`, through a `LifecycleAlarmDriver` (see [Durable Objects](durable-objects.md)).
- **Evictions.** Pi keeps a run's transcript, tasks and trace carrier in its own `pi_*` tables. An eviction mid-run leaves the job due, so the alarm reopens Pi and the run resumes. A `replay: "safe"` tool interrupted mid-call reruns with the same `callId`: execution is at-least-once, so a handler keyed on `callId` writes its effect once. The workerd test runs three forced evictions and checks that the run settles, that each `callId` writes one side effect, and that every task stays under one trace id.
- **Telemetry.** Pass `telemetry: (env) => ({ sink, contentExport })` and the harness opens with an [`HeraAgentTelemetry`](agent-telemetry.md) context. Spans are flushed when Pi's job dispatch settles and when an operation settles.
- **Purge.** `purgeStorage()` clears the driver's job, then disposes the harness and closes the meter (`beforePurge`), then runs `deleteAll()` and the deferred `abort()`. No `pi_*`, `cf_agents_*` or `_hera_*` table survives, and no alarm is left armed.

## 2. Tools: strict input, replay-safe by default

Pi validates tool arguments with a coercing validator: `{key:3}` against a string schema becomes `{key:"3"}`. `Hera.agentTool` therefore decodes the model's raw arguments with the Effect schema in Pi's `prepareArguments`, before coercion. A mismatch becomes an error tool result (`agent_tool_input_invalid`) for the model, and the handler never runs. `execute` decodes again with `Schema.decodeUnknownEffect` for the typed value.

- The parameters the model sees are `Schema.toJsonSchemaDocument(input)`.
- The handler's context is `{ callId, session, operationId }`. `operationId` is the id the running run was submitted under, so a tool on a host with several conversations at once attributes its work to the right run. It is `undefined` only outside a `Hera.agent` host (a hand-built Pi `Harness`, a bare `toRegistration`). A sub-conversation resolves through its owner. Two inputs steered into one running conversation share the earliest placed operation's id.
- `replay` defaults to `"safe"`. Pi's own default is `"unsafe"`, under which an interrupted call never reruns. Pass `replay: "unsafe"` for a tool whose side effect cannot be keyed on `callId`.
- A typed failure reaches the model as `tool failed: <Tag> (<code>)`, never its message.
- `HeraAgentTool` is branded, so `def.tools` accepts only `Hera.agentTool` output. The `hera-agent-tool-via-hera` lint flags a raw Pi `ToolRegistration`, `defineTool`, `defineExtension`, `createRegistry` and the like anywhere outside `src/server/agent/`.

## 3. Egress: the AI Gateway route, the allowlist and the meter

Model requests go to `https://gateway.ai.cloudflare.com/v1/<accountId>/<gateway>/google-ai-studio/v1beta`. Each request carries:

| Header | When |
|---|---|
| `x-goog-api-key` | always: the Gemini API key, a Worker secret of the consumer |
| `cf-aig-metadata` | always: `{ tenant, agent, service }`, with the tenant taken from the object's own name |
| `cf-aig-authorization: Bearer <token>` | only when `gatewayToken` is set (an Authenticated Gateway). There is no separate gateway token by default (Dan, Nov-07) |

- **Allowlist.** A request whose `baseUrl` is not `https` on `HERA_AGENT_EGRESS_HOSTS` (`gateway.ai.cloudflare.com`, no port, no credentials) is refused before it leaves, with `agent_egress_host_denied`. A refusal never falls back to another model.
- **Meter.** Each request writes one row to `_hera_agent_meter`: input, candidates, thoughts, cached and total tokens from the last `usageMetadata` chunk. The row is keyed by the gateway's `cf-aig-log-id` (the Gemini `responseId` when no gateway header is present), so a replayed response with a key already metered writes nothing. A response that reports usage with neither key is still metered, under a fresh `unkeyed-*` key. A failed request with no usage writes no row. Each row also carries the `operationId` of the run that issued the request (`undefined` for a row written before the column existed), so per-run usage and budgets stay separate when several conversations run at once. An existing table gains a nullable `operation_id` column on its next write; old rows are not backfilled. Read the rows with `host.agentMeter.rows()`.
- **Config.** A missing or malformed `accountId`, `gateway` or `apiKey` fails closed with `agent_egress_unconfigured`, which names the field and never the value.

## 4. Models and thinking levels

`HeraAgentModelId` is the closed union `"gemma-4-26b-a4b-it" | "gemini-4-argon" | "gemini-4-hydrogen"`. Dan's rev-3 ruling sets the default to Gemma, and the only fallback to Argon at thinking `low`. `gemini-4-hydrogen` is selectable by name (thinking `low` to `high`; the provider's `xhigh` is not reachable through the pinned Pi) and is neither default nor fallback. `gemini-2.5-flash` is not in the catalog and cannot be selected. The catalog's thinking level wins over the session's: Argon runs at `thinkingLevel: "LOW"` on the wire, and Gemma runs with thinking off. A primary that fails before any content is re-issued once on the fallback, and each request is metered separately. Pass `fallback: null` to run with no fallback.

## 5. Testing without Pi

```ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Hera, type HeraAgentUpstream } from "@sibylline-labs/hera/agent"
import { HeraAgentTest } from "@sibylline-labs/hera/testing/agent"

class ReportAgent extends Hera.agent({
  service: "support-agents",
  agent: "triage",
  instructions: "Report contradictions.",
  tools: () => [
    Hera.agentTool({
      name: "report_contradiction",
      description: "Record a contradiction.",
      input: Schema.Struct({ section: Schema.String, entry: Schema.String, reason: Schema.String }),
      execute: () => Effect.succeed("recorded"),
    }),
  ],
  egress: () => ({ accountId: "acct", gateway: "gw", apiKey: "test-key" }),
}) {}

export class TestReportAgent extends ReportAgent {
  protected override createEgressUpstream(): HeraAgentUpstream {
    return HeraAgentTest.script([
      HeraAgentTest.toolCall("report_contradiction", { section: "Pricing", entry: "E-7", reason: "price differs" }),
      HeraAgentTest.text("Reported."),
    ])
  }
}
```

A step is picked by the number of assistant replies already in the transcript. A script is therefore stateless, and a request re-issued after an eviction gets the same step and the same call ids (`call_<step>_<n>`). Each reply also emits a Gemini-shaped chunk with `usageMetadata` and a `cf-aig-log-id`, so the allowlist, thinking level and meter run unchanged. `HeraAgentTest.meterRows(sql)` reads the rows back.

Bundle with esbuild (as wrangler does), not `bun build`. Bun's bundler wraps pi-ai's cyclic modules in lazy initialisers whose order breaks pi-ai's telemetry. `test/workerd/agent-host.test.ts` shows the esbuild settings: `platform: "neutral"`, the `workerd` / `worker` / `browser` conditions, and Node builtins external under `nodejs_compat`.

## 6. Bundle size

Reading from `wrangler@4.113.0 deploy --dry-run` on `test/workerd/fixture/agent-worker.ts` (one `Hera.agent`, one tool, the scripted model, `nodejs_compat`): **Total Upload 2749.52 KiB, gzip 482.94 KiB** (Nov-07). That is within the Workers 3 MiB (gzip) free-plan limit, with about 2.5 MiB to spare. pi-ai's Google adapter and `@google/genai` make up most of it.

## 7. Errors

| Code | Status | Raised when |
|---|---|---|
| [`agent_tool_input_invalid`](../ERRORS.md#agent_tool_input_invalid) | 400 | the raw tool arguments fail the input schema |
| [`agent_egress_host_denied`](../ERRORS.md#agent_egress_host_denied) | 403 | a model request targets a host off the allowlist |
| [`agent_egress_unconfigured`](../ERRORS.md#agent_egress_unconfigured) | 503 | the egress config lacks a required value |
