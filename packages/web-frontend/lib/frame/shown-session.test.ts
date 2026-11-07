import { describe, expect, it } from 'vitest'
import type { ShownSession } from './shown-session'
import { shownSessionLine } from './shown-session'

const session = (patch: Partial<ShownSession>): ShownSession => ({
  id: 's1',
  name: 'aico',
  agent: 'claude',
  agentName: 'Claude',
  status: 'connected',
  attention: null,
  holder: null,
  ...patch,
})

const attention = (group: 'working' | 'idle'): ShownSession['attention'] => ({
  group,
  activity: group === 'working' ? 'working' : 'idle',
  at: null,
  detail: null,
  age: null,
})

describe('the top bar session line', () => {
  it('leads with the connection, then who holds the size', () => {
    expect(shownSessionLine(session({}))).toMatch(/^Live/)
    expect(shownSessionLine(session({ status: 'disconnected' }))).toMatch(
      /^Disconnected/,
    )
    expect(shownSessionLine(session({ holder: 'phone' }))).toMatch(
      /sized for phone$/,
    )
  })

  it('leaves the size to the bar above the session when asked (phone)', () => {
    expect(shownSessionLine(session({ holder: 'phone' }), false)).toBe('Live')
  })

  it('adds what a working agent is doing, and only while it works', () => {
    const working = attention('working')
    const doing = 'Editing history.ts'
    expect(shownSessionLine(session({ attention: working, doing }))).toBe(
      'Live · working · Editing history.ts',
    )
    // A phone drops "working": the doing line says it.
    expect(
      shownSessionLine(session({ attention: working, doing }), false),
    ).toBe('Live · Editing history.ts')
    expect(shownSessionLine(session({ attention: working }))).toBe(
      'Live · working',
    )
    const idle = attention('idle')
    expect(shownSessionLine(session({ attention: idle, doing }))).toBe(
      'Live · idle',
    )
  })
})
