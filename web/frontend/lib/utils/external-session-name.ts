import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'

/**
 * Label a session that has no A-Term pane: prefix the project name unless the
 * session's own name already carries it. A Tether session keeps its name as
 * is: it is the name Aico shows for the same session (the backend fills in
 * the workspace name when the session has none).
 */
export function getExternalSessionDisplayName(
  session: Pick<ATermSession, 'name' | 'project_id' | 'source'>,
  projectName?: string,
): string {
  if (session.source === 'tether') return session.name
  if (session.project_id) {
    if (session.name === session.project_id) {
      return projectName ?? session.project_id
    }
    return projectName &&
      session.name !== projectName &&
      !session.name.startsWith(`${projectName} · `) &&
      !session.name.startsWith(`${projectName} - `)
      ? `${projectName} · ${session.name}`
      : session.name
  }

  return session.name
}
