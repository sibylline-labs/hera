/**
 * A re-entrant hold: `held()` is true while any `during(run)` is in flight, and each hold is released
 * when its `run` settles, even on a throw. The DO spine uses one to know it is inside an alarm pass
 * (the lazy-init guard) and one to defer slot syncs while `runCompositePass` runs.
 */
export function createHold(): {
  readonly held: () => boolean
  readonly during: <A>(run: () => Promise<A>) => Promise<A>
} {
  let depth = 0
  return {
    held: () => depth > 0,
    during: async (run) => {
      depth += 1
      try {
        return await run()
      } finally {
        depth -= 1
      }
    },
  }
}
