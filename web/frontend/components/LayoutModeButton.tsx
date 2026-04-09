'use client'

import { ChevronDown } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GRID_MIN_WIDTHS, type LayoutMode } from '@/lib/constants/a-term'
import { useClickOutside } from '@/lib/hooks/use-click-outside'
import { useDropdownPosition } from '@/lib/hooks/use-dropdown-position'
import {
  ColumnsSideBySideIcon,
  GridIcon,
  MainSideIcon,
  RowsStackedIcon,
  WideGridIcon,
} from './LayoutIcons'

interface LayoutOption {
  mode: LayoutMode
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>
  title: string
  minWidth?: number
}

const LAYOUT_OPTIONS: LayoutOption[] = [
  {
    mode: 'split-horizontal',
    icon: ColumnsSideBySideIcon,
    title: 'Columns',
  },
  {
    mode: 'split-vertical',
    icon: RowsStackedIcon,
    title: 'Rows',
  },
  {
    mode: 'split-main-side',
    icon: MainSideIcon,
    title: 'Main + Side',
  },
  {
    mode: 'grid-2x2',
    icon: GridIcon,
    title: 'Grid',
    minWidth: GRID_MIN_WIDTHS['grid-2x2'],
  },
  {
    mode: 'grid-4x1',
    icon: GridIcon,
    title: 'Grid',
    minWidth: GRID_MIN_WIDTHS['grid-4x1'],
  },
  {
    mode: 'grid-3x2',
    icon: WideGridIcon,
    title: 'Wide Grid',
    minWidth: GRID_MIN_WIDTHS['grid-3x2'],
  },
  {
    mode: 'grid-2x3',
    icon: WideGridIcon,
    title: 'Wide Grid',
    minWidth: GRID_MIN_WIDTHS['grid-2x3'],
  },
]

interface LayoutModeButtonsProps {
  layoutMode: LayoutMode
  onLayoutChange: (mode: LayoutMode) => void
  availableLayouts?: LayoutMode[]
}

export function LayoutModeButtons({
  layoutMode,
  onLayoutChange,
  availableLayouts,
}: LayoutModeButtonsProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])

  const closeDropdown = useCallback(() => setIsOpen(false), [])
  const clickOutsideRefs = useMemo(() => [buttonRef, dropdownRef], [])
  useClickOutside(clickOutsideRefs, closeDropdown, isOpen)

  const dropdownStyle = useDropdownPosition(buttonRef, isOpen, {
    estimatedHeight: 140,
  })

  // Filter options by availableLayouts if provided
  const filteredOptions = useMemo(() => {
    if (!availableLayouts) return LAYOUT_OPTIONS
    return LAYOUT_OPTIONS.filter((opt) => availableLayouts.includes(opt.mode))
  }, [availableLayouts])

  useEffect(() => {
    if (!isOpen) return

    const selectedIndex = filteredOptions.findIndex(
      (option) => option.mode === layoutMode,
    )
    const nextIndex = selectedIndex >= 0 ? selectedIndex : 0
    setHighlightedIndex(nextIndex)
    optionRefs.current[nextIndex]?.focus()
  }, [filteredOptions, isOpen, layoutMode])

  const handleSelect = (mode: LayoutMode) => {
    onLayoutChange(mode)
    setIsOpen(false)
  }

  const moveHighlight = useCallback(
    (direction: 1 | -1) => {
      if (filteredOptions.length === 0) return
      const nextIndex =
        (highlightedIndex + direction + filteredOptions.length) %
        filteredOptions.length
      setHighlightedIndex(nextIndex)
      optionRefs.current[nextIndex]?.focus()
    },
    [filteredOptions.length, highlightedIndex],
  )

  const handleButtonKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      event.preventDefault()
      setIsOpen(true)
    }
  }

  const handleOptionKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    mode: LayoutMode,
    index: number,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveHighlight(1)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveHighlight(-1)
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      setHighlightedIndex(0)
      optionRefs.current[0]?.focus()
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      const lastIndex = filteredOptions.length - 1
      setHighlightedIndex(lastIndex)
      optionRefs.current[lastIndex]?.focus()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setIsOpen(false)
      buttonRef.current?.focus()
      return
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      setHighlightedIndex(index)
      handleSelect(mode)
    }
  }

  // Get current layout info
  const currentLayout =
    LAYOUT_OPTIONS.find((opt) => opt.mode === layoutMode) || LAYOUT_OPTIONS[0]
  const CurrentIcon = currentLayout.icon

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        data-testid="layout-dropdown"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 p-1.5 rounded-md transition-all duration-150"
        style={{
          backgroundColor: isOpen ? 'var(--term-bg-elevated)' : 'transparent',
          color: isOpen ? 'var(--term-accent)' : 'var(--term-text-muted)',
          boxShadow: isOpen ? '0 0 8px var(--term-accent-glow)' : 'none',
        }}
        onMouseEnter={(e) => {
          if (!isOpen) {
            e.currentTarget.style.backgroundColor = 'var(--term-bg-elevated)'
            e.currentTarget.style.color = 'var(--term-text-primary)'
          }
        }}
        onMouseLeave={(e) => {
          if (!isOpen) {
            e.currentTarget.style.backgroundColor = 'transparent'
            e.currentTarget.style.color = 'var(--term-text-muted)'
          }
        }}
        title={currentLayout.title}
        aria-label="Change pane layout"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onKeyDown={handleButtonKeyDown}
      >
        <CurrentIcon className="w-4 h-4" />
        <ChevronDown
          className={`w-3 h-3 transition-transform duration-150 ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <>
          {/* Invisible overlay to capture clicks */}
          <div
            className="fixed inset-0 z-[9998]"
            onClick={() => setIsOpen(false)}
          />

          <div
            ref={dropdownRef}
            data-testid="layout-dropdown-menu"
            role="listbox"
            aria-label="Layout options"
            className="min-w-[160px] rounded-md overflow-hidden animate-in fade-in slide-in-from-top-1 duration-100"
            style={{
              ...dropdownStyle,
              backgroundColor: 'var(--term-surface-glass)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              border: '1px solid var(--term-border-active)',
              boxShadow: 'var(--term-shadow-dropdown)',
            }}
          >
            {filteredOptions.map(({ mode, icon: Icon, title }, index) => {
              const isSelected = mode === layoutMode
              const isHighlighted = index === highlightedIndex
              return (
                <button
                  key={mode}
                  ref={(element) => {
                    optionRefs.current[index] = element
                  }}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => handleSelect(mode)}
                  onKeyDown={(event) => handleOptionKeyDown(event, mode, index)}
                  className="flex items-center gap-2.5 w-full text-left px-3 py-2 text-xs transition-colors"
                  style={{
                    color: isSelected
                      ? 'var(--term-accent)'
                      : 'var(--term-text-primary)',
                    backgroundColor: isHighlighted
                      ? 'var(--term-bg-surface)'
                      : 'transparent',
                    fontFamily: 'var(--font-ui)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor =
                      'var(--term-bg-surface)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent'
                  }}
                >
                  <Icon
                    className="w-4 h-4"
                    style={{
                      color: isSelected
                        ? 'var(--term-accent)'
                        : 'var(--term-text-muted)',
                    }}
                  />
                  <span style={{ fontWeight: 500 }}>{title}</span>
                  {isSelected && (
                    <span
                      className="ml-auto text-[10px]"
                      style={{ color: 'var(--term-accent)' }}
                    >
                      ✓
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
