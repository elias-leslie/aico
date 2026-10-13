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

type ProjectNames = {
  nameFor(projectId: string | null, projectRoot: string | null): string | null
}
type TitleFields = Pick<SessionDescriptor, 'name' | 'label' | 'projectId' | 'projectRoot'>

/** The workspace name and the task (`name`), with a task equal to the
 * workspace name dropped. */
function titleParts(
  descriptor: TitleFields,
  projects: ProjectNames,
): { project: string | null; task: string | null } {
  const project = projects.nameFor(descriptor.projectId, descriptor.projectRoot)
  const name = descriptor.name?.trim() || null
  const task = name && project && name.toLowerCase() === project.toLowerCase() ? null : name
  return { project, task }
}

/** A session's title, `Project — Task`: either part alone when the other is
 * missing, else Tether's default label (`Session <n>`). The window title,
 * tray and pickers all show this. */
export function sessionTitle(descriptor: TitleFields, projects: ProjectNames): string {
  const { project, task } = titleParts(descriptor, projects)
  if (project && task) return `${project} — ${task}`
  return project ?? task ?? descriptor.label
}

/** The fallback chip colour for a coordinator or lane from before Tether
 * assigned colours. */
export const COORDINATOR_FALLBACK_COLOR = '#6fa8ff'

/** The titlebar chip: `Coordinator` on a coordinator, `↳ <its coordinator>`
 * on a lane, in the coordinator's colour; null for any other session. */
export function coordinatorChip(
  descriptor: TitleFields &
    Partial<Pick<SessionDescriptor, 'coordinator' | 'coordinatorId' | 'coordinatorColor'>>,
  lookup: (id: string) => TitleFields | undefined,
  projects: ProjectNames,
): { text: string; color: string } | null {
  const color = /^#[0-9a-f]{6}$/i.test(descriptor.coordinatorColor ?? '')
    ? (descriptor.coordinatorColor as string)
    : COORDINATOR_FALLBACK_COLOR
  if (descriptor.coordinator) return { text: 'Coordinator', color }
  if (!descriptor.coordinatorId) return null
  const lead = lookup(descriptor.coordinatorId)
  const parts = lead ? titleParts(lead, projects) : null
  return { text: `↳ ${parts?.task ?? parts?.project ?? 'Coordinator'}`, color }
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
