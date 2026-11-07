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
})
