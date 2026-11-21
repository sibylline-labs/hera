import { AI_GATEWAY_HOST } from "./config.js"

/**
 * The only hosts a Hera agent's model requests may reach. Widening it
 * is an edit here; a request to any other host is refused before it leaves the object.
 */
export const HERA_AGENT_EGRESS_HOSTS: ReadonlyArray<string> = [AI_GATEWAY_HOST]

/** The denied host when `url` is not an `https` URL on the allowlist, or `undefined` when allowed. */
export function deniedEgressHost(url: string | undefined): string | undefined {
  if (url === undefined) return "<none>"
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return "<unparseable>"
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return parsed.host || "<none>"
  return HERA_AGENT_EGRESS_HOSTS.includes(parsed.hostname) && parsed.port === "" ? undefined : parsed.host
}
