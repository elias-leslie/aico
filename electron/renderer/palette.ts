import type { Action } from './actions'

/** Runnable actions whose label or section contains the query (case-insensitive). */
export function paletteMatches(runnable: readonly Action[], query: string): Action[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...runnable]
  return runnable.filter(
    (a) => a.label.toLowerCase().includes(q) || a.section.toLowerCase().includes(q),
  )
}

export type PaletteKeyIntent =
  | { kind: 'select'; index: number }
  | { kind: 'activate' }
  | { kind: 'close' }
  | null

/** What a palette keystroke does, given the current selection and item count. */
export function paletteKeyIntent(key: string, selected: number, count: number): PaletteKeyIntent {
  if (key === 'ArrowDown') return { kind: 'select', index: Math.min(selected + 1, count - 1) }
  if (key === 'ArrowUp') return { kind: 'select', index: Math.max(selected - 1, 0) }
  if (key === 'Enter') return { kind: 'activate' }
  if (key === 'Escape') return { kind: 'close' }
  return null
}
