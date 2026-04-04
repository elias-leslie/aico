'use client'

import { useCallback, useRef, useState } from 'react'
import type {
  TerminalSearchDirection,
  TerminalSearchOptions,
  TerminalSearchResult,
} from '@/components/terminal.types'
import { getTerminalBufferLines } from '../utils/terminal-buffer'
import {
  applyTerminalSearchSelection,
  buildEmptyTerminalSearchResult,
  buildTerminalSearchResult,
  findTerminalSearchMatches,
  getTerminalSearchIndex,
  type TerminalSearchMatch,
} from '../utils/terminal-search'
import { isTuiSessionMode } from '../utils/session-mode'

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>

interface UseTerminalSearchOptions {
  terminalRef: React.RefObject<XtermTerminal | null>
  sessionMode?: string
  activateOverlay: () => void
  getOverlayLines: () => string[]
}

interface SearchState {
  query: string
  activeIndex: number
}

interface UseTerminalSearchReturn {
  clearSearch: () => void
  overlaySearchMatch: TerminalSearchMatch | null
  search: (
    query: string,
    options?: TerminalSearchOptions,
  ) => TerminalSearchResult
}

const INITIAL_SEARCH_STATE: SearchState = {
  query: '',
  activeIndex: -1,
}

export function useTerminalSearch({
  terminalRef,
  sessionMode,
  activateOverlay,
  getOverlayLines,
}: UseTerminalSearchOptions): UseTerminalSearchReturn {
  const [overlaySearchMatch, setOverlaySearchMatch] =
    useState<TerminalSearchMatch | null>(null)
  const searchStateRef = useRef<SearchState>(INITIAL_SEARCH_STATE)
  const isTuiSession = isTuiSessionMode(sessionMode)

  const clearSearch = useCallback(() => {
    searchStateRef.current = INITIAL_SEARCH_STATE
    setOverlaySearchMatch(null)
    terminalRef.current?.clearSelection()
  }, [terminalRef])

  const search = useCallback(
    (
      rawQuery: string,
      options?: TerminalSearchOptions,
    ): TerminalSearchResult => {
      const query = rawQuery.trim()
      const direction: TerminalSearchDirection = options?.direction ?? 'next'
      const reset =
        options?.reset ?? searchStateRef.current.query !== query

      if (!query) {
        clearSearch()
        return buildEmptyTerminalSearchResult()
      }

      const overlayLines = isTuiSession ? getOverlayLines() : []
      const lines = overlayLines.length > 0
        ? overlayLines
        : getTerminalBufferLines(terminalRef.current)
      const matches = findTerminalSearchMatches(lines, query)

      if (matches.length === 0) {
        searchStateRef.current = {
          query,
          activeIndex: -1,
        }
        setOverlaySearchMatch(null)
        terminalRef.current?.clearSelection()
        return buildEmptyTerminalSearchResult(query)
      }

      const activeIndex = getTerminalSearchIndex(
        matches.length,
        searchStateRef.current.activeIndex,
        direction,
        reset,
      )
      const match = matches[activeIndex]

      searchStateRef.current = {
        query,
        activeIndex,
      }

      if (isTuiSession) {
        activateOverlay()
        setOverlaySearchMatch({ ...match })
      } else if (terminalRef.current) {
        applyTerminalSearchSelection(terminalRef.current, match)
      }

      return buildTerminalSearchResult(query, matches.length, activeIndex)
    },
    [activateOverlay, clearSearch, getOverlayLines, isTuiSession, terminalRef],
  )

  return {
    clearSearch,
    overlaySearchMatch,
    search,
  }
}
