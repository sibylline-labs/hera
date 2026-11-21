import { RequestId } from "../schema/index.js"

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * A fresh `req_<ULID>` for a request that arrived with none: 48 bits of milliseconds, then 80 random
 * bits. Every boundary that has no caller-supplied id mints one, so no two requests share a
 * correlation id (a shared constant made every request in a Worker log look like one).
 */
export function mintRequestId(nowMs: number = Date.now()): RequestId {
  let time = ""
  let t = Math.max(0, Math.floor(nowMs))
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let random = ""
  for (const byte of bytes) random += CROCKFORD[byte % 32]
  return RequestId.make(`req_${time}${random}`)
}
