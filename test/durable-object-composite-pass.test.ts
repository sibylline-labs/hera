import { describe, expect, it } from "vitest"
import { answerCompositePass } from "../src/server/durable-object/outbox/composite-pass"

const T0 = 1_700_000_000_000

describe("answerCompositePass", () => {
  // admits: a write landing after the pass's last read, while syncs are still deferred, leaves no wake; an interleaving at a scheduler yield
  it("answers the earlier of the pass's arm and the time pending once the hold is released", async () => {
    let pendingAt: number | null = null
    const answer = await answerCompositePass({
      isInitialized: () => true,
      deferArms: async (run) => {
        const result = await run()
        pendingAt = T0 + 500 // written after the pass's own last read, before release
        return result
      },
      runPass: async (arm) => arm(T0 + 60_000),
      pendingAt: () => pendingAt,
      now: () => T0,
    })
    expect(answer).toBe(T0 + 500)
  })

  // admits: the recovery arm (a failing hook with nothing else pending) is dropped by the re-read; runtime control flow
  it("keeps the pass's arm when nothing is pending afterwards", async () => {
    const answer = await answerCompositePass({
      isInitialized: () => true,
      deferArms: (run) => run(),
      runPass: async (arm) => arm(T0 + 15_000),
      pendingAt: () => null,
      now: () => T0,
    })
    expect(answer).toBe(T0 + 15_000)
  })
})
