'use client'

import { useCallback, useEffect, useState } from 'react'

export const A_TERM_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20] as const

export type ATermFontSize = (typeof A_TERM_FONT_SIZES)[number]

const STORAGE_KEY_GLOBAL = 'a-term-settings'
const STORAGE_KEY_PROJECT_PREFIX = 'a-term-settings-project-'

const DEFAULT_FONT_SIZE: ATermFontSize = 14

function getStorageKey(projectId?: string): string {
  return projectId
    ? `${STORAGE_KEY_PROJECT_PREFIX}${projectId}`
    : STORAGE_KEY_GLOBAL
}

function parseFontSize(raw: string | null): ATermFontSize | null {
  if (!raw) return null
  const parsed = JSON.parse(raw) as { fontSize?: unknown }
  return A_TERM_FONT_SIZES.includes(parsed.fontSize as ATermFontSize)
    ? (parsed.fontSize as ATermFontSize)
    : null
}

function loadFontSize(projectId?: string): ATermFontSize {
  if (typeof window === 'undefined') return DEFAULT_FONT_SIZE
  try {
    // A project without its own size falls back to the global one.
    return (
      parseFontSize(localStorage.getItem(getStorageKey(projectId))) ??
      (projectId
        ? parseFontSize(localStorage.getItem(STORAGE_KEY_GLOBAL))
        : null) ??
      DEFAULT_FONT_SIZE
    )
  } catch {
    return DEFAULT_FONT_SIZE
  }
}

function saveFontSize(fontSize: ATermFontSize, projectId?: string): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(getStorageKey(projectId), JSON.stringify({ fontSize }))
  } catch {
    // Ignore storage failures and keep the in-memory state.
  }
}

/**
 * Terminal text size, remembered per project (falling back to the global
 * size) in this browser.
 */
export function useATermSettings(projectId?: string) {
  const [fontSize, setFontSizeState] = useState<ATermFontSize>(() =>
    loadFontSize(projectId),
  )

  useEffect(() => {
    setFontSizeState(loadFontSize(projectId))
  }, [projectId])

  const setFontSize = useCallback(
    (next: ATermFontSize) => {
      setFontSizeState(next)
      saveFontSize(next, projectId)
    },
    [projectId],
  )

  return { fontSize, setFontSize }
}
