'use client'

import { useCallback, useRef, useState } from 'react'
import type {
  ATermSearchDirection,
  ATermSearchOptions,
  ATermSearchResult,
} from '@/components/a-term.types'
import { getATermBufferLines } from '../utils/a-term-buffer'
import {
  applyATermSearchSelection,
  buildEmptyATermSearchResult,
  buildATermSearchResult,
  findATermSearchMatches,
  getATermSearchIndex,
  type ATermSearchMatch,
} from '../utils/a-term-search'
import { isTuiSessionMode } from '../utils/session-mode'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

interface UseATermSearchOptions {
  aTermRef: React.RefObject<XtermATerm | null>
  sessionMode?: string
  activateOverlay: () => void
  getOverlayLines: () => string[]
}

interface SearchState {
  query: string
  activeIndex: number
}

interface UseATermSearchReturn {
  clearSearch: () => void
  overlaySearchMatch: ATermSearchMatch | null
  search: (
    query: string,
    options?: ATermSearchOptions,
  ) => ATermSearchResult
}

const INITIAL_SEARCH_STATE: SearchState = {
  query: '',
  activeIndex: -1,
}

export function useATermSearch({
  aTermRef,
  sessionMode,
  activateOverlay,
  getOverlayLines,
}: UseATermSearchOptions): UseATermSearchReturn {
  const [overlaySearchMatch, setOverlaySearchMatch] =
    useState<ATermSearchMatch | null>(null)
  const searchStateRef = useRef<SearchState>(INITIAL_SEARCH_STATE)
  const isTuiSession = isTuiSessionMode(sessionMode)

  const clearSearch = useCallback(() => {
    searchStateRef.current = INITIAL_SEARCH_STATE
    setOverlaySearchMatch(null)
    aTermRef.current?.clearSelection()
  }, [aTermRef])

  const search = useCallback(
    (
      rawQuery: string,
      options?: ATermSearchOptions,
    ): ATermSearchResult => {
      const query = rawQuery.trim()
      const direction: ATermSearchDirection = options?.direction ?? 'next'
      const reset =
        options?.reset ?? searchStateRef.current.query !== query

      if (!query) {
        clearSearch()
        return buildEmptyATermSearchResult()
      }

      const overlayLines = isTuiSession ? getOverlayLines() : []
      const lines = overlayLines.length > 0
        ? overlayLines
        : getATermBufferLines(aTermRef.current)
      const matches = findATermSearchMatches(lines, query)

      if (matches.length === 0) {
        searchStateRef.current = {
          query,
          activeIndex: -1,
        }
        setOverlaySearchMatch(null)
        aTermRef.current?.clearSelection()
        return buildEmptyATermSearchResult(query)
      }

      const activeIndex = getATermSearchIndex(
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
      } else if (aTermRef.current) {
        applyATermSearchSelection(aTermRef.current, match)
      }

      return buildATermSearchResult(query, matches.length, activeIndex)
    },
    [activateOverlay, clearSearch, getOverlayLines, isTuiSession, aTermRef],
  )

  return {
    clearSearch,
    overlaySearchMatch,
    search,
  }
}
