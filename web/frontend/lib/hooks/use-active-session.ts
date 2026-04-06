'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo } from 'react'
import { useLocalStorageState } from './use-local-storage-state'
import {
  type ProjectATerm,
  useProjectATerms,
} from './use-project-a-terms'
import {
  type ATermSession,
  useATermSessions,
} from './use-a-term-sessions'

const LAST_ACTIVE_SESSION_KEY = 'aTerm:last-active-session-id'

export function parsePersistedSessionId(storedValue: string | null): string | null {
  if (storedValue === null) {
    return null
  }

  try {
    const parsed = JSON.parse(storedValue)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return storedValue
  }
}

export function deriveActiveSessionId(
  sessions: ATermSession[],
  urlSessionId: string | null,
  urlProjectId: string | null,
  persistedSessionId: string | null = null,
): string | null {
  if (sessions.length === 0) {
    return null
  }

  if (urlSessionId && sessions.some((session) => session.id === urlSessionId)) {
    return urlSessionId
  }

  if (urlProjectId) {
    const projectSession = sessions.find((session) => session.project_id === urlProjectId)
    if (projectSession) {
      return projectSession.id
    }
  }

  if (persistedSessionId && sessions.some((session) => session.id === persistedSessionId)) {
    return persistedSessionId
  }

  return sessions[0]?.id ?? null
}

export function shouldSyncSessionParam(
  activeSessionId: string | null,
  urlSessionId: string | null,
): boolean {
  return Boolean(activeSessionId && urlSessionId !== activeSessionId)
}

// ============================================================================
// Types
// ============================================================================

export interface UseActiveSessionResult {
  /** The currently active session ID (derived from URL, never stored) */
  activeSessionId: string | null

  /** The active session object (for convenience) */
  activeSession: ATermSession | null

  /** Whether we're in a valid state (have sessions and have active) */
  isValid: boolean

  /** Switch to a different session (updates URL) */
  switchToSession: (sessionId: string) => void

  /** For project tabs: get the right session for current mode */
  getProjectActiveSession: (projectId: string) => ATermSession | null

  /** All sessions for reference */
  sessions: ATermSession[]

  /** Project a-terms for reference */
  projectATerms: ProjectATerm[]

  /** Ad-hoc sessions for reference */
  adHocSessions: ATermSession[]

  /** External tmux sessions for reference */
  externalSessions: ATermSession[]

  /** Loading state */
  isLoading: boolean
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook that derives the active session from URL + project mode.
 *
 * This is the SINGLE source of truth for which session is active.
 * It replaces scattered `activeId` useState calls with URL-based derivation.
 *
 * Derivation logic:
 * 1. Check URL `searchParams` for `?session=<id>`
 * 2. If valid session ID in URL, that's the active session
 * 3. If `?project=<id>` param exists, find session with matching project_id
 * 4. If no URL param but sessions exist, use first session
 * 5. If no sessions, return null
 *
 * @example
 * ```tsx
 * const { activeSessionId, activeSession, switchToSession } = useActiveSession();
 *
 * return (
 *   <div>
 *     {sessions.map(s => (
 *       <button
 *         key={s.id}
 *         onClick={() => switchToSession(s.id)}
 *         className={s.id === activeSessionId ? "active" : ""}
 *       >
 *         {s.name}
 *       </button>
 *     ))}
 *   </div>
 * );
 * ```
 */
export function useActiveSession(): UseActiveSessionResult {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [persistedSessionId, setPersistedSessionId] =
    useLocalStorageState<string | null>(
      LAST_ACTIVE_SESSION_KEY,
      null,
    )

  // Get session data from existing hooks
  const {
    sessions: rawSessions,
    isLoading: sessionsLoading,
    isError: sessionsError,
  } = useATermSessions()
  const sessions = rawSessions
  const {
    projectATerms,
    adHocSessions,
    externalSessions,
    isLoading: projectsLoading,
  } = useProjectATerms({
    sessionsOverride: sessions,
    sessionsLoadingOverride: sessionsLoading,
    sessionsErrorOverride: sessionsError,
  })

  const isLoading = sessionsLoading || projectsLoading

  // Get session ID and project ID from URL
  const urlSessionId = searchParams.get('session')
  const urlProjectId = searchParams.get('project')
  const searchParamsString = searchParams.toString()

  // Derive active session ID from URL + available sessions
  const activeSessionId = useMemo(() => {
    return deriveActiveSessionId(
      sessions,
      urlSessionId,
      urlProjectId,
      persistedSessionId,
    )
  }, [sessions, urlSessionId, urlProjectId, persistedSessionId])

  // Get the active session object
  const activeSession = useMemo(() => {
    if (!activeSessionId) return null
    return sessions.find((s) => s.id === activeSessionId) ?? null
  }, [sessions, activeSessionId])

  // Whether we're in a valid state
  const isValid = activeSessionId !== null && activeSession !== null

  useEffect(() => {
    if (persistedSessionId !== null || typeof window === 'undefined') {
      return
    }

    const migratedSessionId = parsePersistedSessionId(
      window.localStorage.getItem(LAST_ACTIVE_SESSION_KEY),
    )
    if (migratedSessionId !== null) {
      setPersistedSessionId(migratedSessionId)
    }
  }, [persistedSessionId, setPersistedSessionId])

  useEffect(() => {
    if (!shouldSyncSessionParam(activeSessionId, urlSessionId)) {
      return
    }

    const params = new URLSearchParams(searchParamsString)
    params.set('session', activeSessionId!)
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [activeSessionId, urlSessionId, searchParamsString, router])

  useEffect(() => {
    if (!activeSessionId) {
      setPersistedSessionId(null)
      return
    }

    setPersistedSessionId(activeSessionId)
  }, [activeSessionId, setPersistedSessionId])

  // Switch to a different session by updating the URL
  const switchToSession = useCallback(
    (sessionId: string) => {
      const params = new URLSearchParams(searchParamsString)
      params.set('session', sessionId)
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [searchParamsString, router],
  )

  // Get the active session for a project based on its current mode
  const getProjectActiveSession = useCallback(
    (projectId: string): ATermSession | null => {
      const project = projectATerms.find((p) => p.projectId === projectId)
      if (!project) return null

      // Return the active session (already computed by useProjectATerms)
      return project.activeSession
    },
    [projectATerms],
  )

  return {
    activeSessionId,
    activeSession,
    isValid,
    switchToSession,
    getProjectActiveSession,
    sessions,
    projectATerms,
    adHocSessions,
    externalSessions,
    isLoading,
  }
}
