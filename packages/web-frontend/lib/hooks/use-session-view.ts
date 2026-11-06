'use client'

import { useQueryClient } from '@tanstack/react-query'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TerminalMode } from '@/components/ModeToggle'
import type { ConnectionStatus, TerminalHandle } from '@/components/Terminal'
import { getAgentState } from '@/lib/utils/agent-state'
import {
  getSlotSessionId,
  isPaneSlot,
  type PaneSlot,
  paneToSlot,
  sessionToSlot,
  type TerminalSlot,
} from '@/lib/utils/slot'
import { commitComposeInput } from './compose-input'
import { useAgentPolling } from './use-agent-polling'
import { useAgentTools } from './use-agent-tools'
import { useLocalStorageState } from './use-local-storage-state'
import { useMediaQuery } from './use-media-query'
import { useProjectSettings } from './use-project-settings'
import { useSessionShortcuts } from './use-session-shortcuts'
import { useTerminalActionHandlers } from './use-terminal-action-handlers'
import {
  type PaneListResponse,
  type TerminalPane,
  useTerminalPanes,
} from './use-terminal-panes'
import {
  type DeleteSessionResult,
  type TerminalSession,
  useTerminalSessions,
} from './use-terminal-sessions'
import { useTerminalSettings } from './use-terminal-settings'

/**
 * The session view's state: which session is open (the URL's `session`, else
 * the one this browser had open), the switcher's list, opening a project link,
 * starting, resetting and ending sessions, and the shell/agent switch.
 *
 * One session is on screen at a time; new sessions are created detached, so no
 * layout or pane limit applies.
 */

type Slot = TerminalSlot | PaneSlot

const LAST_ACTIVE_SESSION_KEY = 'aTerm:last-active-session-id'
const NEW_SESSION_MODAL = 'terminal-manager'
/** Time a new tmux session needs before its agent can start. */
const TMUX_INIT_DELAY_MS = 300

// ---------------------------------------------------------------------------
// Decisions (pure)
// ---------------------------------------------------------------------------

/** The remembered session id: JSON from current builds, a raw string from older ones. */
export function parsePersistedSessionId(
  storedValue: string | null,
): string | null {
  if (storedValue === null) return null
  try {
    const parsed = JSON.parse(storedValue)
    return typeof parsed === 'string' ? parsed : null
  } catch {
    return storedValue
  }
}

/** The session to open: the link's, else the `project` link's, else the
 * remembered one; never one picked for the user. */
export function deriveActiveSessionId(
  sessions: TerminalSession[],
  urlSessionId: string | null,
  urlProjectId: string | null,
  persistedSessionId: string | null = null,
): string | null {
  if (sessions.length === 0) return null

  if (urlSessionId) {
    // A link names one session: open it or nothing, never another session in
    // its place (it may be someone else's, and opening it claims its size).
    return sessions.some((session) => session.id === urlSessionId)
      ? urlSessionId
      : null
  }

  // Picked without the user asking, so never a free-standing View (no web app
  // pane shows it): that is another app's or agent's session. A remembered one
  // counts as unasked too: older builds remembered such a View they had
  // picked by themselves.
  const shown = sessions.filter((session) => !session.is_external)

  if (urlProjectId) {
    const projectSession = shown.find(
      (session) => session.project_id === urlProjectId,
    )
    if (projectSession) return projectSession.id
  }

  if (
    persistedSessionId &&
    shown.some((session) => session.id === persistedSessionId)
  ) {
    return persistedSessionId
  }

  // Never "the first session": it may be the owner's or another agent's, and
  // the URL sync would open it (claiming its size).
  return null
}

/**
 * Every session the switcher lists: the user's own panes, then each session
 * no pane shows (another app's or agent's session, or one whose pane is gone).
 */
export function buildSessionSlots(
  panes: TerminalPane[],
  sessions: TerminalSession[],
  projectNames: Map<string, string>,
): Slot[] {
  const paneSessionIds = new Set(
    panes.flatMap((pane) => pane.sessions.map((session) => session.id)),
  )
  const sessionSlots = sessions
    .filter((session) => !paneSessionIds.has(session.id))
    .map((session) =>
      sessionToSlot(session, {
        as: session.project_id ? 'project' : 'adhoc',
        place: session.is_external ? 'free' : 'unloaded',
        projectName: session.project_id
          ? projectNames.get(session.project_id)
          : undefined,
        slotId: `session-${session.id}`,
      }),
    )
  return [...panes.map(paneToSlot), ...sessionSlots]
}

