import { describe, expect, it } from 'vitest'
import { programOwnsSelection, setupMouseShim } from './mouse-shim'

function harness(reporting: boolean) {
  const handlers = new Map<string, (e: unknown) => void>()
  const container = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    removeEventListener: () => {},
  } as unknown as HTMLElement
  const term = {
    _core: { coreMouseService: { areMouseEventsActive: reporting } },
  } as never
  setupMouseShim(term, container, () => false) // program owns selection (Claude Code)
  return (type: string, button: number) => {
    const calls: string[] = []
    handlers.get(type)?.({
      type,
      button,
      shiftKey: false,
      isTrusted: true,
      stopPropagation: () => calls.push('stop'),
      preventDefault: () => calls.push('prevent'),
    })
    return calls
  }
}

describe('right-click stays out of mouse-reporting programs', () => {
  it('swallows right press and release so only Aico pastes', () => {
    const fire = harness(true)
    expect(fire('mousedown', 2)).toEqual(['stop', 'prevent'])
    expect(fire('mouseup', 2)).toEqual(['stop', 'prevent'])
  })

  it('leaves the left button to the program that owns selection', () => {
    const fire = harness(true)
    expect(fire('mousedown', 0)).toEqual([])
    expect(fire('mouseup', 0)).toEqual([])
  })

  it('does nothing when no program grabbed the mouse', () => {
    expect(harness(false)('mousedown', 2)).toEqual([])
  })
})

describe('program-owned selection', () => {
  it('leaves drags to Claude Code fullscreen and to full-screen shell programs', () => {
    const fullscreen = { alternateScreen: true, mouseReporting: true }
    expect(programOwnsSelection({ tuiSlug: 'claude-code', ...fullscreen })).toBe(true)
    expect(programOwnsSelection({ tuiSlug: 'shell', ...fullscreen })).toBe(true)
  })

  it('keeps local selection for other agents and for the normal screen', () => {
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
