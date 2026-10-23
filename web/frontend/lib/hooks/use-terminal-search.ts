'use client'

import { useCallback, useRef } from 'react'
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
} from '../utils/terminal-search'

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>

interface UseTerminalSearchOptions {
  terminalRef: React.RefObject<XtermTerminal | null>
}

interface SearchState {
  query: string
  activeIndex: number
}

interface UseTerminalSearchReturn {
  clearSearch: () => void
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
}: UseTerminalSearchOptions): UseTerminalSearchReturn {
  const searchStateRef = useRef<SearchState>(INITIAL_SEARCH_STATE)

  const clearSearch = useCallback(() => {
    searchStateRef.current = INITIAL_SEARCH_STATE
    terminalRef.current?.clearSelection()
  }, [terminalRef])

  const search = useCallback(
    (
      rawQuery: string,
      options?: TerminalSearchOptions,
    ): TerminalSearchResult => {
      const query = rawQuery.trim()
      const direction: TerminalSearchDirection = options?.direction ?? 'next'
      const reset = options?.reset ?? searchStateRef.current.query !== query

      if (!query) {
        clearSearch()
        return buildEmptyTerminalSearchResult()
      }

      const matches = findTerminalSearchMatches(
        getTerminalBufferLines(terminalRef.current),
        query,
      )

      if (matches.length === 0) {
        searchStateRef.current = { query, activeIndex: -1 }
        terminalRef.current?.clearSelection()
        return buildEmptyTerminalSearchResult(query)
      }

      const activeIndex = getTerminalSearchIndex(
        matches.length,
        searchStateRef.current.activeIndex,
        direction,
        reset,
      )

      searchStateRef.current = { query, activeIndex }

      if (terminalRef.current) {
        applyTerminalSearchSelection(terminalRef.current, matches[activeIndex])
      }

      return buildTerminalSearchResult(query, matches.length, activeIndex)
    },
    [clearSearch, terminalRef],
  )

  return { clearSearch, search }
}
