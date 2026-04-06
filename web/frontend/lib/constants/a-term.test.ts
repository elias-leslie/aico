import { describe, expect, it } from 'vitest'
import {
  getAvailableLayoutModes,
  getDefaultLayoutMode,
  getPaneCapacityForViewport,
} from './a-term'

describe('getPaneCapacityForViewport', () => {
  it('allows six panes on desktop widths', () => {
    expect(getPaneCapacityForViewport(1600)).toBe(6)
  })

  it('allows six panes on ultrawide widths', () => {
    expect(getPaneCapacityForViewport(1920)).toBe(6)
    expect(getPaneCapacityForViewport(2560)).toBe(6)
  })

  it('keeps smaller mobile widths below the desktop pane cap', () => {
    expect(getPaneCapacityForViewport(767)).toBe(4)
  })
})

describe('getAvailableLayoutModes', () => {
  it('offers both split orientations for two panes', () => {
    expect(getAvailableLayoutModes(2, 1440)).toEqual([
      'split-horizontal',
      'split-vertical',
    ])
  })

  it('offers split orientations and main+side for three panes', () => {
    expect(getAvailableLayoutModes(3, 1440)).toEqual([
      'split-horizontal',
      'split-vertical',
      'split-main-side',
    ])
  })

  it('offers side by side and grid for four panes', () => {
    expect(getAvailableLayoutModes(4, 1440)).toEqual([
      'split-horizontal',
      'grid-2x2',
    ])
  })

  it('offers side by side and grid for five panes', () => {
    expect(getAvailableLayoutModes(5, 1920)).toEqual([
      'split-horizontal',
      'grid-3x2',
    ])
  })

  it('offers side by side and grid for six panes', () => {
    expect(getAvailableLayoutModes(6, 2560)).toEqual([
      'split-horizontal',
      'grid-3x2',
    ])
  })

  it('returns only a horizontal split for a single pane', () => {
    expect(getAvailableLayoutModes(1, 1440)).toEqual(['split-horizontal'])
  })
})

describe('getDefaultLayoutMode', () => {
  it('defaults two panes to a side-by-side split', () => {
    expect(getDefaultLayoutMode(2, 1440)).toBe('split-horizontal')
  })

  it('defaults larger desktop layouts to the grid that fits them', () => {
    expect(getDefaultLayoutMode(3, 1440)).toBe('split-horizontal')
    expect(getDefaultLayoutMode(4, 1440)).toBe('grid-2x2')
    expect(getDefaultLayoutMode(6, 2560)).toBe('grid-3x2')
  })
})
