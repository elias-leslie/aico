import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api-fetch'
import type { ATermSession } from './use-aterm-sessions'
import type { ProjectATerm } from './use-project-aterms'

interface ResetMutationContext {
  previousSessions?: ATermSession[]
  projectId: string
  oldSessionIds: string[]
}

interface ResetProjectResponse {
  project_id: string
  shell_session_id: string
  agent_session_id: string
  mode: string
  agent_mode: string | null
}

function createATermSession(
  sessionId: string,
  projectId: string,
  mode: string,
  project?: ProjectATerm,
): ATermSession {
  return {
    id: sessionId,
    name: project ? `Project: ${project.projectId} (${mode.charAt(0).toUpperCase() + mode.slice(1)})` : mode.charAt(0).toUpperCase() + mode.slice(1),
    user_id: null,
    project_id: projectId,
    working_dir: project?.rootPath ?? null,
    mode,
    display_order: 0,
    is_alive: true,
    created_at: new Date().toISOString(),
    last_accessed_at: new Date().toISOString(),
  }
}

export function useResetProjectMutation(
  projectATerms: ProjectATerm[],
  switchToSessionViaUrl: (sessionId: string) => void,
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (projectId: string) =>
      apiFetch<ResetProjectResponse>(
        `/api/aterm/projects/${projectId}/reset`,
        { method: 'POST' },
        'Failed to reset project',
      ),
    onMutate: async (projectId) => {
      await queryClient.cancelQueries({ queryKey: ['aterm-sessions'] })
      await queryClient.cancelQueries({ queryKey: ['aterm-projects'] })

      const previousSessions = queryClient.getQueryData<ATermSession[]>([
        'aterm-sessions',
      ])
      const project = projectATerms.find((p) => p.projectId === projectId)
      const oldSessionIds = project?.sessions.map((ps) => ps.session.id) ?? []

      return { previousSessions, projectId, oldSessionIds } as ResetMutationContext
    },
    onSuccess: (data, projectId, context) => {
      const project = projectATerms.find((p) => p.projectId === projectId)

      queryClient.setQueryData<ATermSession[]>(
        ['aterm-sessions'],
        (old) => {
          if (!old) return old

          const filtered = old.filter(
            (s) => !context?.oldSessionIds?.includes(s.id),
          )

          const newSessions: ATermSession[] = []
          if (data.shell_session_id) {
            newSessions.push(
              createATermSession(data.shell_session_id, projectId, 'shell', project),
            )
          }
          if (data.agent_session_id) {
            newSessions.push(
              createATermSession(data.agent_session_id, projectId, data.agent_mode ?? data.mode, project),
            )
          }

          return [...filtered, ...newSessions]
        },
      )

      if (data.shell_session_id) {
        switchToSessionViaUrl(data.shell_session_id)
      }
    },
    onError: (_err, _projectId, context) => {
      if (context?.previousSessions) {
        queryClient.setQueryData(
          ['aterm-sessions'],
          context.previousSessions,
        )
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['aterm-sessions'] })
      queryClient.invalidateQueries({ queryKey: ['aterm-projects'] })
    },
  })
}
