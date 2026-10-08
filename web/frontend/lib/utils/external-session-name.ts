import type { ATermSession } from '@/lib/hooks/use-a-term-sessions'

/** Resolve generated Aico names without changing a deliberately named session. */
export function getExternalSessionDisplayName(
  session: Pick<
    ATermSession,
    | 'name'
    | 'project_id'
    | 'mode'
    | 'is_external'
    | 'tmux_source'
    | 'tmux_session_name'
  >,
  projectName?: string,
): string {
  const generatedAicoName =
    session.is_external &&
    session.tmux_source?.startsWith('aico-') &&
    session.tmux_session_name?.startsWith('aico-') &&
    session.name === session.tmux_session_name

  if (session.project_id) {
    if (session.name === session.project_id || generatedAicoName) {
      return projectName ?? session.project_id
    }
    return projectName &&
      session.name !== projectName &&
      !session.name.startsWith(`${projectName} · `) &&
      !session.name.startsWith(`${projectName} - `)
      ? `${projectName} · ${session.name}`
      : session.name
  }

  if (generatedAicoName) {
    const mode = session.mode
    return `Ad-Hoc ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`
  }

  return session.name
}
