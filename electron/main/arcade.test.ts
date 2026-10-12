import { describe, expect, it } from 'vitest'
import { cursorNearTitlebar, nextArcade, parseArcadeKeys, pickArcade } from './arcade'

describe('parseArcadeKeys', () => {
  it('accepts short lowercase ids and drops repeats', () => {
    expect(parseArcadeKeys(['mazechase', 'loungeadventure', 'mazechase'])).toEqual([
      'mazechase',
      'loungeadventure',
    ])
  })
  it('rejects anything else', () => {
    expect(parseArcadeKeys('mazechase')).toBeNull()
    expect(parseArcadeKeys([])).toBeNull()
    expect(parseArcadeKeys(['Pac-Man'])).toBeNull()
    expect(parseArcadeKeys(['../x'])).toBeNull()
    expect(parseArcadeKeys(Array.from({ length: 65 }, (_, i) => `k${i}`))).toBeNull()
  })
})

describe('pickArcade', () => {
  const keys = ['a', 'b', 'c']
  it('never repeats a game while another is free', () => {
    for (let i = 0; i < 20; i++) {
      expect(pickArcade(keys, ['a', 'c'], () => i / 20)).toBe('b')
    }
  })
  it('shares out evenly once every game is showing', () => {
    expect(pickArcade(keys, ['a', 'b', 'c', 'a', 'c'], () => 0.99)).toBe('b')
  })
  it('ignores games it no longer knows', () => {
    expect(pickArcade(keys, ['zzz', 'a', 'b'], () => 0)).toBe('c')
  })
  it('picks at random among the free games', () => {
    expect(pickArcade(keys, [], () => 0)).toBe('a')
    expect(pickArcade(keys, [], () => 0.999)).toBe('c')
  })
  it('returns null with nothing to pick', () => {
    expect(pickArcade([], [])).toBeNull()
  })
})

describe('nextArcade', () => {
  const keys = ['a', 'b', 'c', 'd']
  it('shows every game once before repeating one', () => {
    let current = 'a'
    let shown = new Set(['a'])
    const seen = [current]
    for (let i = 0; i < 3; i++) {
      const r = nextArcade(keys, current, [], shown, () => 0.5)
      current = r.key as string
      shown = r.shown
      seen.push(current)
    }
    expect(new Set(seen).size).toBe(4)
    // all shown: the history starts over, never staying on the current game
    const r = nextArcade(keys, current, [], shown, () => 0)
    expect(r.key).not.toBe(current)
    expect([...r.shown].sort()).toEqual([current, r.key].sort())
  })
  it('skips games other windows are showing while a free one exists', () => {
    const r = nextArcade(keys, 'a', ['b', 'c'], new Set(['a']), () => 0)
    expect(r.key).toBe('d')
    // d already shown here, but b and c are taken: d again rather than a duplicate
    expect(nextArcade(keys, 'a', ['b', 'c'], new Set(['a', 'd']), () => 0).key).toBe('d')
  })
  it('stays put with a single game', () => {
    expect(nextArcade(['a'], 'a', [], new Set(['a'])).key).toBe('a')
  })
})

describe('cursorNearTitlebar', () => {
  const content = { x: 100, y: 200, width: 500, height: 400 }
  it('maps a nearby cursor to window coordinates', () => {
    expect(cursorNearTitlebar({ x: 150, y: 210 }, content)).toEqual({ x: 50, y: 10 })
    expect(cursorNearTitlebar({ x: 90, y: 170 }, content)).toEqual({ x: -10, y: -30 })
  })
  it('ignores the cursor deep in the terminal or far away', () => {
    expect(cursorNearTitlebar({ x: 150, y: 500 }, content)).toBeNull()
    expect(cursorNearTitlebar({ x: 900, y: 210 }, content)).toBeNull()
    expect(cursorNearTitlebar({ x: 150, y: 100 }, content)).toBeNull()
  })
})
