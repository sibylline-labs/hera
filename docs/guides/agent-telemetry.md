# Agent Telemetry (`HeraAgentTelemetry`, `@sibylline-labs/hera/agent/telemetry`)

`HeraAgentTelemetry` (`src/server/agent/telemetry/`) turns a Pi agent's telemetry into the OpenTelemetry GenAI spans Logfire's Agents view reads, scrubs them, and posts them as OTLP/JSON to `${baseUrl}/v1/traces`. It is built on [`HeraTelemetry`](telemetry.md)'s exporter: the same resource (`service.name`, `deployment.environment.name`, `service.version`), the same gitleaks rules, the same `postOtlp`, stack scrubber and exception fingerprint. No OpenTelemetry package is involved. It exists because `@pydantic/logfire-cf-workers`' `instrumentDO` cannot wrap a class that extends `cloudflare:workers`' `DurableObject`.

The subpath is not part of the root or `/server` barrel: importing it pulls in Pi's telemetry types, which a Worker that runs no agent should not load.

```ts
import * as Redacted from "effect/Redacted"
import { HeraAgentTelemetry } from "@sibylline-labs/hera/agent/telemetry"

declare const waitUntil: (promise: Promise<unknown>) => void // a Durable Object's ctx.waitUntil
declare const baseUrl: string // LOGFIRE_BASE_URL
declare const writeToken: string // LOGFIRE_WRITE_TOKEN
declare const contentExport: boolean // decided per org by the caller, from HeraFlags

export const telemetry = HeraAgentTelemetry.make({
  service: "support-agents",
  environment: "prod", // deployment.environment.name: required
  version: "2026-11-12.1", // service.version, e.g. env.CF_VERSION_METADATA?.id
  tenant: "org-01J...", // prefixed onto gen_ai.conversation.id, stamped as hera.tenant
  sink: { baseUrl, token: Redacted.make(writeToken) },
  waitUntil,
  contentExport, // false unless the org opted in
})

// Hand `telemetry.context` to Pi as its TelemetryContext, then at the end of each request or alarm:
export const endOfInvocation = () => waitUntil(telemetry.flush())
```

## The pipeline

Pi's spans are recorded as plain span records (W3C ids from `crypto.getRandomValues`), and each passes these steps in order:

| Step | Does |
|---|---|
| End | The span is copied with every string scrubbed: Hera's credential shapes plus `GITLEAKS_SHAPES` (`@sibylline-labs/hera/logger`), a credential-named key's string value redacted. Unless `contentExport`, content attributes and events are dropped. Nothing downstream sees the raw span |
| Flush | Keeps `invoke_agent`, `chat` and `execute_tool`; drops `pi.durable.*` and host request or alarm spans, and re-parents each kept span to its nearest kept ancestor |
| Cap | Exports up to `maxBufferedSpans` (default 256) per flush; the rest are dropped and counted |
| Encode | Core's OTLP encoder, which scrubs every metadata string again; content that was allowed out leaves whole, cut only at its credential runs |
| Post | Core's `postOtlp` to `${baseUrl}/v1/traces`, with the whole-exchange timeout |

An 8-turn run exports at most 17 spans: one `invoke_agent`, eight `chat`, eight `execute_tool`.

## Events and errors