const createdTime = (session: TerminalSession) =>
  session.created_at ? new Date(session.created_at).getTime() : 0

/**
 * The session a project link opens: one of the user's own sessions in that
 * (enabled) project, never another app's or agent's; the project's current
 * mode first, then its shell, then its oldest. Null means start a new one.
 */
export function projectLinkSessionId(
  project: { id: string; mode: string } | undefined,
  sessions: TerminalSession[],
): string | null {
  if (!project) return null
  const own = sessions
    .filter(
      (session) => session.project_id === project.id && !session.is_external,
    )
    .sort((a, b) => createdTime(a) - createdTime(b))
  return (
    own.find((session) => session.mode === project.mode)?.id ??
    own.find((session) => session.mode === 'shell')?.id ??
    own[0]?.id ??
    null
  )
}

/** What a project link starts when the project has no session of the user's
 * own: only what the project is in (`shell` alone, or its agent), never a
 * shell plus the default agent beside it. */
export function projectLinkStartMode(
  project: { mode: string } | undefined,
): string | undefined {
  return project?.mode || undefined
}

/** A new pane's name: the project's, numbered when it already has panes. */
export function projectPaneName(
  projectId: string,
  panes: TerminalPane[],
): string {
  const existing = panes.filter((pane) => pane.project_id === projectId).length
  const name = projectId.charAt(0).toUpperCase() + projectId.slice(1)
  return existing === 0 ? name : `${name} [${existing + 1}]`
}

/** The session a just-created pane opens on: its mode's, else its shell. */
export function newPaneSessionId(pane: TerminalPane): string | undefined {
  return (
    pane.sessions.find((session) => session.mode === pane.active_mode)?.id ??
    pane.sessions.find((session) => session.mode === 'shell')?.id ??
    pane.sessions[0]?.id
  )
}

/** Choosing an agent the pane doesn't run (another tool, or the first one on
 * a shell-only pane) starts or replaces its agent session; only going back to
 * the shell, or to the agent already there, toggles the pane's mode. */
export function needsAgentSwitch(pane: TerminalPane, mode: string): boolean {
  const agent = pane.sessions.find((session) => session.mode !== 'shell')
  return mode !== 'shell' && agent?.mode !== mode
}

/** What the header says when switching shell/agent fails. */
export function modeSwitchFailure(
  toolName: string,
  error: unknown,
): { message: string } {
  const reason =
    error instanceof Error && error.message
      ? ` ${error.message.replace(/\.?$/, '.')}`
      : ''
  return { message: `Couldn’t switch to ${toolName}.${reason}` }
}

/** An agent needs starting unless it already runs or is starting. */
export function agentNeedsStart(
  state: ReturnType<typeof getAgentState>,
): boolean {
  return state !== 'running' && state !== 'starting'
}

/** After a session ends: its pane's other session (the backend names it),
 * else no session if it was the open one; never another pane, which may be
 * someone else's. */
