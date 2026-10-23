'use client'

import { useCallback, useRef } from 'react'
import type {
  ATermSearchDirection,
  ATermSearchOptions,
  ATermSearchResult,
} from '@/components/a-term.types'
import { getATermBufferLines } from '../utils/a-term-buffer'
import {
  applyATermSearchSelection,
  buildATermSearchResult,
  buildEmptyATermSearchResult,
  findATermSearchMatches,
  getATermSearchIndex,
} from '../utils/a-term-search'

type XtermATerm = InstanceType<typeof import('@xterm/xterm').Terminal>

interface UseATermSearchOptions {
  aTermRef: React.RefObject<XtermATerm | null>
}

interface SearchState {
  query: string
  activeIndex: number
}

interface UseATermSearchReturn {
  clearSearch: () => void
  search: (query: string, options?: ATermSearchOptions) => ATermSearchResult
}

const INITIAL_SEARCH_STATE: SearchState = {
  query: '',
  activeIndex: -1,
}

export function useATermSearch({
  aTermRef,
}: UseATermSearchOptions): UseATermSearchReturn {
  const searchStateRef = useRef<SearchState>(INITIAL_SEARCH_STATE)

  const clearSearch = useCallback(() => {
    searchStateRef.current = INITIAL_SEARCH_STATE
    aTermRef.current?.clearSelection()
  }, [aTermRef])

  const search = useCallback(
    (rawQuery: string, options?: ATermSearchOptions): ATermSearchResult => {
      const query = rawQuery.trim()
      const direction: ATermSearchDirection = options?.direction ?? 'next'
      const reset = options?.reset ?? searchStateRef.current.query !== query

      if (!query) {
        clearSearch()
        return buildEmptyATermSearchResult()
      }

      const matches = findATermSearchMatches(
        getATermBufferLines(aTermRef.current),
        query,
      )

      if (matches.length === 0) {
        searchStateRef.current = { query, activeIndex: -1 }
        aTermRef.current?.clearSelection()
        return buildEmptyATermSearchResult(query)
      }

      const activeIndex = getATermSearchIndex(
        matches.length,
        searchStateRef.current.activeIndex,
        direction,
        reset,
      )

      searchStateRef.current = { query, activeIndex }

      if (aTermRef.current) {
        applyATermSearchSelection(aTermRef.current, matches[activeIndex])
      }

      return buildATermSearchResult(query, matches.length, activeIndex)
    },
    [clearSearch, aTermRef],
  )

  return { clearSearch, search }
}
