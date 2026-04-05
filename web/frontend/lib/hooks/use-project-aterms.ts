'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo } from 'react'
import { useProjectSettings } from './use-project-settings'
import {
  type ATermSession,
  useATermSessions,
} from './use-aterm-sessions'
import { useResetProjectMutation } from './use-project-aterms-mutations'

interface UseProjectATermsOptions {
  sessionsOverride?: ATermSession[]
  sessionsLoadingOverride?: boolean
  sessionsErrorOverride?: boolean
}

export interface ProjectSession {
  session: ATermSession
  badge: number
}

export interface ProjectATerm {
  projectId: string
  projectName: string
  rootPath: string | null
  activeMode: string
  sessions: ProjectSession[]
  activeSession: ATermSession | null
  activeSessionId: string | null
  sessionBadge: number | null
}

export interface UseProjectATermsResult {
  projectATerms: ProjectATerm[]
  adHocSessions: ATermSession[]
  externalSessions: ATermSession[]
  isLoading: boolean
  isError: boolean
  switchMode: (projectId: string, mode: string) => Promise<void>
  resetProject: (projectId: string) => Promise<void>
  disableProject: (projectId: string) => Promise<void>
}

function buildProjectATerm(
  project: { id: string; name: string; root_path: string | null; mode: string },
  sessions: ATermSession[],
): ProjectATerm {
  const projectSessions = sessions
    .filter((s) => s.project_id === project.id)
    .sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0
      return aTime - bTime
    })

  const sessionsWithBadges: ProjectSession[] = projectSessions.map(
    (session, index) => ({ session, badge: index + 1 }),
  )

  const activeSession = projectSessions.find((s) => s.mode === project.mode) ?? null
  const sessionBadge = sessionsWithBadges.find((ps) => ps.session.id === activeSession?.id)?.badge ?? null

  return {
    projectId: project.id,
    projectName: project.name,
    rootPath: project.root_path,
    activeMode: project.mode,
    sessions: sessionsWithBadges,
    activeSession,
    activeSessionId: activeSession?.id ?? null,
    sessionBadge,
  }
}

export function useProjectATerms(
  options: UseProjectATermsOptions = {},
): UseProjectATermsResult {
  const router = useRouter()
  const searchParams = useSearchParams()

  const {
    enabledProjects,
    switchMode: switchProjectMode,
    disableProject: disableProjectATerm,
    isLoading: projectsLoading,
    isError: projectsError,
  } = useProjectSettings()

  const sessionQuery = useATermSessions()
  const sessions = options.sessionsOverride ?? sessionQuery.sessions
  const sessionsLoading = options.sessionsLoadingOverride ?? sessionQuery.isLoading
  const sessionsError = options.sessionsErrorOverride ?? sessionQuery.isError

  const switchToSessionViaUrl = useCallback(
    (sessionId: string) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('session', sessionId)
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [searchParams, router],
  )

  const projectATerms = useMemo(
    () => enabledProjects.map((project) => buildProjectATerm(project, sessions)),
    [enabledProjects, sessions],
  )

  const externalSessions = useMemo(
    () => sessions.filter((s) => s.is_external),
    [sessions],
  )

  const adHocSessions = useMemo(
    () => sessions.filter((s) => !s.project_id && !s.is_external),
    [sessions],
  )

  const switchMode = useCallback(
    async (projectId: string, mode: string) => {
      await switchProjectMode(projectId, mode)
    },
    [switchProjectMode],
  )

  const resetProjectMutation = useResetProjectMutation(
    projectATerms,
    switchToSessionViaUrl,
  )

  const resetProject = useCallback(
    async (projectId: string) => {
      await resetProjectMutation.mutateAsync(projectId)
    },
    [resetProjectMutation],
  )

  const disableProject = useCallback(
    async (projectId: string) => {
      await disableProjectATerm(projectId)
    },
    [disableProjectATerm],
  )

  return {
    projectATerms,
    adHocSessions,
    externalSessions,
    isLoading: projectsLoading || sessionsLoading,
    isError: projectsError || sessionsError,
    switchMode,
    resetProject,
    disableProject,
  }
}
