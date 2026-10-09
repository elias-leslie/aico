import { describe, expect, it } from 'vitest'
import {
  claimsWheelForPane,
  programOwnsSelection,
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

  it('forwards the wheel to a mouse-reporting program in a shell', () => {
    // xterm's own wheel reporting is off, so 'ignore' would scroll nothing.
    for (const alternateScreen of [false, true]) {
      expect(
        scrollbackWheelAction({
          deltaY: -100,
          overlayActive: false,
          mouseReportingActive: true,
          alternateScreen,
          tuiSlug: 'shell',
        }),
      ).toBe('forward')
    }
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

  it('consumes downward wheel at the live bottom of a shell-hosted TUI', () => {
    // Sessions keep their shell identity when an agent is started manually.
    // With no mouse reporting, xterm turns an unclaimed wheel into arrow keys.
    expect(
      scrollbackWheelAction({
        deltaY: 100,
        overlayActive: false,
        mouseReportingActive: false,
        alternateScreen: true,
        tuiSlug: 'shell',
      }),
    ).toBe('consume')
  })

  it('consumes shell downward wheel and ignores active overlay cases', () => {
    expect(
      scrollbackWheelAction({
        deltaY: 100,
        overlayActive: false,
        mouseReportingActive: false,
        alternateScreen: false,
        tuiSlug: 'shell',
      }),
    ).toBe('consume')
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
    // e.g. Antigravity's (agy) folder-trust prompt: the overlay, not the program.
    expect(
      scrollbackWheelAction({
        deltaY: -100,
        overlayActive: false,
        mouseReportingActive: false,
        alternateScreen: true,
        tuiSlug: 'agy',
      }),
    ).toBe('open')
  })
})

describe('claiming the wheel for the live pane', () => {
  it('leaves the wheel to the overlay while it is up', () => {
    // The overlay pages older history and dismisses on a downward wheel at the
    // bottom; claiming the event here left only its scrollbar working.
    expect(claimsWheelForPane({ deltaY: -100, overlayActive: true, tuiSlug: 'agy' })).toBe(false)
  })

  it('claims an agent TUI wheel when the overlay is closed', () => {
    expect(claimsWheelForPane({ deltaY: -100, overlayActive: false, tuiSlug: 'agy' })).toBe(true)
  })

  it('never claims for a plain shell or an empty delta', () => {
    expect(claimsWheelForPane({ deltaY: -100, overlayActive: false, tuiSlug: 'shell' })).toBe(false)
    expect(claimsWheelForPane({ deltaY: 0, overlayActive: false, tuiSlug: 'agy' })).toBe(false)
  })
})

describe('program-owned selection', () => {
  it('leaves drags to Claude Code fullscreen and to full-screen shell programs', () => {
    const fullscreen = { alternateScreen: true, mouseReporting: true }
    expect(programOwnsSelection({ tuiSlug: 'claude-code', ...fullscreen })).toBe(true)
    expect(programOwnsSelection({ tuiSlug: 'shell', ...fullscreen })).toBe(true)
  })

  it('keeps local selection for other agents and for history in tmux', () => {
    expect(
      programOwnsSelection({ tuiSlug: 'codex', alternateScreen: true, mouseReporting: true }),
    ).toBe(false)
    expect(
      programOwnsSelection({
        tuiSlug: 'claude-code',
        alternateScreen: false,
        mouseReporting: true,
      }),
    ).toBe(false)
  })
})

// Pane modes observed from each registered TUI's main screen in tmux
// (#{alternate_on} / #{mouse_any_flag}), with Claude Code in its "fullscreen"
// renderer. Re-observe when a TUI changes how it draws.
const OBSERVED_TUI_PANES = [
  { tuiSlug: 'claude-code', alternateScreen: true, mouseReporting: true, owner: 'program' },
  { tuiSlug: 'codex', alternateScreen: false, mouseReporting: false, owner: 'overlay' },
  { tuiSlug: 'agy', alternateScreen: false, mouseReporting: false, owner: 'overlay' },
  { tuiSlug: 'pi', alternateScreen: false, mouseReporting: false, owner: 'overlay' },
  { tuiSlug: 'shell', alternateScreen: false, mouseReporting: false, owner: 'overlay' },
] as const

describe('every registered TUI', () => {
  it('has an observed pane mode', async () => {
    const { clearRegistry, listTuis, registerBuiltinTuis } = await import('../main/tui/registry')
    clearRegistry()
    registerBuiltinTuis()
    const registered = listTuis()
      .map((tui) => tui.slug)
      .sort()
    expect(OBSERVED_TUI_PANES.map((pane) => pane.tuiSlug).sort()).toEqual(registered)
  })

  for (const pane of OBSERVED_TUI_PANES) {
    it(`routes wheel and drags for ${pane.tuiSlug}`, () => {
      const wheel = (deltaY: number) =>
        scrollbackWheelAction({
          deltaY,
          overlayActive: false,
          mouseReportingActive: pane.mouseReporting,
          alternateScreen: pane.alternateScreen,
          tuiSlug: pane.tuiSlug,
        })
      const owns = programOwnsSelection(pane)
      if (pane.owner === 'program') {
        expect([wheel(-100), wheel(100)]).toEqual(['forward', 'forward'])
        expect(owns).toBe(true)
      } else {
        expect([wheel(-100), wheel(100)]).toEqual(['open', 'consume'])
        expect(owns).toBe(false)
      }
    })
  }
})
