import type { SessionDescriptor } from './contracts'

// An in-memory mirror of Tether's session list. Tether is the authority; the
// mirror only feeds a client's views (titles, the tray, pickers) and is
// refreshed on every session event and gap.

export interface SessionCatalog {
  /** A token taken just before requesting a complete list. */
  mark(): number
  /** Replace the mirror with a complete list requested at `mark`; returns ids
   * that disappeared. Entries upserted locally after `mark` (a session Aico
   * just created) are kept: that list could not have seen them yet. */
  replace(list: SessionDescriptor[], mark?: number): { gone: string[] }
  upsert(descriptor: SessionDescriptor): void
  remove(id: string): void
  get(id: string): SessionDescriptor | undefined
  /** Oldest first. */
  list(): SessionDescriptor[]
}

export function createSessionCatalog(): SessionCatalog {
  const sessions = new Map<string, SessionDescriptor>()
  const touched = new Map<string, number>()
  let clock = 0
  return {
    mark() {
      return clock
    },
    replace(list, mark = clock) {
      const next = new Map(list.map((descriptor) => [descriptor.id, descriptor]))
      const kept = [...sessions.values()].filter(
        (descriptor) => !next.has(descriptor.id) && (touched.get(descriptor.id) ?? -1) >= mark,
      )
      const gone = [...sessions.keys()].filter(
        (id) => !next.has(id) && !kept.some((descriptor) => descriptor.id === id),
      )
      sessions.clear()
      for (const descriptor of [...list, ...kept]) sessions.set(descriptor.id, descriptor)
      for (const id of gone) touched.delete(id)
      clock += 1
      return { gone }
    },
    upsert(descriptor) {
      sessions.set(descriptor.id, descriptor)
      touched.set(descriptor.id, clock)
    },
    remove(id) {
      sessions.delete(id)
      touched.delete(id)
    },
    get(id) {
      return sessions.get(id)
    },
    list() {
      return [...sessions.values()].sort(
        (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
      )
    },
  }
}