export function afterSessionEnds(
  result: Pick<DeleteSessionResult, 'next_session_id'>,
  endedId: string,
  activeSessionId: string | null,
): { open: string } | 'clear' | 'stay' {
  if (result.next_session_id) return { open: result.next_session_id }
  return activeSessionId === endedId ? 'clear' : 'stay'
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function useSessionView({
  projectId,
  projectPath,
}: {
  projectId?: string
  projectPath?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const queryClient = useQueryClient()
  const isMobile = useMediaQuery('(max-width: 767px)')

  const {
    sessions,
    remove,
    reset,
    isLoading: sessionsLoading,
  } = useTerminalSessions({ includeDetached: true })
  const {
    projects,
    switchMode,
    isLoading: projectsLoading,
  } = useProjectSettings()
  const {
    panes: attachedPanes,
    detachedPanes,
    isLoading: panesLoading,
    loadFailed: panesFailed,
    createProjectPane,
    setActiveMode,
    isCreating: isPaneCreating,
  } = useTerminalPanes()
  const { startAgent } = useAgentPolling()
  const { switchTool, agentTools } = useAgentTools()

  const panes = useMemo(
    () => [...attachedPanes, ...detachedPanes],
    [attachedPanes, detachedPanes],
  )
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  )
  const terminalSlots = useMemo(
    () => buildSessionSlots(panes, sessions, projectNames),
    [panes, projectNames, sessions],
  )
  const isLoading = sessionsLoading || projectsLoading || panesLoading

  // --- The open session: the URL, else the remembered one -----------------
  const [persistedSessionId, setPersistedSessionId] = useLocalStorageState<
    string | null
  >(LAST_ACTIVE_SESSION_KEY, null)
  const urlSessionId = searchParams.get('session')
  const urlProjectId = searchParams.get('project')
  const searchParamsString = searchParams.toString()
  const latestParams = useCallback(
    () =>
      new URLSearchParams(
        typeof window !== 'undefined'
          ? window.location.search
          : searchParamsString,
      ),
    [searchParamsString],
  )

  const chosenSessionId = useMemo(
    () =>
      deriveActiveSessionId(
        sessions,
        urlSessionId,
        urlProjectId,
        persistedSessionId,
      ),
    [sessions, urlSessionId, urlProjectId, persistedSessionId],
  )
  // Only a session the switcher lists is shown; nothing is picked for the user.
  const activeSessionId =
    chosenSessionId &&
    terminalSlots.some((slot) => getSlotSessionId(slot) === chosenSessionId)
      ? chosenSessionId
      : null

  // Older builds stored the id as a raw string.
  useEffect(() => {
    if (persistedSessionId !== null || typeof window === 'undefined') return
    const migrated = parsePersistedSessionId(
      window.localStorage.getItem(LAST_ACTIVE_SESSION_KEY),
    )
    if (migrated !== null) setPersistedSessionId(migrated)
  }, [persistedSessionId, setPersistedSessionId])

  useEffect(() => {
    if (!chosenSessionId || urlSessionId === chosenSessionId) return
    const params = new URLSearchParams(searchParamsString)
    params.set('session', chosenSessionId)
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [chosenSessionId, urlSessionId, searchParamsString, router])

  useEffect(() => {
    setPersistedSessionId(chosenSessionId)
  }, [chosenSessionId, setPersistedSessionId])

  const switchToSession = useCallback(
    (sessionId: string) => {
      const params = latestParams()
      params.set('session', sessionId)
      router.push(`?${params.toString()}`, { scroll: false })
    },
    [latestParams, router],
  )

  const clearActiveSession = useCallback(() => {
    const params = latestParams()
    params.delete('session')
    const query = params.toString()
    router.push(query ? `?${query}` : '?', { scroll: false })
  }, [latestParams, router])

  // The History API, not router.push: it updates the URL at once (Next syncs
  // it into useSearchParams), so the New session dialog closing right after,
  // which rewrites the URL from window.location, keeps it.
  const openNewSession = useCallback(
    (sessionId: string) => {
      const params = latestParams()
      params.set('session', sessionId)
      if (typeof window !== 'undefined')
        window.history.pushState(null, '', `?${params.toString()}`)
      else router.push(`?${params.toString()}`, { scroll: false })
    },
    [latestParams, router],
  )

  // --- Starting sessions ---------------------------------------------------
  const createDetachedPane = useCallback(
    (
      paneName: string,
      targetProjectId: string,
      workingDir?: string,
      agentToolSlug?: string,
      host?: string,
    ) =>
      createProjectPane(paneName, targetProjectId, workingDir, agentToolSlug, {
        detached: true,
        host,
      }),
    [createProjectPane],
  )

  // A project link (`?project=`) opens the user's own session there, or
  // starts one. A failed pane list can't show which sessions exist: start
  // nothing.
  const startupKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!projectId) {
      startupKeyRef.current = null
      return
    }
    if (isLoading || isPaneCreating || panesFailed) return
    const startupKey = `${projectId}:${projectPath ?? ''}`
    if (startupKeyRef.current === startupKey) return
    startupKeyRef.current = startupKey

    const project = projects.find((p) => p.enabled && p.id === projectId)
    const existing = projectLinkSessionId(project, sessions)
    if (existing) {
      if (existing !== chosenSessionId) switchToSession(existing)
      return
    }
    // A failed start is not retried: each retry would start sessions again.
    createDetachedPane(
      projectPaneName(projectId, panes),
      projectId,
      projectPath ?? undefined,
      projectLinkStartMode(project),
    )
      .then((pane) => {
        const target = newPaneSessionId(pane)
        if (target) switchToSession(target)
      })
      .catch((error) => {
        // eslint-disable-next-line no-console -- action error boundary
        console.error('Failed to start a session for the project link:', error)
      })
  }, [
    chosenSessionId,
    createDetachedPane,
    isLoading,
    isPaneCreating,
    panes,
    panesFailed,
    projectId,
    projectPath,
    projects,
    sessions,
    switchToSession,
  ])

  /** New session: a refused create (a host away, a project Tether won't
   * start) reaches the caller, which says why; what follows only logs. */
  const handleNewTerminalForProject = useCallback(
    async (
      targetProjectId: string,
      mode?: string,
      rootPath?: string | null,
      host?: string,
    ): Promise<void> => {
      let workingDir = rootPath
      if (workingDir === undefined) {
        const project = projects.find(
          (p) => p.enabled && p.id === targetProjectId,
        )
        if (!project) return
        workingDir = project.root_path
      }
      // `shell` asks for a shell alone; no mode, for the project's default agent too.
      const pane = await createDetachedPane(
        projectPaneName(targetProjectId, panes),
        targetProjectId,
        workingDir ?? undefined,
        mode,
        host,
      )
      try {
        const targetMode = mode ?? pane.active_mode
        const target = pane.sessions.find((s) => s.mode === targetMode)
        if (!target) {
          // eslint-disable-next-line no-console -- action error boundary
          console.error('New pane missing session for mode:', targetMode)
          return
        }
        openNewSession(target.id)
        // A chat is running from the start: nothing to wait for or start.
        if (targetMode !== 'shell' && target.backend !== 'agent-hub') {
          await delay(TMUX_INIT_DELAY_MS)
          await startAgent(target.id)
        }
      } catch (error) {
        // eslint-disable-next-line no-console -- action error boundary
        console.error('Failed to create project pane:', error)
      }
    },
    [projects, panes, createDetachedPane, openNewSession, startAgent],
  )

  // --- The open session's terminal ----------------------------------------
  const terminalRefs = useRef<Map<string, TerminalHandle>>(new Map())
  const [terminalStatuses, setTerminalStatuses] = useState<
    Map<string, ConnectionStatus>
  >(new Map())
  const activeStatus = activeSessionId
    ? terminalStatuses.get(activeSessionId)
    : undefined
  const { fontSize, setFontSize } = useTerminalSettings(
    sessions.find((session) => session.id === activeSessionId)?.project_id ??
      undefined,
  )

  const handleStatusChange = useCallback(
    (sessionId: string, status: ConnectionStatus) =>
      setTerminalStatuses((prev) => new Map(prev).set(sessionId, status)),
    [],
  )
  // The open session's terminal, else the first mounted one, so typing is
  // never dropped while the view catches up.
  const activeHandle = useCallback(
    () =>
      (activeSessionId
        ? terminalRefs.current.get(activeSessionId)
        : undefined) ?? terminalRefs.current.values().next().value,
    [activeSessionId],
  )
  const handleKeyboardInput = useCallback(
    (data: string) => activeHandle()?.sendInput(data),
    [activeHandle],
  )
  const handleKeyboardPaste = useCallback(
    (text: string) => void activeHandle()?.pasteInput(text),
    [activeHandle],
  )
  const handleComposeInput = useCallback(
    (sessionId: string, text: string, action: 'insert' | 'send') =>
      commitComposeInput(terminalRefs.current, sessionId, text, action),
    [],
  )
  const setTerminalRef = useCallback(
    (sessionId: string, handle: TerminalHandle | null) =>
      handle
        ? terminalRefs.current.set(sessionId, handle)
        : terminalRefs.current.delete(sessionId),
    [],
  )

  // --- Switcher actions ----------------------------------------------------
  const handleSlotSwitch = useCallback(
    (slot: Slot) => {
      const sessionId = getSlotSessionId(slot)
      if (sessionId) switchToSession(sessionId)
    },
    [switchToSession],
  )

  // Resets only the visible session (shell or agent, not both).
  const handleSlotReset = useCallback(
    async (slot: Slot) => {
      const sessionId = getSlotSessionId(slot)
      if (!sessionId || !slot.can.reset) return
      const newSession = await reset(sessionId)
      // The pane lists pick up the new session id.
      await queryClient.invalidateQueries({ queryKey: ['terminal-panes'] })
      await queryClient.invalidateQueries({
        queryKey: ['terminal-detached-panes'],
      })
      switchToSession(newSession.id)
    },
    [reset, switchToSession, queryClient],
  )

  const handleSlotCloseSession = useCallback(
    async (slot: Slot, options: { keepCheckIns?: boolean } = {}) => {
      const sessionId = getSlotSessionId(slot)
      if (!sessionId) return
      const next = afterSessionEnds(
        await remove(sessionId, options),
        sessionId,
        activeSessionId,
      )
      if (next === 'clear') clearActiveSession()
      else if (next !== 'stay') switchToSession(next.open)
    },
    [activeSessionId, clearActiveSession, remove, switchToSession],
  )

  // Shell <-> agent tool on a project session.
  const sessionsRef = useRef(sessions)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])
  const [isModeSwitching, setIsModeSwitching] = useState(false)
  const [modeSwitchError, setModeSwitchError] = useState<{
    message: string
  } | null>(null)
  const clearModeSwitchError = useCallback(() => setModeSwitchError(null), [])
  const handleSlotModeSwitch = useCallback(
    async (slot: Slot, mode: TerminalMode) => {
      if (slot.type !== 'project') return
      setIsModeSwitching(true)
      setModeSwitchError(null)
      try {
        const projectSessions = sessionsRef.current.filter(
          (s) => s.project_id === slot.projectId,
        )
        // The cached lists, not this render's: a just-closed pane must not
        // be switched.
        const cached = (key: string) =>
          queryClient.getQueryData<PaneListResponse>([key])?.items
        const freshPanes = [
          ...(cached('terminal-panes') ?? panes),
          ...(cached('terminal-detached-panes') ?? []),
        ]
        const pane = isPaneSlot(slot)
          ? freshPanes.find((p) => p.id === slot.paneId)
          : freshPanes.find((p) => p.project_id === slot.projectId)

        let target: TerminalSession | undefined
        if (pane) {
          const updated = needsAgentSwitch(pane, mode)
            ? await switchTool(pane.id, mode)
            : await setActiveMode(pane.id, mode)
          target = updated.sessions.find((s) => s.mode === mode)
          if (!target) {
            console.error('Pane missing session for mode:', mode, updated)
            return
          }
          const state =
            getAgentState(target) ??
            getAgentState(projectSessions.find((s) => s.id === target?.id))
          if (mode !== 'shell' && agentNeedsStart(state))
            await startAgent(target.id)
        } else {
          // A project session with no pane here: switch the project's mode.
          await switchMode(slot.projectId, mode)
          target = projectSessions.find((s) => s.mode === mode)
          if (!target) return
          if (mode !== 'shell' && agentNeedsStart(getAgentState(target)))
            await startAgent(target.id)
        }
        switchToSession(target.id)
      } catch (error) {
        const name = agentTools.find((tool) => tool.slug === mode)?.name ?? mode
        setModeSwitchError(modeSwitchFailure(name, error))
      } finally {
        setIsModeSwitching(false)
      }
    },
    [
      agentTools,
      queryClient,
      panes,
      switchTool,
      setActiveMode,
      switchMode,
      startAgent,
      switchToSession,
    ],
  )

  // --- New session dialog, kept in the `modal` URL param --------------------
  const [showTerminalManager, setShowTerminalManager] = useState(false)
  const urlModal = searchParams.get('modal')
  useEffect(() => {
    setShowTerminalManager(urlModal === NEW_SESSION_MODAL)
  }, [urlModal])
  const setModalParam = useCallback(
    (value: string | null) => {
      const params = latestParams()
      if (value === null) params.delete('modal')
      else params.set('modal', value)
      const query = params.toString()
      router.replace(`${pathname}${query ? `?${query}` : ''}`, {
        scroll: false,
      })
    },
    [latestParams, router, pathname],
  )
  const handleOpenTerminalManager = useCallback(() => {
    setShowTerminalManager(true)
    setModalParam(NEW_SESSION_MODAL)
  }, [setModalParam])
  const handleCloseTerminalManager = useCallback(() => {
    setShowTerminalManager(false)
    setModalParam(null)
  }, [setModalParam])

  useSessionShortcuts(terminalSlots, activeSessionId, handleSlotSwitch)
  const uploads = useTerminalActionHandlers({ terminalRefs, activeSessionId })

  return {
    isLoading,
    isMobile,
    sessions,
    terminalSlots,
    activeSessionId,
    activeStatus,
    terminalStatuses,
    fontSize,
    setFontSize,
    setTerminalRef,
    handleStatusChange,
    handleKeyboardInput,
    handleKeyboardPaste,
    handleComposeInput,
    handleNewTerminalForProject,
    showTerminalManager,
    handleOpenTerminalManager,
    handleCloseTerminalManager,
    handleSlotSwitch,
    handleSlotReset,
    handleSlotCloseSession,
    handleSlotModeSwitch,
    isModeSwitching,
    modeSwitchError,
    clearModeSwitchError,
    ...uploads,
  }
}
