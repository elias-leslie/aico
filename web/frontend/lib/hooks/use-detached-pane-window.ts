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
  const detachedWindowScopeId =
    searchParams.get(DETACHED_WINDOW_SCOPE_PARAM) ?? detachedPaneId ?? null
  const detachedWindowPaneIds = useMemo(
    () =>
      parseDetachedWindowPaneIds(
        searchParams.get(DETACHED_WINDOW_PANES_PARAM),
        detachedPaneId,
      ),
    [searchParams, detachedPaneId],
  )
  const isDetachedPaneWindow =
    detachedWindowScopeId !== null || detachedWindowPaneIds.length > 0

  const setDetachedWindowPaneIds = useCallback(
    (paneIds: string[], sessionId?: string | null) => {
      const params = latestParams()
      const normalizedPaneIds = parseDetachedWindowPaneIds(paneIds.join(','))

      if (normalizedPaneIds.length > 0) {
        params.set(DETACHED_PANE_PARAM, normalizedPaneIds[0])
        params.set(DETACHED_WINDOW_PANES_PARAM, normalizedPaneIds.join(','))
      } else {
        params.delete(DETACHED_PANE_PARAM)
        params.delete(DETACHED_WINDOW_PANES_PARAM)
      }

      if (detachedWindowScopeId) {
        params.set(DETACHED_WINDOW_SCOPE_PARAM, detachedWindowScopeId)
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
      setDetachedWindowPaneIds([...detachedWindowPaneIds, paneId], sessionId)
    },
    [detachedWindowPaneIds, setDetachedWindowPaneIds],
  )

  const removeDetachedWindowPane = useCallback(
    (paneId: string, sessionId?: string | null) => {
      setDetachedWindowPaneIds(
        detachedWindowPaneIds.filter((id) => id !== paneId),
        sessionId,
      )
    },
    [detachedWindowPaneIds, setDetachedWindowPaneIds],
  )

  const replaceDetachedWindowPane = useCallback(
    (paneId: string, nextPaneId: string, sessionId?: string | null) => {
      const replaced = detachedWindowPaneIds.map((id) =>
        id === paneId ? nextPaneId : id,
      )
      setDetachedWindowPaneIds(replaced, sessionId)
    },
    [detachedWindowPaneIds, setDetachedWindowPaneIds],
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
