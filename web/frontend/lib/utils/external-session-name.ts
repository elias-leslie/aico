import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'

/**
 * Label a session that has no A-Term pane: prefix the project name unless the
 * session's own name already carries it.
 */
export function getExternalSessionDisplayName(
  session: Pick<ATermSession, 'name' | 'project_id'>,
  projectName?: string,
): string {
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
