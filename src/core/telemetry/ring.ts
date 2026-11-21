/** A bounded buffer that keeps the newest `capacity` items and counts the ones it overwrote. */
export interface Ring<T> {
  readonly push: (item: T) => void
  /** Oldest first. */
  readonly items: () => ReadonlyArray<T>
  readonly dropped: () => number
}

export function makeRing<T>(capacity: number): Ring<T> {
  const slots: Array<T> = []
  let start = 0
  let dropped = 0
  return {
    push(item) {
      if (slots.length < capacity) {
        slots.push(item)
        return
      }
      slots[start] = item
      start = (start + 1) % capacity
      dropped += 1
    },
    items: () => [...slots.slice(start), ...slots.slice(0, start)],
    dropped: () => dropped,
  }
}
