import type { ProjectInfo } from './project'

export interface ATermTmuxSession {
  session: string
  label: string
  cwd: string | null
}

export interface OpenableATermSession extends ATermTmuxSession {
  project: string | null
}

function adHocMode(mode: string): string {
  const value = mode.trim() || 'shell'
  return `${value[0].toUpperCase()}${value.slice(1)}`
}

export function defaultATermLabel(session: string): string {
  return `A-Term ${session.slice('summitflow-'.length, 'summitflow-'.length + 8)}`
}

/** Older attached rows persisted the generic discovery label as their name. */
export function attachedATermLabel(
  storedName: string | null | undefined,
  session: ATermTmuxSession,
): string {
  return storedName && storedName !== defaultATermLabel(session.session)
    ? storedName
    : session.label
}

interface PaneMetadata {
  pane_type: 'project' | 'adhoc'
  project_id: string | null
  pane_name: string
  sessions: { id: string; mode: string; is_alive: boolean }[]
}

function paneMetadata(input: unknown): PaneMetadata | null {
  if (!input || typeof input !== 'object') return null
  const pane = input as Record<string, unknown>
  if (pane.pane_type !== 'project' && pane.pane_type !== 'adhoc') return null
  if (typeof pane.pane_name !== 'string' || !Array.isArray(pane.sessions)) return null
  if (pane.project_id !== null && typeof pane.project_id !== 'string') return null
  const sessions = pane.sessions.filter((session): session is PaneMetadata['sessions'][number] => {
    if (!session || typeof session !== 'object') return false
    const row = session as Record<string, unknown>
    return (
      typeof row.id === 'string' &&
      typeof row.mode === 'string' &&
      typeof row.is_alive === 'boolean'
    )
  })
  return {
    pane_type: pane.pane_type,
    project_id: pane.project_id,
    pane_name: pane.pane_name.trim(),
    sessions,
  }
}

async function readPanes(
  url: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<PaneMetadata[]> {
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return []
    const payload: unknown = await response.json()
    if (!payload || typeof payload !== 'object') return []
    const items = (payload as Record<string, unknown>).items
    return Array.isArray(items) ? items.map(paneMetadata).filter((pane) => pane !== null) : []
  } catch {
    return []
  }
}

/** Adds optional A-Term display metadata to sessions already verified by tmux. */
export async function enrichATermSessions<T extends ATermTmuxSession>(
  sessions: T[],
  projects: ProjectInfo[],
  options: { port: number; timeoutMs: number; fetchFn?: typeof fetch },
): Promise<(T & OpenableATermSession)[]> {
  const fallbackProject = (cwd: string | null) =>
    projects.find((project) => project.root === cwd)?.name ?? cwd
  const fallback = () =>
    sessions.map((session) => ({ ...session, project: fallbackProject(session.cwd) }))
  if (
    !sessions.length ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    return fallback()

  const base = `http://127.0.0.1:${options.port}/api/a-term/panes`
  const [active, detached] = await Promise.all([
    readPanes(base, options.timeoutMs, options.fetchFn ?? fetch),
    readPanes(`${base}/detached`, options.timeoutMs, options.fetchFn ?? fetch),
  ])
  const liveSessions = new Set(sessions.map((session) => session.session))
  const metadata = new Map<string, { label: string; project: string | null }>()
  for (const pane of [...active, ...detached]) {
    const projectName = projects.find((project) => project.id === pane.project_id)?.name
    for (const paneSession of pane.sessions) {
      if (!paneSession.is_alive) continue
      const exactSession = `summitflow-${paneSession.id}`
      if (!liveSessions.has(exactSession)) continue
      const tmuxSession = sessions.find((session) => session.session === exactSession)
      if (!tmuxSession) continue
      const project =
        pane.pane_type === 'adhoc'
          ? `Ad-Hoc ${adHocMode(paneSession.mode)}`
          : projectName || pane.pane_name || tmuxSession.cwd
      metadata.set(exactSession, {
        label: pane.pane_name || projectName || tmuxSession.label,
        project,
      })
    }
  }
  return sessions.map((session) => ({
    ...session,
    ...metadata.get(session.session),
    project: metadata.get(session.session)?.project ?? fallbackProject(session.cwd),
  }))
}

/** The same custom/project fallback used by the title and tray. */
export function openableWidgetLabel(
  row: { name: string | null; projectId: string | null; seq: number },
  projects: ProjectInfo[],
): string {
  return (
    row.name ||
    projects.find((project) => project.id === row.projectId)?.name ||
    `Session ${row.seq}`
  )
}

export function openableWidgetProject(
  row: { projectId: string | null; tool: string },
  projects: ProjectInfo[],
): string {
  return row.projectId
    ? projects.find((project) => project.id === row.projectId)?.name || row.projectId
    : `Ad-Hoc ${adHocMode(row.tool)}`
}
