// Tail consumer of the HTTP-over-RPC lane: posts each callee invocation's RPC method and outcome to
// the test's Node sink, since no caller can see the callee's outcome.
interface Env {
  readonly SINK: Fetcher
}

export default {
  async tail(events: ReadonlyArray<TraceItem>, env: Env): Promise<void> {
    for (const event of events) {
      const rpc = event.event !== null && "rpcMethod" in event.event ? String(event.event.rpcMethod) : "-"
      const url = new URL("http://sink/outcome")
      url.searchParams.set("rpc", rpc)
      url.searchParams.set("outcome", event.outcome)
      await env.SINK.fetch(url)
    }
  },
}
