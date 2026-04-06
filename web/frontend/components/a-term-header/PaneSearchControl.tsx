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
  onSearch: (
    query: string,
    options?: ATermSearchOptions,
  ) => ATermSearchResult
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

  const runSearch = (
    nextQuery: string,
    options?: ATermSearchOptions,
  ) => {
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
        icon={<Search className="w-3.5 h-3.5" />}
        onClick={() => setIsOpen(true)}
        tooltip="Search pane output"
        isMobile={isMobile}
      />
    )
  }

  return (
    <div
      className={clsx(
        'flex items-center gap-1 rounded-md border px-1 py-1',
        isMobile ? 'max-w-[180px]' : 'max-w-[240px]',
      )}
      style={{
        backgroundColor: 'var(--term-bg-deep)',
        borderColor:
          query.trim() && !result.found
            ? 'var(--term-error)'
            : 'var(--term-border-active)',
      }}
    >
      <Search
        className="h-3.5 w-3.5 flex-shrink-0"
        style={{ color: 'var(--term-text-muted)' }}
      />
      <input
        ref={inputRef}
        data-testid="pane-search-input"
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
        className={clsx(
          'min-w-0 flex-1 bg-transparent text-xs outline-none',
          isMobile ? 'w-20' : 'w-28',
        )}
        style={{
          color: 'var(--term-text-primary)',
          fontFamily: 'var(--font-mono)',
        }}
        spellCheck={false}
        autoComplete="off"
      />
      <span
        className="rounded px-1 py-0.5 text-[10px]"
        style={{
          color: result.found
            ? 'var(--term-accent)'
            : 'var(--term-text-muted)',
          backgroundColor: 'var(--term-bg-surface)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {result.found ? `${result.activeIndex + 1}/${result.totalMatches}` : '0'}
      </span>
      <button
        type="button"
        onClick={() => navigate('previous')}
        className="flex h-5 w-5 items-center justify-center rounded transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40"
        style={{ color: 'var(--term-text-muted)' }}
        title="Previous match"
        aria-label="Previous match"
        disabled={!query.trim()}
      >
        <ChevronUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={() => navigate('next')}
        className="flex h-5 w-5 items-center justify-center rounded transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40"
        style={{ color: 'var(--term-text-muted)' }}
        title="Next match"
        aria-label="Next match"
        disabled={!query.trim()}
      >
        <ChevronDown className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={closeSearch}
        className="flex h-5 w-5 items-center justify-center rounded transition-all duration-150"
        style={{ color: 'var(--term-text-muted)' }}
        title="Close search"
        aria-label="Close search"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}
