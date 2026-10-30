import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVE_WITHIN_MS,
  createSizeHolder,
  OVERLAY_DELAY_MS,
  RECLAIM_SPACING_MS,
} from './size-holder'

const PHONE = { viewer: { app: 'web', device: 'Safari on iPhone' }, size: { cols: 43, rows: 37 } }

function setup(active = false) {
  const state = { active, at: 1_000_000 }
  const reclaim = vi.fn()
  const show = vi.fn()
  const holder = createSizeHolder({
    reclaim,
    show,
    isActive: () => state.active,
    now: () => state.at,
  })
  return { holder, reclaim, show, state }
}

describe('size holder', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('shows the notice once another client has held the size for a moment', () => {
    const s = setup()
    s.holder.lost(PHONE)
    vi.advanceTimersByTime(OVERLAY_DELAY_MS - 1)
    expect(s.show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(s.show).toHaveBeenCalledExactlyOnceWith(PHONE)
    s.holder.lost(PHONE) // another claim by the same remote: no second show
    vi.advanceTimersByTime(OVERLAY_DELAY_MS)
    expect(s.show).toHaveBeenCalledTimes(1)
  })

  it('passes a new holder or size on at once while shown, and the same one only once', () => {
    const s = setup()
    s.holder.lost({ viewer: PHONE.viewer, size: null }) // tmux has not said yet
    vi.advanceTimersByTime(OVERLAY_DELAY_MS)
    expect(s.show).toHaveBeenLastCalledWith({ viewer: PHONE.viewer, size: null })
    s.holder.lost(PHONE)
    expect(s.show).toHaveBeenLastCalledWith(PHONE)
    s.holder.lost({ ...PHONE }) // the same holder at the same size
    expect(s.show).toHaveBeenCalledTimes(2)
    const keyboard = { ...PHONE, size: { cols: 43, rows: 20 } } // the phone's keyboard opened
    s.holder.lost(keyboard)
    expect(s.show).toHaveBeenLastCalledWith(keyboard)
  })

  it('never shows the notice for a size taken back in time', () => {
    const s = setup()
    s.holder.lost(PHONE)
    vi.advanceTimersByTime(OVERLAY_DELAY_MS - 100)
    s.holder.held()
    vi.advanceTimersByTime(OVERLAY_DELAY_MS * 2)
    expect(s.show).not.toHaveBeenCalled()
  })

  it('hides the notice when the size comes back', () => {
    const s = setup()
    s.holder.lost(PHONE)
    vi.advanceTimersByTime(OVERLAY_DELAY_MS)
    s.holder.held()
    expect(s.show).toHaveBeenLastCalledWith(null)
    expect(s.holder.isOther()).toBe(false)
  })

  it('claims on activity only while another client holds the size', () => {
    const s = setup()
    s.holder.activity()
    expect(s.reclaim).not.toHaveBeenCalled()
    s.holder.lost(PHONE)
    s.holder.activity()
    expect(s.reclaim).toHaveBeenCalledTimes(1)
  })

  it('spaces automatic claims out', () => {
    const s = setup()
    s.holder.lost(PHONE)
    s.holder.activity()
    s.holder.activity() // typing: a burst of keystrokes
    expect(s.reclaim).toHaveBeenCalledTimes(1)
    s.state.at += RECLAIM_SPACING_MS
    s.holder.activity()
    expect(s.reclaim).toHaveBeenCalledTimes(2)
  })

  it('stops claiming by itself when another client keeps taking the size', () => {
    const s = setup(true)
    for (let i = 0; i < 6; i += 1) {
      s.holder.lost(PHONE)
      s.state.at += RECLAIM_SPACING_MS
    }
    expect(s.reclaim).toHaveBeenCalledTimes(3)
    s.holder.force() // the button always works
    expect(s.reclaim).toHaveBeenCalledTimes(4)
    vi.advanceTimersByTime(OVERLAY_DELAY_MS)
    expect(s.show).toHaveBeenCalledWith(PHONE)
  })

  it('claims at once when the owner is typing as the size is lost', () => {
    const s = setup(true)
    s.holder.lost(PHONE)
    expect(s.reclaim).toHaveBeenCalledTimes(1)
    expect(ACTIVE_WITHIN_MS).toBeGreaterThan(0)
  })

  it('does not claim by itself when the owner is away', () => {
    const s = setup(false)
    s.holder.lost(PHONE)
    expect(s.reclaim).not.toHaveBeenCalled()
  })
})
