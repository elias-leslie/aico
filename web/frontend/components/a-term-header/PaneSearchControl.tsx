'use client'

import { clsx } from 'clsx'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type {
  ATermSearchOptions,
  ATermSearchResult,
} from '@/components/a-term.types'
import { HeaderIconButton } from './HeaderIconButton'

interface PaneSearchControlProps {
  onSearch: (query: string, options?: ATermSearchOptions) => ATermSearchResult
  onClearSearch: () => void
  isMobile?: boolean
}

const EMPTY_RESULT: ATermSearchResult = {
  query: '',
  totalMatches: 0,
  activeIndex: -1,
  found: false,
}

export function PaneSearchControl({
  onSearch,
  onClearSearch,
  isMobile = false,
}: PaneSearchControlProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ATermSearchResult>(EMPTY_RESULT)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen) return
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [isOpen])

  const closeSearch = () => {
    setIsOpen(false)
    setQuery('')
    setResult(EMPTY_RESULT)
    onClearSearch()
  }

  const runSearch = (nextQuery: string, options?: ATermSearchOptions) => {
    if (!nextQuery.trim()) {
      setResult(EMPTY_RESULT)
      onClearSearch()
      return
    }
    setResult(onSearch(nextQuery, options))
  }

  const navigate = (direction: ATermSearchOptions['direction']) => {
    runSearch(query, { direction, reset: false })
  }

  if (!isOpen) {
    return (
      <HeaderIconButton
        icon={<Search className="h-[18px] w-[18px]" strokeWidth={1.7} />}
        onClick={() => setIsOpen(true)}
        tooltip="Search output"
        isMobile={isMobile}
      />
    )
  }

  const navButton =
    'lantern-icon-btn h-7! w-7! disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div
      data-testid="pane-search-control"
      className={clsx(
        'lantern-field h-[34px]! gap-1! pr-0.5! pl-2.5!',
        isMobile ? 'max-w-[200px]' : 'w-[300px]',
      )}
      style={
        query.trim() && !result.found
          ? { borderColor: 'var(--ember)' }
          : undefined
      }
    >
      <Search className="h-4 w-4 flex-shrink-0" strokeWidth={1.7} />
      <input
        ref={inputRef}
        data-testid="pane-search-input"
        aria-label="Search output"
        value={query}
        onChange={(event) => {
          const nextQuery = event.target.value
          setQuery(nextQuery)
          runSearch(nextQuery, { direction: 'next', reset: true })
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            navigate(event.shiftKey ? 'previous' : 'next')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            closeSearch()
          }
          event.stopPropagation()
        }}
        placeholder="Search output"
        className="text-[13px]"
        spellCheck={false}
        autoComplete="off"
      />
      <span
        className="px-1 text-[11px]"
        style={{
          color: result.found ? 'var(--lantern)' : 'var(--mist)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {result.found
          ? `${result.activeIndex + 1}/${result.totalMatches}`
          : '0'}
      </span>
      <button
        type="button"
        onClick={() => navigate('previous')}
        className={navButton}
        title="Previous match"
        aria-label="Previous match"
        disabled={!query.trim()}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => navigate('next')}
        className={navButton}
        title="Next match"
        aria-label="Next match"
        disabled={!query.trim()}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={closeSearch}
        className={navButton}
        title="Close search"
        aria-label="Close search"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
