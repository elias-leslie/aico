'use client'

import { useCallback, useEffect, useState } from 'react'
import { ATERM_THEMES, type ATermThemeId } from '../constants/aterm'

// Re-export theme type and themes for convenience
export { ATERM_THEMES, type ATermThemeId }

// Popular monospace fonts for aterms
// Mix of Google Fonts (loaded) and system fonts (fallback)
export const ATERM_FONTS = [
  {
    id: 'jetbrains-mono',
    name: 'JetBrains Mono',
    family: "'JetBrains Mono', monospace",
  },
  { id: 'fira-code', name: 'Fira Code', family: "'Fira Code', monospace" },
  {
    id: 'source-code-pro',
    name: 'Source Code Pro',
    family: "'Source Code Pro', monospace",
  },
  {
    id: 'roboto-mono',
    name: 'Roboto Mono',
    family: "'Roboto Mono', monospace",
  },
  {
    id: 'ubuntu-mono',
    name: 'Ubuntu Mono',
    family: "'Ubuntu Mono', monospace",
  },
  {
    id: 'inconsolata',
    name: 'Inconsolata',
    family: "'Inconsolata', monospace",
  },
  {
    id: 'ibm-plex-mono',
    name: 'IBM Plex Mono',
    family: "'IBM Plex Mono', monospace",
  },
  { id: 'menlo', name: 'Menlo', family: 'Menlo, Monaco, monospace' },
  { id: 'consolas', name: 'Consolas', family: 'Consolas, monospace' },
  {
    id: 'cascadia',
    name: 'Cascadia Code',
    family: "'Cascadia Code', 'Cascadia Mono', monospace",
  },
] as const

export const ATERM_FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20] as const

// Scrollback buffer sizes (lines) - capped at 50K to avoid progressive slowdown
export const ATERM_SCROLLBACK_OPTIONS = [
  { value: 1000, label: '1K lines' },
  { value: 5000, label: '5K lines' },
  { value: 10000, label: '10K lines' },
  { value: 25000, label: '25K lines' },
  { value: 50000, label: '50K lines' },
] as const

// Cursor styles supported by xterm.js
export const ATERM_CURSOR_STYLES = ['block', 'underline', 'bar'] as const

export type ATermFontId = (typeof ATERM_FONTS)[number]['id']
export type ATermFontSize = (typeof ATERM_FONT_SIZES)[number]
export type ATermScrollback =
  (typeof ATERM_SCROLLBACK_OPTIONS)[number]['value']
export type ATermCursorStyle = (typeof ATERM_CURSOR_STYLES)[number]

interface ATermSettings {
  fontId: ATermFontId
  fontSize: ATermFontSize
  scrollback: ATermScrollback
  cursorStyle: ATermCursorStyle
  cursorBlink: boolean
  themeId: ATermThemeId
}

const STORAGE_KEY_GLOBAL = 'aterm-settings'
const STORAGE_KEY_PROJECT_PREFIX = 'aterm-settings-project-'

const DEFAULT_SETTINGS: ATermSettings = {
  fontId: 'jetbrains-mono',
  fontSize: 14,
  scrollback: 10000,
  cursorStyle: 'block',
  cursorBlink: true,
  themeId: 'phosphor',
}

function getStorageKey(projectId?: string): string {
  return projectId
    ? `${STORAGE_KEY_PROJECT_PREFIX}${projectId}`
    : STORAGE_KEY_GLOBAL
}

