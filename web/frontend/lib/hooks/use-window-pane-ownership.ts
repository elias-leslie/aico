'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createBrowserScopeId } from '@/lib/utils/browser-scope-id'
import type { ATermPane } from './use-a-term-panes'

const WINDOW_ID_KEY = 'a-term-window-id'
const REGISTRY_KEY = 'a-term-window-pane-owners'
const HEARTBEAT_MS = 5000
const STALE_MS = 15000

interface WindowPaneOwner {
  paneIds: string[]
  updatedAt: number
}

type WindowPaneRegistry = Record<string, WindowPaneOwner>

function normalizePaneIds(paneIds: Iterable<string>): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const paneId of paneIds) {
    if (!paneId || seen.has(paneId)) continue
    seen.add(paneId)
    normalized.push(paneId)
  }
  return normalized
}

function makeWindowId(): string {
  return createBrowserScopeId('window')
}

function getWindowId(): string | null {
  if (typeof window === 'undefined') return null
  const existing = window.sessionStorage.getItem(WINDOW_ID_KEY)
  if (existing) return existing
  const windowId = makeWindowId()
  window.sessionStorage.setItem(WINDOW_ID_KEY, windowId)
  return windowId
}

export function useBrowserWindowScopeId(enabled = true): string | null {
  const [windowId, setWindowId] = useState<string | null>(() =>
    enabled ? getWindowId() : null,
  )

  useEffect(() => {
    if (!enabled || windowId) return
    setWindowId(getWindowId())
  }, [enabled, windowId])

  return enabled ? windowId : null
}

function readRegistry(): WindowPaneRegistry {
  if (typeof window === 'undefined') return {}
  try {
    const parsed = JSON.parse(window.localStorage.getItem(REGISTRY_KEY) ?? '{}')
    return parsed && typeof parsed === 'object'
      ? (parsed as WindowPaneRegistry)
      : {}
  } catch {
    return {}
  }
}

function writeRegistry(registry: WindowPaneRegistry): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry))
}

function pruneRegistry(
  registry: WindowPaneRegistry,
  now: number,
): WindowPaneRegistry {
  return Object.fromEntries(
    Object.entries(registry).filter(
      ([, owner]) => now - owner.updatedAt <= STALE_MS,
    ),
  )
}

function getPaneWithSession(
  panes: ATermPane[],
  sessionId: string | null | undefined,
): ATermPane | null {
  if (!sessionId) return null
  return (
    panes.find((pane) =>
      pane.sessions.some((session) => session.id === sessionId),
    ) ?? null
  )
}

function getClaimedByOtherWindows(
  registry: WindowPaneRegistry,
  windowId: string,
): Set<string> {
  const claimed = new Set<string>()
  for (const [ownerWindowId, owner] of Object.entries(registry)) {
    if (ownerWindowId === windowId) continue
    for (const paneId of owner.paneIds) {
      claimed.add(paneId)
    }
  }
  return claimed
}

function resolveOwnedPaneIds(
  panes: ATermPane[],
  windowId: string | null,
  activeSessionId: string | null | undefined,
): string[] {
  const paneIds = panes.map((pane) => pane.id)
  if (!windowId || typeof window === 'undefined') return paneIds

  const now = Date.now()
  const registry = pruneRegistry(readRegistry(), now)
  const currentOwner = registry[windowId]
  const claimedElsewhere = getClaimedByOtherWindows(registry, windowId)
  const paneIdSet = new Set(paneIds)
  const otherOwnerCount = Object.keys(registry).filter(
    (ownerWindowId) => ownerWindowId !== windowId,
  ).length

  let nextPaneIds = currentOwner
    ? currentOwner.paneIds.filter((paneId) => paneIdSet.has(paneId))
    : []

  if (!currentOwner && otherOwnerCount === 0) {
    nextPaneIds = paneIds
  }

  if (nextPaneIds.length === 0 && otherOwnerCount === 0) {
    nextPaneIds = paneIds
  }

  if (currentOwner && nextPaneIds.length > 0) {
    for (const paneId of paneIds) {
      if (!claimedElsewhere.has(paneId) && !nextPaneIds.includes(paneId)) {
        nextPaneIds.push(paneId)
      }
    }
  }

  const activePane = getPaneWithSession(panes, activeSessionId)
  if (
    activePane &&
    !claimedElsewhere.has(activePane.id) &&
    !nextPaneIds.includes(activePane.id)
  ) {
    nextPaneIds.push(activePane.id)
  }

  registry[windowId] = {
    paneIds: normalizePaneIds(nextPaneIds),
    updatedAt: now,
  }
  writeRegistry(registry)
  return registry[windowId].paneIds
}

function removeWindowOwner(windowId: string | null): void {
  if (!windowId || typeof window === 'undefined') return
  const registry = readRegistry()
  if (!(windowId in registry)) return
  delete registry[windowId]
  writeRegistry(registry)
}

interface UseWindowPaneOwnershipOptions {
  activeSessionId?: string | null
  enabled?: boolean
  windowId?: string | null
}

export function useWindowPaneOwnership(
  panes: ATermPane[],
  {
    activeSessionId = null,
    enabled = true,
    windowId: providedWindowId = null,
  }: UseWindowPaneOwnershipOptions = {},
) {
  const generatedWindowId = useBrowserWindowScopeId(enabled)
  const windowId = providedWindowId ?? generatedWindowId
  const [ownedPaneIds, setOwnedPaneIds] = useState<string[]>(() =>
    enabled ? resolveOwnedPaneIds(panes, windowId, activeSessionId) : [],
  )

  const syncOwnedPaneIds = useCallback(() => {
    if (!enabled) return
    setOwnedPaneIds(resolveOwnedPaneIds(panes, windowId, activeSessionId))
  }, [activeSessionId, enabled, panes, windowId])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    syncOwnedPaneIds()
    const interval = window.setInterval(syncOwnedPaneIds, HEARTBEAT_MS)
    const handlePageHide = () => removeWindowOwner(windowId)
    window.addEventListener('storage', syncOwnedPaneIds)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('storage', syncOwnedPaneIds)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [enabled, syncOwnedPaneIds, windowId])

  const claimPane = useCallback(
    (paneId: string) => {
      if (!enabled || !windowId || typeof window === 'undefined') return
      const now = Date.now()
      const registry = pruneRegistry(readRegistry(), now)
      const currentOwner = registry[windowId]?.paneIds ?? []
      registry[windowId] = {
        paneIds: normalizePaneIds([...currentOwner, paneId]),
        updatedAt: now,
      }
      writeRegistry(registry)
      setOwnedPaneIds(registry[windowId].paneIds)
    },
    [enabled, windowId],
  )

  const ownedPaneIdSet = useMemo(() => new Set(ownedPaneIds), [ownedPaneIds])
  const visiblePanes = useMemo(
    () =>
      enabled ? panes.filter((pane) => ownedPaneIdSet.has(pane.id)) : panes,
    [enabled, ownedPaneIdSet, panes],
  )

  return {
    visiblePanes,
    claimPane,
  }
}
