'use client'

import { useCallback, useEffect, useRef } from 'react'

export type PaneLayoutGroups = Record<string, number[]>

function sameSizes(left: number[] | undefined, right: number[]): boolean {
  if (!left || left.length !== right.length) return false
  return left.every((size, index) => Math.abs(size - right[index]) < 0.01)
}

function defaultSizes(panelCount: number, defaultSize: number): number[] {
  return Array.from({ length: panelCount }, () => defaultSize)
}

function normalizeSizes(
  sizes: number[] | undefined,
  panelCount: number,
): number[] | null {
  if (
    !sizes ||
    sizes.length !== panelCount ||
    sizes.some((value) => !Number.isFinite(value) || value <= 0)
  ) {
    return null
  }

  const total = sizes.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(total) || total <= 0) return null

  if (Math.abs(total - 100) < 0.01) {
    return sizes
  }

  return sizes.map((value) => (value / total) * 100)
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
      const normalizedSizes = normalizeSizes(sizes, sizes.length) ?? sizes

      if (sameSizes(currentGroups[groupId], normalizedSizes)) {
        return
      }

      const nextGroups = { ...currentGroups, [groupId]: normalizedSizes }
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
      return normalizeSizes(stored, panelCount) ?? defaultSizes(panelCount, defaultSize)
    },
    [getActiveGroups],
  )

  return {
    getGroupSizes,
    updateGroupSizes,
  }
}
