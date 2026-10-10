import { describe, expect, it } from 'vitest'
import { cursorNearTitlebar, parseArcadeKeys, pickArcade } from './arcade'

describe('parseArcadeKeys', () => {
  it('accepts short lowercase ids and drops repeats', () => {
    expect(parseArcadeKeys(['pacman', 'larry', 'pacman'])).toEqual(['pacman', 'larry'])
  })
  it('rejects anything else', () => {
    expect(parseArcadeKeys('pacman')).toBeNull()
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