function loadSettings(projectId?: string): ATermSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS

  const storageKey = getStorageKey(projectId)

  try {
    const stored = localStorage.getItem(storageKey)
    if (stored) {
      const parsed = JSON.parse(stored)
      return parseSettings(parsed)
    }
    // If project-specific settings not found, try global defaults
    if (projectId) {
      const globalStored = localStorage.getItem(STORAGE_KEY_GLOBAL)
      if (globalStored) {
        return parseSettings(JSON.parse(globalStored))
      }
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_SETTINGS
}

function parseSettings(parsed: Record<string, unknown>): ATermSettings {
  return {
    fontId: ATERM_FONTS.some((f) => f.id === parsed.fontId)
      ? (parsed.fontId as ATermFontId)
      : DEFAULT_SETTINGS.fontId,
    fontSize: ATERM_FONT_SIZES.includes(parsed.fontSize as ATermFontSize)
      ? (parsed.fontSize as ATermFontSize)
      : DEFAULT_SETTINGS.fontSize,
    scrollback: ATERM_SCROLLBACK_OPTIONS.some(
      (o) => o.value === parsed.scrollback,
    )
      ? (parsed.scrollback as ATermScrollback)
      : DEFAULT_SETTINGS.scrollback,
    cursorStyle: ATERM_CURSOR_STYLES.includes(
      parsed.cursorStyle as ATermCursorStyle,
    )
      ? (parsed.cursorStyle as ATermCursorStyle)
      : DEFAULT_SETTINGS.cursorStyle,
    cursorBlink:
      typeof parsed.cursorBlink === 'boolean'
        ? parsed.cursorBlink
        : DEFAULT_SETTINGS.cursorBlink,
    themeId:
      parsed.themeId && (parsed.themeId as string) in ATERM_THEMES
        ? (parsed.themeId as ATermThemeId)
        : DEFAULT_SETTINGS.themeId,
  }
}

function saveSettings(settings: ATermSettings, projectId?: string): void {
  if (typeof window === 'undefined') return
  const storageKey = getStorageKey(projectId)
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings))
  } catch {
    // Ignore storage failures and keep the in-memory state.
  }
}

function sameSettings(left: ATermSettings, right: ATermSettings): boolean {
  return (
    left.fontId === right.fontId &&
    left.fontSize === right.fontSize &&
    left.scrollback === right.scrollback &&
    left.cursorStyle === right.cursorStyle &&
    left.cursorBlink === right.cursorBlink &&
    left.themeId === right.themeId
  )
}

/**
 * Hook for aterm visual settings.
 *
 * @param projectId - Optional project ID for per-project settings.
 *                    When provided, settings are stored with project scope.
 *                    When not provided, uses global settings.
 */
export function useATermSettings(projectId?: string) {
  // Use lazy initialization to load settings synchronously
  const [settings, setSettings] = useState<ATermSettings>(() =>
    loadSettings(projectId),
  )

  useEffect(() => {
    const nextSettings = loadSettings(projectId)
    setSettings((current) =>
      sameSettings(current, nextSettings) ? current : nextSettings,
    )
  }, [projectId])

  // Get the font family string for the current font
  const fontFamily =
    ATERM_FONTS.find((f) => f.id === settings.fontId)?.family ??
    ATERM_FONTS[0].family

  const setFontId = useCallback(
    (fontId: ATermFontId) => {
      setSettings((prev) => {
        const next = { ...prev, fontId }
        saveSettings(next, projectId)
        return next
      })
    },
    [projectId],
  )

  const setFontSize = useCallback(
    (fontSize: ATermFontSize) => {
      setSettings((prev) => {
        const next = { ...prev, fontSize }
        saveSettings(next, projectId)
        return next
      })
    },
    [projectId],
  )

  const setScrollback = useCallback(
    (scrollback: ATermScrollback) => {
      setSettings((prev) => {
        const next = { ...prev, scrollback }
        saveSettings(next, projectId)
        return next
      })
    },
    [projectId],
  )

  const setCursorStyle = useCallback(
    (cursorStyle: ATermCursorStyle) => {
      setSettings((prev) => {
        const next = { ...prev, cursorStyle }
        saveSettings(next, projectId)
        return next
      })
    },
    [projectId],
  )

  const setCursorBlink = useCallback(
    (cursorBlink: boolean) => {
      setSettings((prev) => {
        const next = { ...prev, cursorBlink }
        saveSettings(next, projectId)
        return next
      })
    },
    [projectId],
  )

  const setThemeId = useCallback(
    (themeId: ATermThemeId) => {
      setSettings((prev) => {
        const next = { ...prev, themeId }
        saveSettings(next, projectId)
        return next
      })
    },
    [projectId],
  )

  // Get the theme object for the current theme
  const theme = ATERM_THEMES[settings.themeId].theme

  return {
    fontId: settings.fontId,
    fontSize: settings.fontSize,
    fontFamily,
    scrollback: settings.scrollback,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    themeId: settings.themeId,
    theme,
    setFontId,
    setFontSize,
    setScrollback,
    setCursorStyle,
    setCursorBlink,
    setThemeId,
  }
}
