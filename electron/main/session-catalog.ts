import type { SessionDescriptor } from './tether-client'

// Aico's in-memory mirror of Tether's session list. Tether is the authority;
// this cache only feeds titles, the tray and the open-session picker, and is
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

/** A session's title, Tether's `displayTitle` (`Project — Task`), else its
 * default label. The window title, tray and pickers all show this; Tether
 * owns the wording (tether docs/api-v1.md "Display title and badge"). */
export function sessionTitle(
  descriptor: Pick<SessionDescriptor, 'label'> & Partial<Pick<SessionDescriptor, 'displayTitle'>>,
): string {
  return descriptor.displayTitle?.trim() || descriptor.label
}

/** The titlebar chip, Tether's `badge` as it is (`Coordinator` or
 * `↳ <coordinator>` in the coordinator's colour); null for any other session
 * or a badge that is not well formed. */
export function coordinatorChip(
  descriptor: Partial<Pick<SessionDescriptor, 'badge'>>,
): { text: string; color: string } | null {
  const badge = descriptor.badge
  if (!badge || typeof badge.text !== 'string' || !badge.text.trim()) return null
  if (!/^#[0-9a-f]{6}$/i.test(badge.color ?? '')) return null
  return { text: badge.text, color: badge.color }
}

/** A tool's registry name (`Claude Code`), else its slug. */
export function toolDisplayName(
  slug: string,
  tools: readonly { slug: string; name: string }[],
): string {
  return tools.find((tool) => tool.slug === slug)?.name ?? slug
}

/** The tray's label for a session: its display label and tool, as the window
 * title shows them. Several sessions in one workspace otherwise share a label,
 * and the tray's End list could not tell them apart. */
export function traySessionLabel(label: string, tool: string): string {
  return tool && tool !== label ? `${label} · ${tool}` : label
}
