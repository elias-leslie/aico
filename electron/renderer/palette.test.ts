import { describe, expect, it } from 'vitest'
import type { Action } from './actions'
import { paletteKeyIntent, paletteMatches } from './palette'

const action = (id: string, section: string, label: string): Action => ({
  id,
  section,
  label,
  shortcut: '',
  icon: '•',
})

const runnable = [
  action('voice', 'Voice', 'Dictate into session'),
  action('replace:codex', 'Replace TUI', 'Replace with Codex'),
  action('retire-widget', 'Session', 'End session'),
]

describe('paletteMatches', () => {
  it('lists every runnable action for a blank query', () => {
    expect(paletteMatches(runnable, '  ').map((a) => a.id)).toEqual([
      'voice',
      'replace:codex',
      'retire-widget',
    ])
  })

  it('matches label or section case-insensitively, trimming the query', () => {
    expect(paletteMatches(runnable, ' CODEX ').map((a) => a.id)).toEqual(['replace:codex'])
    expect(paletteMatches(runnable, 'session').map((a) => a.id)).toEqual(['voice', 'retire-widget'])
    expect(paletteMatches(runnable, 'nothing')).toEqual([])
  })
})

describe('paletteKeyIntent', () => {
  it('moves the selection within the list bounds', () => {
    expect(paletteKeyIntent('ArrowDown', 0, 3)).toEqual({ kind: 'select', index: 1 })
    expect(paletteKeyIntent('ArrowDown', 2, 3)).toEqual({ kind: 'select', index: 2 })
    expect(paletteKeyIntent('ArrowUp', 2, 3)).toEqual({ kind: 'select', index: 1 })
    expect(paletteKeyIntent('ArrowUp', 0, 3)).toEqual({ kind: 'select', index: 0 })
    // An empty list keeps the previous unclamped -1 selection.
    expect(paletteKeyIntent('ArrowDown', 0, 0)).toEqual({ kind: 'select', index: -1 })
  })

  it('activates on Enter and closes on Escape', () => {
    expect(paletteKeyIntent('Enter', 1, 3)).toEqual({ kind: 'activate' })
    expect(paletteKeyIntent('Escape', 1, 3)).toEqual({ kind: 'close' })
  })

  it('leaves every other key to the text input', () => {
    expect(paletteKeyIntent('a', 0, 3)).toBeNull()
    expect(paletteKeyIntent('Tab', 0, 3)).toBeNull()
  })
})
