import { describe, expect, it } from 'vitest'
import {
  isDocked,
  nearestTier,
  PANEL_PX,
  RAIL_PX,
  stepTier,
  tierKey,
  tierWidth,
} from './tiers'

const key = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  code,
  ...mods,
})

describe('left side tiers', () => {
  it('sizes rail 64, panel 360, wide 58% and full 100% of the frame', () => {
    expect(tierWidth('rail', 1440)).toBe(RAIL_PX)
    expect(tierWidth('panel', 1440)).toBe(PANEL_PX)
    expect(tierWidth('wide', 1440)).toBe(835)
    expect(tierWidth('full', 1440)).toBe(1440)
    // Wide is never narrower than the panel it holds.
    expect(tierWidth('wide', 500)).toBe(PANEL_PX)
  })

  it('snaps a drag to the nearest width', () => {
    expect(nearestTier(10, 1440)).toBe('hidden')
    expect(nearestTier(40, 1440)).toBe('rail')
    expect(nearestTier(250, 1440)).toBe('panel')
    expect(nearestTier(700, 1440)).toBe('wide')
    expect(nearestTier(1300, 1440)).toBe('full')
  })

  it('steps one tier and stops at the ends', () => {
    expect(stepTier('panel', 1)).toBe('wide')
    expect(stepTier('panel', -1)).toBe('rail')
    expect(stepTier('rail', -1)).toBe('hidden')
    expect(stepTier('hidden', -1)).toBe('hidden')
    expect(stepTier('full', 1)).toBe('full')
  })

  it('reads Alt+1..4 and Alt+[ / Alt+] by key position, nothing else', () => {
    expect(tierKey(key('Digit0'))).toEqual({ tier: 'hidden' })
    expect(tierKey(key('Digit1'))).toEqual({ tier: 'rail' })
    expect(tierKey(key('Digit4'))).toEqual({ tier: 'full' })
    expect(tierKey(key('BracketLeft'))).toEqual({ step: -1 })
    expect(tierKey(key('BracketRight'))).toEqual({ step: 1 })
    expect(tierKey(key('Digit5'))).toBeNull()
    expect(tierKey(key('Digit1', { altKey: false }))).toBeNull()
    expect(tierKey(key('Digit1', { ctrlKey: true }))).toBeNull()
    expect(tierKey(key('Digit1', { shiftKey: true }))).toBeNull()
  })

  it('keeps only the docked tiers on the device', () => {
    expect(isDocked('wide')).toBe(true)
    expect(isDocked('full')).toBe(false)
    expect(isDocked('huge')).toBe(false)
  })
})
