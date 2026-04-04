'use client'

import { useCallback, useEffect, useRef } from 'react'

export type PaneLayoutGroups = Record<string, number[]>

function sameSizes(left: number[] | undefined, right: number[]): boolean {
  if (!left || left.length !== right.length) return false
  return left.every((size, index) => Math.abs(size - right[index]) < 0.01)
}

function readPaneLayoutGroups(storageKey: string): PaneLayoutGroups {
  if (typeof window === 'undefined') return {}

  try {
    const stored = localStorage.getItem(storageKey)
    if (!stored) return {}
    const parsed = JSON.parse(stored)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as PaneLayoutGroups
  } catch {
    return {}
  }
}

export function usePaneLayoutGroups(storageKey: string) {
  const stateRef = useRef<{
    storageKey: string
    groups: PaneLayoutGroups
  }>({
    storageKey,
    groups: readPaneLayoutGroups(storageKey),
  })

  const getActiveGroups = useCallback(() => {
    if (stateRef.current.storageKey === storageKey) {
      return stateRef.current.groups
    }

    return readPaneLayoutGroups(storageKey)
  }, [storageKey])

  useEffect(() => {
    stateRef.current = {
      storageKey,
      groups: readPaneLayoutGroups(storageKey),
    }
  }, [storageKey])

  const updateGroupSizes = useCallback(
    (groupId: string, sizes: number[]) => {
      const currentGroups = getActiveGroups()

      if (sameSizes(currentGroups[groupId], sizes)) {
        return
      }

      const nextGroups = { ...currentGroups, [groupId]: sizes }
      stateRef.current = {
        storageKey,
        groups: nextGroups,
      }

      try {
        localStorage.setItem(storageKey, JSON.stringify(nextGroups))
      } catch {
        // Ignore storage failures and keep the in-memory state.
      }
    },
    [getActiveGroups, storageKey],
  )

  const getGroupSizes = useCallback(
    (groupId: string, panelCount: number, defaultSize: number) => {
      const groups = getActiveGroups()
      const stored = groups[groupId]
      if (
        stored &&
        stored.length === panelCount &&
        stored.every((v) => Number.isFinite(v))
      ) {
        return stored
      }
      return Array.from({ length: panelCount }, () => defaultSize)
    },
    [getActiveGroups],
  )

  return {
    getGroupSizes,
    updateGroupSizes,
  }
}
