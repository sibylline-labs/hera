import { Redacted } from "effect"
import * as Effect from "effect/Effect"
import { createHeraLogger, HeraFlags, type LogEntry } from "../../../src/index.js"

interface Env {
  readonly LOGFIRE_READ_TOKEN: string
}

// Reads one flag for `?org=` through HeraFlags.ofrep on workerd, and answers the value with the
// warn lines the read wrote. The reader is built per request: no module state.
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const org = new URL(request.url).searchParams.get("org") ?? ""
    const lines: LogEntry[] = []
    const logger = createHeraLogger({ service: "workerd-flags", sink: (_line, entry) => lines.push(entry) })
    const flags = HeraFlags.ofrep({
      token: Redacted.make(env.LOGFIRE_READ_TOKEN),
      base: "https://logfire.test",
      timeoutMs: 250,
    })
    const value = await Effect.runPromise(
      flags.bool("hera_ofrep_probe", { targetingKey: org }, false).pipe(Effect.provide(logger.layer))
    )
    return Response.json({ value, warns: lines.filter((l) => l.level === "warn") })
  },
} satisfies ExportedHandler<Env>
