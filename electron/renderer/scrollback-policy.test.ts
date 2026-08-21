import { describe, expect, it } from 'vitest'
import {
  claimsWheelForPane,
  scrollbackWheelAction,
  shouldOpenScrollbackOnWheel,
} from './scrollback-policy'

describe('scrollback wheel policy', () => {
  it('opens on upward wheel when no TUI owns the mouse', () => {
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: false,
        alternateScreen: false,
        tuiSlug: 'shell',
      }),
    ).toBe('open')
    expect(
      shouldOpenScrollbackOnWheel({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: false,
        alternateScreen: false,
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
        alternateScreen: false,
        tuiSlug: 'shell',
      }),
    ).toBe('ignore')
  })

  it('opens known TUI scrollback for a normal-screen TUI that reports the mouse', () => {
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: true,
        alternateScreen: false,
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
        alternateScreen: false,
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
        alternateScreen: false,
        tuiSlug: 'shell',
      }),
    ).toBe('ignore')
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: true,
        mouseReportingActive: false,
        alternateScreen: false,
        tuiSlug: 'claude-code',
      }),
    ).toBe('ignore')
  })

  it('forwards the wheel to a TUI that owns the alternate screen and the mouse', () => {
    // Claude Code: tmux holds no history worth showing, the program does.
    for (const deltaY of [-100, 100]) {
      expect(
        scrollbackWheelAction({
          deltaY,
          overlayActive: false,
          mouseReportingActive: true,
          alternateScreen: true,
          tuiSlug: 'claude-code',
        }),
      ).toBe('forward')
    }
  })

  it('keeps the overlay for alternate-screen TUIs that do not grab the mouse', () => {
    // Antigravity and Codex keep their output in tmux history.
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: false,
        alternateScreen: true,
        tuiSlug: 'antigravity',
      }),
    ).toBe('open')
  })

  it('never forwards for a plain shell, whatever the program is doing', () => {
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: true,
        alternateScreen: true,
        tuiSlug: 'shell',
      }),
    ).toBe('ignore')
  })
})

describe('claiming the wheel for the live pane', () => {
  it('leaves the wheel to the overlay while it is up', () => {
    // The overlay pages older history and dismisses on a downward wheel at the
    // bottom; claiming the event here left only its scrollbar working.
    expect(claimsWheelForPane({ deltaY: -100, overlayActive: true, tuiSlug: 'antigravity' })).toBe(
      false,
    )
  })

  it('claims an agent TUI wheel when the overlay is closed', () => {
    expect(claimsWheelForPane({ deltaY: -100, overlayActive: false, tuiSlug: 'antigravity' })).toBe(
      true,
    )
  })

  it('never claims for a plain shell or an empty delta', () => {
    expect(claimsWheelForPane({ deltaY: -100, overlayActive: false, tuiSlug: 'shell' })).toBe(false)
    expect(claimsWheelForPane({ deltaY: 0, overlayActive: false, tuiSlug: 'antigravity' })).toBe(
      false,
    )
  })
})
