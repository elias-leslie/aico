'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useMemo } from 'react'
import {
  DETACHED_PANE_PARAM,
  DETACHED_WINDOW_PANES_PARAM,
  DETACHED_WINDOW_SCOPE_PARAM,
  parseDetachedWindowPaneIds,
} from '@/lib/utils/detached-pane-window'

interface UseDetachedPaneWindowOptions {
  fallbackDetachedPaneId?: string
}

export interface DetachedPaneWindowScope {
  isDetachedPaneWindow: boolean
  detachedWindowPaneIds: string[]
  detachedWindowScopeId: string | null
  storageScopeId: string | null
  setDetachedWindowPaneIds: (
    paneIds: string[],
    sessionId?: string | null,
  ) => void
  addDetachedWindowPane: (paneId: string, sessionId?: string | null) => void
  removeDetachedWindowPane: (paneId: string, sessionId?: string | null) => void
  replaceDetachedWindowPane: (
    paneId: string,
    nextPaneId: string,
    sessionId?: string | null,
  ) => void
}

export function useDetachedPaneWindow({
  fallbackDetachedPaneId,
}: UseDetachedPaneWindowOptions = {}): DetachedPaneWindowScope {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const latestParams = useCallback(() => {
    if (typeof window !== 'undefined') {
      return new URLSearchParams(window.location.search)
    }
    return new URLSearchParams(searchParams.toString())
  }, [searchParams])

  const detachedPaneId =
    searchParams.get(DETACHED_PANE_PARAM) ?? fallbackDetachedPaneId ?? null
  const detachedWindowPaneIds = useMemo(
    () =>
      parseDetachedWindowPaneIds(
        searchParams.get(DETACHED_WINDOW_PANES_PARAM),
        detachedPaneId,
      ),
    [searchParams, detachedPaneId],
  )
  const detachedWindowScopeId =
    searchParams.get(DETACHED_WINDOW_SCOPE_PARAM) ??
    detachedPaneId ??
    detachedWindowPaneIds[0] ??
    null
  const isDetachedPaneWindow =
    detachedWindowScopeId !== null || detachedWindowPaneIds.length > 0

  const getCurrentDetachedWindowPaneIds = useCallback(() => {
    const params = latestParams()
    return parseDetachedWindowPaneIds(
      params.get(DETACHED_WINDOW_PANES_PARAM),
      params.get(DETACHED_PANE_PARAM) ?? fallbackDetachedPaneId,
    )
  }, [fallbackDetachedPaneId, latestParams])

  const setDetachedWindowPaneIds = useCallback(
    (paneIds: string[], sessionId?: string | null) => {
      const params = latestParams()
      const normalizedPaneIds = parseDetachedWindowPaneIds(paneIds.join(','))
      const currentScopeId =
        params.get(DETACHED_WINDOW_SCOPE_PARAM) ?? detachedWindowScopeId

      if (normalizedPaneIds.length > 0) {
        params.set(DETACHED_PANE_PARAM, normalizedPaneIds[0])
        params.set(DETACHED_WINDOW_PANES_PARAM, normalizedPaneIds.join(','))
      } else {
        params.delete(DETACHED_PANE_PARAM)
        params.delete(DETACHED_WINDOW_PANES_PARAM)
      }

      if (currentScopeId) {
        params.set(DETACHED_WINDOW_SCOPE_PARAM, currentScopeId)
      } else if (normalizedPaneIds.length === 0) {
        params.delete(DETACHED_WINDOW_SCOPE_PARAM)
      }

      if (typeof sessionId === 'string' && sessionId.length > 0) {
        params.set('session', sessionId)
      } else if (sessionId === null) {
        params.delete('session')
      }

      const query = params.toString()
      router.replace(`${pathname}${query ? `?${query}` : ''}`, {
        scroll: false,
      })
    },
    [detachedWindowScopeId, latestParams, pathname, router],
  )

  const addDetachedWindowPane = useCallback(
    (paneId: string, sessionId?: string | null) => {
      setDetachedWindowPaneIds(
        [...getCurrentDetachedWindowPaneIds(), paneId],
        sessionId,
      )
    },
    [getCurrentDetachedWindowPaneIds, setDetachedWindowPaneIds],
  )

  const removeDetachedWindowPane = useCallback(
    (paneId: string, sessionId?: string | null) => {
      setDetachedWindowPaneIds(
        getCurrentDetachedWindowPaneIds().filter((id) => id !== paneId),
        sessionId,
      )
    },
    [getCurrentDetachedWindowPaneIds, setDetachedWindowPaneIds],
  )

  const replaceDetachedWindowPane = useCallback(
    (paneId: string, nextPaneId: string, sessionId?: string | null) => {
      const currentPaneIds = getCurrentDetachedWindowPaneIds()
      const replaced = currentPaneIds.includes(paneId)
        ? currentPaneIds.map((id) => (id === paneId ? nextPaneId : id))
        : [...currentPaneIds, nextPaneId]
      setDetachedWindowPaneIds(replaced, sessionId)
    },
    [getCurrentDetachedWindowPaneIds, setDetachedWindowPaneIds],
  )

  return {
    isDetachedPaneWindow,
    detachedWindowPaneIds,
    detachedWindowScopeId,
    storageScopeId: isDetachedPaneWindow ? detachedWindowScopeId : null,
    setDetachedWindowPaneIds,
    addDetachedWindowPane,
    removeDetachedWindowPane,
    replaceDetachedWindowPane,
  }
}
