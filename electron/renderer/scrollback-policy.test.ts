import { describe, expect, it } from 'vitest'
import { scrollbackWheelAction, shouldOpenScrollbackOnWheel } from './scrollback-policy'

describe('scrollback wheel policy', () => {
  it('opens on upward wheel when no TUI owns the mouse', () => {
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: false,
        tuiSlug: 'shell',
      }),
    ).toBe('open')
    expect(
      shouldOpenScrollbackOnWheel({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: false,
        tuiSlug: 'shell',
      }),
    ).toBe(true)
  })

  it('leaves shell mouse-reporting apps alone', () => {
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: true,
        tuiSlug: 'shell',
      }),
    ).toBe('ignore')
  })

  it('opens known TUI scrollback even when the TUI has mouse reporting active', () => {
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: true,
        tuiSlug: 'claude-code',
      }),
    ).toBe('open')
  })

  it('consumes known TUI downward wheel events so they do not reach the TUI', () => {
    expect(
      scrollbackWheelAction({
        deltaY: 100,
        overlayActive: false,
        mouseReportingActive: true,
        tuiSlug: 'claude-code',
      }),
    ).toBe('consume')
  })

  it('ignores shell downward wheel and active overlay cases', () => {
    expect(
      scrollbackWheelAction({
        deltaY: 100,
        overlayActive: false,
        mouseReportingActive: false,
        tuiSlug: 'shell',
      }),
    ).toBe('ignore')
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: true,
        mouseReportingActive: false,
        tuiSlug: 'claude-code',
      }),
    ).toBe('ignore')
  })
})
