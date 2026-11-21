/**
 * True for a WebSocket upgrade `Response`: status `101`, or a non-null `webSocket` (a workerd
 * extension of `Response`). The route boundary hands such a response to the runtime untouched,
 * because rebuilding it with `new Response(...)` drops the socket and the client then gets a 500.
 */
export function isUpgradeResponse(response: Response): boolean {
  const socket = (response as { readonly webSocket?: unknown }).webSocket
  return response.status === 101 || (socket !== undefined && socket !== null)
}