| Pi emits | Exported as |
|---|---|
| `pi.ai.block` (one per completed text, thinking or tool-call block) | nothing; counted in the span's `droppedEventsCount` |
| `pi.ai.first_chunk` | the attribute `first_chunk_latency_ms` (milliseconds from the span's start; the first one only) |
| a failing callback, an error status, `invokeAgent({ error })` | status `ERROR`, an `exception` event and `logfire.exception.fingerprint`, built by `describeException`: `exception.message` is `[REDACTED]`, the stack's header is `Name: [REDACTED]` and its frames are scrubbed. The fingerprint hashes the type and frame names, never the message, so Logfire groups one fault as one issue |
| any other event | the event, scrubbed |

## Content

Content is `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, the legacy `gen_ai.prompt*` / `gen_ai.completion*` keys, and the GenAI message events. With `contentExport: false` (the default) none of them leave, whichever code set them. With `true` they leave scrubbed: a credential inside a message becomes `[REDACTED]`, the rest of the message stays.

With `contentExport: true` Hera records the conversation itself, in the OTel GenAI message shape (`[{ role, parts }]`, parts `text`, `reasoning`, `tool_call`, `tool_call_response`, `blob` without bytes):

| Span | Content | Recorded by |
|---|---|---|
| `chat <model>` | `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages` (thinking as `reasoning` parts) | the egress, from the request it sent and the message the model returned |
| `execute_tool <name>` | `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` | `Hera.agentTool`'s registration, after the handler settles |
| `invoke_agent <agent>` | `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` | the host's `invokeAgent` input |

Each text part is capped at 32 000 characters (`…[truncated N chars]`), so every value stays valid JSON. With `contentExport: false` nothing is recorded and no content is serialized. A recording failure is dropped, never thrown into the agent.

A run-level span joins the run's trace with the host's `runTraceCarrier(session)`, the carrier of the newest Pi task in that conversation; pass it as `invokeAgent`'s `parent`.

No exported span names a parent that is never exported. A Pi span that is always dropped (a submission, a task) is skipped as a parent when it opens: its children parent under the nearest span that may export, or start at the root of the same trace. A carrier Hera writes also records, as `hera.ep`, the nearest span sure to export (empty for none), and a child extracted from it parents there, because Pi reads carriers back in later isolates that cannot see which spans were dropped. A carrier without `hera.ep` (a caller's own span) stays the parent. So `invoke_agent`, `chat` and `execute_tool` share the run's trace with no dangling parent; `invoke_agent` is a root, emitted after the spans it summarises.

Pi emits no `invoke_agent` span, so the host emits it when a run settles:

```ts
import { HeraAgentTelemetry } from "@sibylline-labs/hera/agent/telemetry"

declare const telemetry: ReturnType<typeof HeraAgentTelemetry.make>

telemetry.invokeAgent({
  agent: "canon-contradiction",
  conversationId: 7,
  model: "gemma-4",
  provider: "google",
  usage: { inputTokens: 120, outputTokens: 30 },
  inputMessages: [{ role: "user", content: "..." }], // exported only for contentExport: true
  outputMessages: [{ role: "assistant", content: "..." }],
  systemInstructions: "You check Canon for contradictions.",
  startMs: Date.now() - 2_000,
  endMs: Date.now(),
})
```

## Lifecycle and failure

| Case | Behaviour |
|---|---|
| `make` | Writes nothing; the pipeline is built on the first span, per instance. Nothing is shared between instances |
| `invoke_agent` ends | A flush is scheduled through `waitUntil` |
| `flush()` | Exports what has ended; concurrent calls send each span once; an empty buffer sends nothing |
| A span still open at a flush | Its ended GenAI children are held to the next flush, when its own fate is known; spans dropped by earlier flushes are remembered (up to `4 × maxBufferedSpans`) so a later child re-parents past them |
| Logfire unreachable or refusing | The batch is dropped and reported to `onExport` as `unreachable` or `rejected`; nothing throws into the agent |
| `baseUrl` or `token` missing | `unconfigured`: nothing is sent, and no default host is used |
| Encoding throws | `unserializable`: the batch is dropped |
| Every GenAI span of a flush refused by a full buffer | `overflowed`: nothing is posted, and `dropped` counts them |

`onExport` receives `{ outcome, spans, dropped }`, a closed outcome and counts, never a body or error text.

## Testing

[`HeraTest.telemetry()`](testing.md#5-capturing-telemetry-heratesttelemetry) captures what this module posts without a network mock: pass its `sink`, `fetch` and `waitUntil` to `make`, then read `spans()`.
