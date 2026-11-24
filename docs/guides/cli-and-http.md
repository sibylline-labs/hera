# CLI Runtime, Process Runner, Atomic Filesystem & HTTP (`HeraCli`, `HeraHttp`)

Standalone CLI binaries (such as `eris`) import CLI host capabilities from `@sibylline-labs/hera/cli` (`src/cli/`) and share the runtime-agnostic HTTP client from `@sibylline-labs/hera/http` (`src/core/http/`).

`@sibylline-labs/hera/cli` contains zero `cloudflare:workers` imports so `bun build --compile` produces self-contained native executables. Its only hard dependency is `effect`: the agent plane's packages (`agents`, `@earendil-works/*`) are optional peers that a CLI never installs ([agent guide](agent.md) for the consumers that do).

A CLI that needs one module imports its subpath instead of the barrel: `@sibylline-labs/hera/cli/errors` (`ErisError`, `failureLines`, `scrubFreeText`), `/cli/manifest` (the pure verb declarations, help and completion), `/cli/fs` (`DirLock`, `AtomicPairWriter`, `writeFileAtomic`), `/cli/process` (`Runner`) and `/cli/runtime` (`HeraCli.verb`'s building blocks, `forEachBounded`). The barrel also re-exports the core planes, so it loads more at start-up.

`scrubFreeText` covers the same 13 credential classes as eris's outbound scan (`REDACTION_CLASSES`: `pem`, `jwt`, `sib-token`, `sibdc-code`, `aws-key`, `github-token`, `slack-token`, `google-api-key`, `sk-key`, `auth-header`, `gcp-private-key`, `conn-string`, `assignment`), in the same order, and scrubbing its output again changes nothing.

---

## 1. Typed CLI Verbs & Failure Blocks (`@sibylline-labs/hera/cli`)

`HeraCli.verb` wraps a CLI subcommand with:
- Value-stripping `HeraSchema` argument decoding (automatically mapping schema failures to `ErisError.usage` with exit code `2`).
- Ambient `HeraCliCtx` (`cwd`, `env`, `stdout`, `stderr`, `isJson`, `clock`, `logger`, `erisHome`, `docsBase`, `docsPath`) and `Runner.live`.
- Deterministic exit code mapping (`0` success, `1` operational, `2` usage, `3` precondition, `124` timeout) and a stderr failure block with automatic credential scrubbing (`scrubFreeText`): `ERROR <what>`, `slug: <slug>`, one `fix: <line>` row per non-blank line of `fix` (none when `fix` is absent or blank), and two `docs:` lines.

**Eris conventions are the defaults, on purpose.** The CLI plane grew out of [eris](https://github.com/sibylline-labs/eris), its first consumer, and keeps eris's names: the error type is `ErisError`, the home directory resolves from `erisHome`, then `ERIS_HOME`, then `~/.eris`, the lock directory is `.eris-lock`, the staging prefix is `.eris-pull.`, a failure with no `fix` prints no `fix:` line, `docsBase` defaults to eris's public docs (`DEFAULT_ERIS_DOCS_BASE`), and an error with no `docs` links `docs/ERRORS.md#<slug>` (`DEFAULT_ERROR_DOCS_PATH`). Another CLI passes its own `erisHome` and sets `fix` on every error it raises. It names its docs once with `docs: { base, path }` on `HeraCli.verb`, which covers the errors the verb builds itself; a per-run `docsBase` or `docsPath` in `HeraCliCtxInput` wins over it.

The handler's error channel is `ErisError`. Build one with `ErisError.operational`, `usage`, `precondition`, or `timeout` (each takes a slug and `{ what, fix?, docs? }`), or map an HTTP failure with `ErisError.fromHttpError`. A verb called with raw args resolves to its exit code.

```ts
import * as Schema from "effect/Schema";
import { EnvName, ErisError, HeraCli, fn } from "@sibylline-labs/hera/cli";

export const verifyVerb = HeraCli.verb({
  name: "eris verify",
  slug: "verify-usage",
  args: Schema.Struct({
    env: EnvName,
  }),
  handler: (args, ctx) =>
    fn("VerifyCli.verify")(function* () {
      if (args.env === "prod" && !ctx.env.ERIS_TOKEN) {
        return yield* ErisError.precondition("missing-eris-token", {
          what: "eris verify: missing ERIS_TOKEN for prod environment",
          fix: "eris auth login",
        });
      }
      ctx.stdout(`Verified ${args.env}\n`);
    })(),
});
```

### Authority-Guarded Verbs (`authority`)

A verb that performs a privileged act declares `authority`. Hera then asks the `HeraAuthorityVerifier` port (`@sibylline-labs/hera/authority`) before the handler runs, and the handler receives a third parameter, `HeraAuthorityCtx<V>`, typed by the declared verb.

- `verb`: the authority verb, by convention `"domain:action"`. Hera does not parse it; the verifier does.
- `credential(args, ctx)`: the caller's bearer, from a flag or an env value. It is wrapped in `Redacted` and never rendered. `undefined` or empty exits `3` with slug `authority-credential-missing`, and the verifier is not called.
- `params(args)` (optional): string params the verifier matches against the grant.
- `verifier`: a `Layer<HeraAuthorityVerifier, ErisError>`, provided only to the one `verify` call. A product package implements it over its own service; tests pass `HeraTest.authority(spec).layer`.

The verifier answers a `HeraAuthorityGrant` (`{ id, attributes? }`) or fails. A `HeraAuthorityRefusal` (build one with `refuseAuthority(slug, { what, fix? })`) exits `3` with the verifier's code as the failure-block `slug:`. A transport failure (`HeraHttpError`, `RateLimitedError`) maps through `ErisError.fromHttpError` (`1`, or `124` on timeout). On every failure path the handler never runs. Text the verifier builds (a refusal's `what` / `fix` / code, a transport URL) is printed with the exact credential replaced by `[REDACTED]` (a code that contains it becomes `authority-refused`), and the error carries no `cause`.

```ts
import type * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { type ErisError, type HeraAuthorityVerifier, HeraCli, fn } from "@sibylline-labs/hera/cli";

export const skipVerb = (verifier: Layer.Layer<HeraAuthorityVerifier, ErisError>) =>
  HeraCli.verb({
    name: "tool gate skip",
    args: Schema.Struct({ gate: Schema.String, grant: Schema.optional(Schema.String) }),
    authority: {
      verb: "gate:skip",
      credential: (args, ctx) => args.grant ?? ctx.env.TOOL_GRANT,
      params: (args) => ({ gate: args.gate }),
      verifier,
    },
    handler: (args, ctx, authority) =>
      fn("GateCli.skip")(function* () {
        // authority: HeraAuthorityCtx<"gate:skip">; authority.credential stays Redacted
        ctx.stdout(`skipped ${args.gate} (grant ${authority.grant.id})\n`);
      })(),
  });
```

A verb without `authority` keeps a two-parameter handler: a handler that asks for the ctx there does not compile, nor does a handler typed for another verb. The ctx carries a private brand, and no barrel exports its constructor, so an object literal cannot stand in for a grant.

---

### Declaring a CLI Once (`HeraCli.program`)

A binary with many verbs declares each one once. A verb's spec holds its summary, its flags (each with a summary, and optionally an alias, `repeatable`, `choices`, `maxLength` and `completeValue`), its positional operands, whether it accepts `--output json`, and a `load` thunk that resolves to its handler. Everything else derives from that spec:

- **Routing.** Leading words walk the group tree. A bare group, or `--help` / `-h` anywhere before `--`, prints help and exits `0`. A word no group holds exits `2` with slug `<group>-unknown-command`.
- **Strict argv.** `--flag value` or `--flag=value` for a value flag, `--flag` for a boolean, `-x` for an alias, and `--` ends the flags. A repeatable flag collects its values in order, `-` alone and negative numbers are operands, and a dash-led value has to be joined (`--name=-x`). An unknown flag, a missing value, a duplicate flag, a boolean given `=x`, a missing required flag or operand, and an extra operand each exit `2` with a slug derived from the path's first word (`yak-unknown-flag`, `yak-flag-missing-value`, …), or from the verb's `slugPrefix`.
- **Decoding.** The tokenized line decodes against an Effect Schema derived from the same flag data (`maxLength`, `choices`, `int` included). A failure exits `2` with `<prefix>-invalid-args`.
- **Help.** Prose `--help`, and `--help --output json` as an `eris-help/1` document whose every flag carries its declared summary. `docs` prints every path's help (`--json` prints the documents).
- **Completion.** `completion bash` and `completion zsh` emit a deterministic script (bash 3.2 clean). A value or operand completes from its literal words, `@file`, or a `HeraCliCompletionDomain` shell helper `__<prog>_dom_<name>`, which composition checks.

The declarations live in `@sibylline-labs/hera/cli/manifest`, which imports only its own siblings: no handler, no `effect`. A binary's entry calls `runPure` first and imports the runtime only when a plugin verb runs, so `--help` and `completion` stay inside the cold-start budget (a spawned `completion bash` measures about 13 ms locally):

```ts no-check
// bin/tool.ts
import { runPure } from "@sibylline-labs/hera/cli/manifest";
import { program } from "./manifest.js";

const argv = process.argv.slice(2);
const outcome = runPure(program, argv, { stdout: (t) => void process.stdout.write(t), env: process.env });
if (outcome._tag === "Done") process.exit(0);
const { runProgram } = await import("@sibylline-labs/hera/cli/runtime");
process.exit(await runProgram(program, argv));
```

In the manifest module, keep a verb's args in their own `defineArgs` value: the verb spreads it, and the handler module types against it, so neither restates the other. `load` is normally `() => import("./issue.js").then((m) => m.issueHandler)`. A plugin may extend another plugin's verb: its flags join the target's help, help-json and completion, and its hooks receive only its own decoded flags. The base handler passes the value an extension may change through a typed hook point. With nothing registered the value comes back unchanged.

```ts
import * as Effect from "effect/Effect";
import { ErisError, HeraCli, fn } from "@sibylline-labs/hera/cli";

interface Submission {
  readonly summary: string;
  readonly project?: string;
}
const submission = HeraCli.hookPoint<Submission>("yak.submission");

const issueArgs = HeraCli.args({
  flags: {
    summary: HeraCli.flag.string({ summary: "One-line title", required: true }),
    repo: HeraCli.flag.string({ summary: "A repository it concerns", repeatable: true }),
    noRedact: HeraCli.flag.boolean({ summary: "Skip the redaction scan", alias: "-n" }),
  },
});
const projectArgs = HeraCli.args({
  flags: { project: HeraCli.flag.string({ summary: "Linear project to file into", maxLength: 200 }) },
});

// Handler module: typed by issueArgs, reached only through `load`.
const issueHandler = HeraCli.handler(issueArgs, (args, ctx) =>
  fn("YakCli.issue")(function* () {
    const body = yield* HeraCli.hook(submission, { summary: args.summary });
    ctx.stdout(`${JSON.stringify(body)}\n`);
  })(),
);

// Extension module: adds `project` to the submission.
const projectHooks = HeraCli.extensionHooks(projectArgs, [
  HeraCli.on(submission, (body, args) =>
    args.project === undefined
      ? Effect.succeed(body)
      : args.project.trim().length === 0
        ? Effect.fail(ErisError.usage("yak-project-empty", { what: "--project must not be empty" }))
        : Effect.succeed({ ...body, project: args.project.trim() }),
  ),
]);

export const cli = HeraCli.program(
  HeraCli.compose({
    name: "tool",
    version: "1.0.0",
    plugins: [
      HeraCli.plugin({
        name: "yak",
        commands: {
          yak: HeraCli.group({
            summary: "File harness feedback",
            commands: {
              issue: HeraCli.verb({
                summary: "File an issue",
                ...issueArgs,
                json: true,
                load: async () => issueHandler,
              }),
            },
          }),
        },
      }),
      HeraCli.plugin({
        name: "yak-project",
        commands: {},
        extends: {
          "yak issue": HeraCli.extension({ flags: projectArgs.flags, load: async () => projectHooks }),
        },
      }),
    ],
  }),
);
// await cli.run(["yak", "issue", "--summary", "x", "--project", "Hera"]) → 0
```

`HeraCli.handler(args, { authority, run })` guards a lazy verb the way `authority` guards an eager one: the verifier runs after decoding and before the handler, which receives the grant. Composition throws `HeraCliManifestError` at build time for a duplicate path or plugin, a reserved flag (`--help`, `--output`, `--json`, `--version`), a non-camelCase flag key (a key's flag name is its kebab form: `noRedact` is `--no-redact`), a misplaced rest operand, an unsafe completion word, or an extension of a verb that does not exist. Never patch a global to change what a verb sends: `hera-no-global-fetch-mutation` refuses any assignment to `globalThis.fetch`.

## 2. Subprocess Supervision & Process Tree Termination (`HeraCli.Runner`)

`HeraCli.Runner` (`Runner`) executes child processes from a `cmd` plus an `args` array (no shell), with a child environment built by `buildChildEnv`, captured `stdout` / `stderr`, and full descendant process-tree termination on timeout or fiber interrupt (`SIGTERM` -> grace period -> `SIGKILL` via `psSnapshot` and `signalTree`). `runner.run(spec)` takes `{ cmd, args?, cwd?, env?, stdin?, timeoutMs?, killGraceMs?, streamStdout?, streamStderr? }` and returns an `Effect` of `{ exitCode, stdout, stderr, timedOut, ... }`. A timed-out command resolves with `timedOut: true` and `exitCode: 124`; it does not fail the Effect.

```ts
import { HeraCli, fn } from "@sibylline-labs/hera/cli";

export const runGitCheck = fn("Git.check")(function* () {
  const runner = yield* HeraCli.Runner;
  const res = yield* runner.run({
    cmd: "git",
    args: ["status", "--porcelain"],
    timeoutMs: 5_000,
  });
  return res.stdout.trim();
});
```

---

## 3. Atomic File Writes & Directory Locks (`writeFileAtomic`, `AtomicPairWriter`, `DirLock`)

A mid-write crash, a signal or a concurrent CLI invocation must never leave a half-written file or a readable secret:

- **`HeraCli.writeFileAtomic(file, data, opts?)`**: Replaces one file atomically. It writes a crypto-random sibling temp (`.<name>.<12 hex>.tmp`, opened `wx`), fsyncs it, gives it its final mode and renames it over the target. `mode` is `"preserve"` by default (the existing target's mode, or the umask default for a new file) or an explicit number such as `0o600`. `mkdir: true` (or `{ mode }`) creates the parent first, and `encoding` applies to string data. On any thrown step the temp is removed, the target is untouched and the original error is rethrown. The call is synchronous, so only SIGKILL can leave a temp behind.
- **`HeraCli.writePair(dir, env, secret, opts?, devVars?)` / `HeraCli.stagePair(dir, opts?)` (`AtomicPairWriter`)**: Writes `.env`, `.secret.env` and, when bytes are given, `.dev.vars` as one set: either every new file lands, or the previous set stays byte-identical (bytes, mode, mtime). Files are staged in `<dir>/.eris-pull.XXXXXX/` under their final basenames, so a stage left by SIGKILL is hidden by the bare `.env` / `.secret.env` / `.dev.vars` patterns a `.gitignore` already carries. `.env` gets the umask default and the secret files `0600`. The existing set is snapshotted into the stage's `prev/` and the renames run synchronously; a failed rename rolls the earlier ones back. The result is `{ ok: true, envPath, secretPath, devVarsPath? }` or `{ ok: false, message, critical, stage? }`; `critical` means a rollback failed and the stage was kept so the operator can recover from `prev/`. SIGINT, SIGTERM and SIGHUP remove the stage and still end the process by the signal. `stagePair` creates the stage first and returns `{ commit, discard }`, so a caller can fetch the contents after the stage exists. `opts.faults` fails a named step (tests only). `HeraCli.writePairEffect({ dir, env, secret, devVars?, options? })` (also `AtomicPairWriter.write`) is the Effect form; it fails with an `ErisError` whose slug is `pair-writer-failed`, or `pair-writer-rollback-failed` for a critical result.
- **`HeraCli.withDirLock` (`DirLock`)**: Takes `<dir>/.eris-lock`, a directory holding a `pid` file, and releases it when the wrapped Effect succeeds, fails, or is interrupted. A lock is reclaimed when its holder PID is dead (`isPidAlive`) or the lock is older than `maxAgeMs` (default 30 s). Breaking a stale lock and releasing one remove the lock only while it is still the lock observed (same directory inode, same `pid`): every removal runs under a sibling `<lock>.break` mutex and re-checks that identity before moving the directory, so a contender acting on an old observation never moves another holder's lock, and a release never removes a lock taken since. A `.break` mutex left by a process that died inside it is cleared by the next remover. Contention fails with an `ErisError` whose slug is `lock-held`.
- **`forEachBounded` deadlines**: `deadlineMs` and `defaultDeadlineMs` are milliseconds; `deadlineEnvVar` names an env var read as integer seconds, as eris's `ERIS_BATCH_TIMEOUT` is (`60` is 60 000 ms). An unset, non-integer, zero or negative value falls back to the default (60 s).

```ts
import { HeraCli } from "@sibylline-labs/hera/cli";

const targetDir = "/path/to/repo";

export const program = HeraCli.withDirLock(
  targetDir,
  HeraCli.writePairEffect({
    dir: targetDir,
    env: "SERVICE_ENV=dev\n",
    secret: "API_SECRET=super_secret\n",
  }),
);

HeraCli.writeFileAtomic(`${targetDir}/state.json`, "{}\n", { mode: 0o600, mkdir: true });
```

---

## 4. Whole-Exchange Timeout HTTP Client (`@sibylline-labs/hera/http`)

`HeraHttp` wraps `fetch` for both Workers and CLIs with:
- **Single Whole-Exchange Timeout**: `AbortController` timer spans TCP/TLS connect, response headers, streaming body read, and `HeraSchema` JSON decode (`timeoutMs`, default `10_000` ms).
- **Bounded Streaming Body Reader**: Enforces `maxBytes` (default 64 KiB) via `readTextBounded` so an oversized upstream response cannot exhaust Worker or CLI memory.
- **RFC 9110 `Retry-After` Parsing**: On `429 Too Many Requests`, parses both delta-seconds and HTTP-date `Retry-After` headers (or JSON body `retry_after`) into `RateLimitedError` without blind auto-retries.
- **Binary Bodies (`HeraHttp.requestBytes`)**: Same exchange, timeout and errors, but the body comes back as the exact `bytes` read (`readBytesBounded`), never decoded as text. Use it to hash or relay a binary payload.
- **GraphQL (`HeraHttp.graphql`) and OAuth 2.0 (`HeraOAuth2.client`)**: built on the same exchange; see the two sections below.
- **Route Replies (`HeraHttp.raw`, `HeraHttp.toProblemResponse`)**: server-side builders, not exchange calls. `raw` answers a route success as the bare JSON value; see [workers-and-routes.md](workers-and-routes.md#success-replies-envelope-or-raw). `HeraHttp.sse` answers with a Server-Sent Events stream; see [below](#server-sent-events-herahttpsse).
- **Manual Redirects (`redirect`)**: Passed to `fetch`. Under `redirect: "manual"` a 3xx resolves as a response with an empty, unread body, so a caller that pins a credential to one host can read `location`, re-check it, and follow it itself.

```ts
import * as Schema from "effect/Schema";
import { Hera, HeraHttp } from "@sibylline-labs/hera";

const StatusResponseSchema = Schema.Struct({
  status: Schema.Literals(["ok", "degraded"]),
});

export const fetchUpstreamStatus = Hera.fn("Upstream.fetchStatus")(function* (url: string) {
  const response = yield* HeraHttp.get(url, {
    timeoutMs: 3_000,
    schema: StatusResponseSchema,
  });
  return response.data;
});

// Digest a binary asset, following redirects only to the pinned host.
export const digestAsset = Hera.fn("Upstream.digestAsset")(function* (url: string) {
  const response = yield* HeraHttp.requestBytes({ url, redirect: "manual", maxBytes: 25 * 1024 * 1024 });
  if (response.status >= 300 && response.status < 400) {
    return { redirectTo: response.headers.get("location") };
  }
  return { bytes: response.byteLength };
});
```

### Bounded gzip Decode (`HeraHttp.gunzipBounded`)

`gunzipBounded(bytes, limit)` decodes gzip through `DecompressionStream` and `readBytesBounded`,
so the decoder is cancelled the moment its output would pass `limit` bytes: a 16 KiB gzip bomb
that inflates to 16 MiB costs one decoder chunk, not 16 MiB. It resolves `null` past the limit
(exactly `limit` bytes is accepted) and rejects on corrupt gzip, so `null` means only "too big".
`gunzipBase64Bounded(base64, limit)` takes standard base64 of gzip, the `gzip+base64` encoding of
an eris artifact copy. A `limit` that is not a non-negative safe integer throws `RangeError`.

```ts
import { HeraHttp } from "@sibylline-labs/hera/http";

// Decode an eris artifact copy, refusing one that inflates past its declared size.
export async function decodeCopy(content: string, bytes: number): Promise<string | null> {
  try {
    const decoded = await HeraHttp.gunzipBase64Bounded(content, bytes);
    return decoded === null || decoded.byteLength !== bytes ? null : new TextDecoder().decode(decoded);
  } catch {
    return null; // invalid base64 or corrupt gzip
  }
}
```

### Reading a Capped Request Body in a Handler (`HeraHttp.readBody`)

A route's `maxBodyBytes` refuses an oversized body at the boundary, before the handler runs, with
Hera's own `413 payload_too_large` / `400 invalid_json`. A handler that must run its own gates
first (rate limit, `Origin`, a guess gate) or answer its own wire error leaves the route's `body`
schema off and calls `HeraHttp.readBody(request, { maxBytes, format })` after those gates.

- It is the same reader the route option runs: a declared `content-length` over `maxBytes` is
  refused before a byte is read, and the stream is read only up to the cap.
- `format: "json"` parses JSON whatever the `content-type`; `"json-or-form"` also decodes an
  `application/x-www-form-urlencoded` body to a flat string record (see
  [workers-and-routes.md](workers-and-routes.md#capping-and-decoding-the-request-body-maxbodybytes-bodyformat)).
- It succeeds with a `Record<string, unknown>` and fails with a typed `HeraBodyReadError` whose
  `reason` is `too_large` or `malformed` (not JSON, empty, an array, a scalar or `null`). It writes
  no response: the caller maps the reason to its own wire.
- `maxBytes` must be a positive integer; anything else is a defect.

```ts
import * as Effect from "effect/Effect";
import { Hera, HeraError, HeraHttp } from "@sibylline-labs/hera";

export const DecisionRoute = Hera.publicRoute({
  method: "POST",
  path: "/device/decision",
  handler: ({ request }) =>
    Effect.gen(function* () {
      if (request.headers.get("origin") !== "https://dash.example") {
        return yield* Effect.fail(HeraError.forbidden());
      }
      const body = yield* HeraHttp.readBody(request, { maxBytes: 4096, format: "json-or-form" }).pipe(
        Effect.mapError(() => HeraError.badRequest("Invalid request", { code: "invalid_request" }))
      );
      return { user_code: String(body["user_code"] ?? "") };
    }),
});
```

### Server-Sent Events (`HeraHttp.sse`)

A route that streams, such as an OpenAI-compatible `stream: true` completion, returns `HeraHttp.sse(source, options?)`. This is a route reply like `HeraHttp.raw`, not an exchange call. It is an `Effect<Response>` whose body is `200 text/event-stream; charset=utf-8` with `cache-control: no-store`, and the route boundary passes it through and adds `x-request-id`. The source is an `AsyncIterable`, an Effect `Stream`, or a factory `(signal) => either`. Map and filter values before the writer: it frames each value it receives.

| Frame | Wire | When |
|---|---|---|
| data | `data: <JSON.stringify(value)>\n\n` | one per source value (`sseDataFrame`) |
| keepalive | `: <comment>\n\n` | `keepalive: { interval, comment? }`: on each tick of `interval` with no frame since the last tick (`comment` defaults to `keepalive`) |
| sentinel | `data: <sentinel>\n\n` | `sentinel: "[DONE]"`: only when the source completes |
| error | `data: {"error":{"code":"…","message":"…"}}\n\n` | the source fails or `signal` aborts after headers flushed; written instead of the sentinel, then the stream closes |

- **Error text is static.** `errors: { messages, classify }` declares a public message per code; `classify(cause)` picks the code, and the cause itself never reaches the wire. The default is one code, `stream_failed` (`Stream failed`). A failure before the handler returns is still the route's problem+json ([ERRORS.md](../ERRORS.md#2-error-envelope-wire-format)).
- **Upstream deadline.** Aborting `signal` (a deadline, a lost lease) fails the stream with `signal.reason`, so `classify` sees it.
- **Client disconnect.** Pass the route's `request.signal` as `disconnect`. On Workers a client disconnect does not cancel the response body: it aborts `request.signal`, and only when the Worker sets the `enable_request_signal` compatibility flag. Cancelling the body (other runtimes, tests) ends the stream the same way.
- **Stopping upstream work.** A cancelled or failed stream aborts the signal the source factory received; a completed one does not. Use that signal to cancel the upstream fetch. An async generator's `finally` is not a prompt cancel channel: `iterator.return()` waits for the `await` the generator is suspended in.
- **`onEnd(outcome)`** runs once, with `{ _tag: "done" }`, `{ _tag: "cancelled" }` or `{ _tag: "failed", code }`; the first outcome wins.
- **Timing** follows the fiber's `Clock`, so under `HeraTest.layer()` (`TestClock`) `advanceClock` drives keepalives with no real wait.
- A `sentinel` or `comment` holding a CR or LF throws a `TypeError` when `HeraHttp.sse` runs, since it would split a frame. A source value with no JSON form (`undefined`, a `bigint`) ends the stream with the error frame; `sseDataFrame` called directly throws a `TypeError`.
- The error frame's code is always a row of `messages`: a `classify` that throws or returns another code falls back to the first row. A throw from `onEnd` is ignored.

```ts
import * as Effect from "effect/Effect";
import { Hera, HeraHttp } from "@sibylline-labs/hera";

declare function upstreamChunks(signal: AbortSignal): AsyncIterable<Record<string, unknown>>;

export const Completions = Hera.publicRoute({
  method: "POST",
  path: "/v1/chat/completions",
  service: "gateway",
  handler: ({ request }) =>
    HeraHttp.sse((signal) => upstreamChunks(signal), {
      sentinel: "[DONE]",
      keepalive: { interval: "15 seconds", comment: "queued" },
      disconnect: request.signal,
      errors: {
        messages: { upstream_failed: "Upstream request failed", upstream_timeout: "Upstream timed out" },
        classify: (cause) =>
          cause instanceof Error && cause.name === "TimeoutError" ? "upstream_timeout" : "upstream_failed",
      },
      onEnd: (outcome) => {
        if (outcome._tag === "failed") console.warn("stream failed", outcome.code);
      },
    }).pipe(Effect.withSpan("Completions.stream")),
});
```

### GraphQL (`HeraHttp.graphql`)

`HeraHttp.graphql({ url, query, variables, operationName, schema, auth })` POSTs one operation through the same exchange (timeout, `maxBytes`, `429`, non-2xx). A 2xx is not success on its own:

- `errors` that is a non-empty list, or present and not a list, fails `HeraHttpError` with `reason: "GraphqlError"` and the bounded entries on `graphqlErrors` (`{ message, path?, code? }`, at most 20, messages cut to 500 chars), even when partial `data` came back. The error's `message` carries the count only, because an upstream message can echo a variable value.
- A body that is not a JSON object, or `data` that does not decode against `schema`, fails with `reason: "DecodeError"`.
- A non-2xx (other than `429`) stays `reason: "HttpStatusError"` with its `status` and bounded `body`. When that body is a JSON object with a non-empty `errors` list (Linear answers `RATELIMITED` with a 400 this way), the same bounded entries are on `graphqlErrors`, so branch on `graphqlErrors?.some((e) => e.code === "RATELIMITED")` instead of re-parsing `body`.
- `auth` is `{ bearer: Redacted<string> }` (sent as `Authorization: Bearer <token>`) or `{ authorization: Redacted<string> }` (sent as the raw value, for example a Linear personal API key). The value is unwrapped only when the request is built, and it replaces any `authorization` in `headers`.
- Redirects are never followed: a 3xx fails `HttpStatusError`, so the credential never reaches, and `data` never comes from, an origin other than `url`.
- `graphqlErrors[].message` is the upstream's own text. It can echo a variable value, so log it only where that value may appear.

The success value is `{ data, status, headers }`.

```ts
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Hera, HeraHttp } from "@sibylline-labs/hera";

const Viewer = Schema.Struct({ viewer: Schema.Struct({ id: Schema.String, email: Schema.String }) });

export const readViewer = Hera.fn("Linear.viewer")(function* (accessToken: Redacted.Redacted<string>) {
  const { data } = yield* HeraHttp.graphql({
    url: "https://api.linear.app/graphql",
    auth: { bearer: accessToken },
    query: "query Viewer { viewer { id email } }",
    schema: Viewer,
  });
  return data.viewer;
});
```

### Create Once Under a Client-Chosen Id (`HeraHttp.createOnce`)

A create can land and lose its reply (a timeout, a 5xx after the write), and a retry then either writes twice or trips the API's duplicate-id check. When the API takes a client-chosen id (Linear's `issueCreate` and `commentCreate` take `input.id`), `HeraHttp.createOnce({ create, find, owns?, definitive? })` makes the create safe to retry:

- `create` succeeds: `{ _tag: "Created", value }`.
- `create` fails and `definitive(error)` holds: the error, with no read-back. Unset, a rate limit is definitive (`RateLimitedError`, a `HeraHttpError` carrying a `RATELIMITED` GraphQL error, a `HeraError` with status 429).
- Otherwise `find` reads the id back. Nothing there re-raises the create's own error, so an unverified create never reads as success. An entity `owns(found)` accepts answers `{ _tag: "Found", value: found }`. One it rejects fails `HeraError` `conflict` (409): the id is held by another write. Unset, `owns` accepts any entity under the id.
- A failing `find` fails with its own error.

`Created` and `Found` let a route answer `201` for a fresh write and `200` for a replay. The id must be fixed before the first attempt (stored, or derived from the request), so every retry sends the same one.

```ts
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Hera, HeraHttp } from "@sibylline-labs/hera";

const Comment = Schema.Struct({ id: Schema.String, body: Schema.String });
const url = "https://api.linear.app/graphql";

export const postComment = Hera.fn("Linear.postComment")(function* (
  token: Redacted.Redacted<string>,
  input: { readonly id: string; readonly issueId: string; readonly body: string },
) {
  const auth = { bearer: token };
  return yield* HeraHttp.createOnce({
    create: HeraHttp.graphql({
      url,
      auth,
      query: "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id body } } }",
      variables: { input },
      schema: Schema.Struct({ commentCreate: Schema.Struct({ comment: Comment }) }),
    }).pipe(Effect.map(({ data }) => data.commentCreate.comment)),
    find: HeraHttp.graphql({
      url,
      auth,
      query: "query($id: String!) { comment(id: $id) { id body } }",
      variables: { id: input.id },
      schema: Schema.Struct({ comment: Schema.NullOr(Comment) }),
    }).pipe(Effect.map(({ data }) => data.comment)),
    owns: (found) => found.body === input.body,
  });
});
```

### Every Page of a Connection (`HeraHttp.connectionPages`)

A GraphQL connection (`nodes` + `pageInfo { hasNextPage endCursor }`) answers one page at a time. A loop that stops at the first error, or at a page cap, and returns the rows read so far presents part of the list as all of it. `HeraHttp.connectionPages({ page, maxPages })` answers every node, in page order, or fails:

- `page(after, index)` reads one page after `after` (`null` first) and runs once per page, so a lease or token taken inside it is fresh for each page. Its own error fails the whole read, unchanged, so a caller's catch by `code` still matches.
- A page with no `pageInfo.hasNextPage` fails `HeraError` `upstream_error` (502), `fields.reason: "missing_page_info"`; `hasNextPage` with a missing, null or empty `endCursor` fails `"missing_end_cursor"`. Neither can prove the connection ended.
- `maxPages` pages that still report `hasNextPage` fail `"truncated"` (`fields.maxPages`), and no page past the cap is requested. A `maxPages` that is not a positive integer fails `internal_error` (500, `"invalid_max_pages"`) before any page.

Map the failure to your own error with `code` and `fields.reason` (e.g. `truncated` to a `thread_too_long`).

```ts
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Hera, HeraHttp } from "@sibylline-labs/hera";

declare const leaseToken: Effect.Effect<Redacted.Redacted<string>, never>;

const ProjectsPage = Schema.Struct({
  projects: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
  }),
});

export const allProjects = Hera.fn("Linear.allProjects")(function* (maxPages: number) {
  return yield* HeraHttp.connectionPages({
    maxPages,
    page: (after) =>
      Effect.flatMap(leaseToken, (token) =>
        HeraHttp.graphql({
          url: "https://api.linear.app/graphql",
          auth: { bearer: token },
          query:
            "query($first: Int!, $after: String) { projects(first: $first, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } }",
          variables: { first: 50, after },
          schema: ProjectsPage,
        }),
      ).pipe(Effect.map(({ data }) => data.projects)),
  });
});
```

### OAuth 2.0 Client (`HeraOAuth2.client`)

`HeraOAuth2.client({ tokenUrl, revokeUrl, clientId, clientSecret })` returns `exchangeCode`, `refresh` and `revoke`, each over the `HeraHttp` exchange with client credentials sent as form body params (`client_secret_post`). `clientSecret` is `Redacted<string>` (resolve it with `HeraConfig.secret`), and the returned `HeraOAuth2TokenPair` holds `accessToken` and `refreshToken` as `Redacted<string>`, `expiresAt` (epoch ms) and `scopes`.

- **Failures** are `HeraOAuth2Error` with `reason`: `invalid_grant` (HTTP 400 with `error=invalid_grant`: the user must connect again), `invalid_client` (HTTP 400/401 with `error=invalid_client`: our client id or secret is wrong, which must never disconnect anyone), or `upstream` (everything else, with `upstream` naming the `HeraHttpError` reason, `"RateLimited"` with `retryAfterMs`, or `"DecodeError"` for a 2xx without both tokens and a positive `expires_in`). The error carries the status and a bare RFC 6749 code only, never the response body, a form field or a token.
- **Refresh rotates.** A refresh may return a new refresh token. Persist the returned `refreshToken` before you use `accessToken`.
- **Revoke** answers `"revoked"` on 2xx and `"already_invalid"` on 400/401 (the token no longer works, so a retry loop on it would never end). A 400/401 with `error=invalid_client` stays an `invalid_client` failure, because the endpoint rejected the client and the token may still be live. Revoke sends no client credentials unless `revokeClientAuth: true`.
- **Redirects are never followed.** A 3xx from the token or revoke endpoint fails `upstream`, so the client secret, code and tokens are only ever sent to the configured URLs.
- `oauthCode` is kept only when it is a registered RFC 6749 / RFC 7009 code; any other `error` string is dropped.

```ts
import * as Redacted from "effect/Redacted";
import { Hera, HeraOAuth2 } from "@sibylline-labs/hera";

declare const clientSecret: Redacted.Redacted<string>;
declare function persistRefreshToken(token: Redacted.Redacted<string>): void;

const linear = HeraOAuth2.client({
  tokenUrl: "https://api.linear.app/oauth/token",
  revokeUrl: "https://api.linear.app/oauth/revoke",
  clientId: "linear-client-id",
  clientSecret,
});

export const rotate = Hera.fn("Linear.rotate")(function* (refreshToken: Redacted.Redacted<string>) {
  const pair = yield* linear.refresh(refreshToken);
  persistRefreshToken(pair.refreshToken);
  return pair.accessToken;
});
```
