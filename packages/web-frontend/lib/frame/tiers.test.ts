import { describe, expect, it } from 'vitest'
import {
  isDocked,
  nearestTier,
  PANEL_PX,
  panelWidthAt,
  RAIL_PX,
  tierKey,
  tierWidth,
  toggledTier,
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
  it('sizes rail 64, panel 360 and a page 100% of the frame', () => {
    expect(tierWidth('rail', 1440)).toBe(RAIL_PX)
    expect(tierWidth('panel', 1440)).toBe(PANEL_PX)
    expect(tierWidth('full', 1440)).toBe(1440)
  })

  it('lets a drag go to the rail when pulled in, else the panel', () => {
    expect(nearestTier(10)).toBe('rail')
    expect(nearestTier(150)).toBe('rail')
    expect(nearestTier(250)).toBe('panel')
    expect(nearestTier(900)).toBe('panel')
  })

  it('keeps the default panel width when let go near it, and caps a wide one', () => {
    expect(panelWidthAt(300, 1440)).toBe(PANEL_PX)
    expect(panelWidthAt(370, 1440)).toBe(PANEL_PX)
    expect(panelWidthAt(520, 1440)).toBe(520)
    expect(panelWidthAt(1400, 1440)).toBe(1296)
  })

  it('flips between the rail and the panel', () => {
    expect(toggledTier('panel')).toBe('rail')
    expect(toggledTier('rail')).toBe('panel')
    expect(toggledTier('full')).toBe('panel')
  })

  it('reads Alt+1, Alt+2 and Alt+[ / Alt+] by key position, nothing else', () => {
    expect(tierKey(key('Digit1'))).toEqual({ tier: 'rail' })
    expect(tierKey(key('Digit2'))).toEqual({ tier: 'panel' })
    expect(tierKey(key('BracketLeft'))).toEqual({ toggle: true })
    expect(tierKey(key('BracketRight'))).toEqual({ toggle: true })
    expect(tierKey(key('Digit0'))).toBeNull()
    expect(tierKey(key('Digit3'))).toBeNull()
    expect(tierKey(key('Digit1', { altKey: false }))).toBeNull()
    expect(tierKey(key('Digit1', { ctrlKey: true }))).toBeNull()
    expect(tierKey(key('Digit1', { shiftKey: true }))).toBeNull()
  })

  it('keeps only the rail and the panel on the device', () => {
    expect(isDocked('panel')).toBe(true)
    expect(isDocked('rail')).toBe(true)
    expect(isDocked('hidden')).toBe(false)
    expect(isDocked('full')).toBe(false)
    expect(isDocked('huge')).toBe(false)
  })
})
