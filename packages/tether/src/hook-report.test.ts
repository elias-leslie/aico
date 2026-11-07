import { describe, expect, it } from 'vitest'
import { parseHookReport } from './lifecycle-api'

const CLAUDE = '5a7741ea-e6b1-4062-853b-0d9d2e03d549'

describe('hook reports', () => {
  it('validates the request body', () => {
    expect(
      parseHookReport({
        event: 'Notification',
        notificationType: 'permission_prompt',
        agent: 'claude',
        agentSessionId: CLAUDE,
      }),
    ).toEqual({
      event: 'Notification',
      notificationType: 'permission_prompt',
      agent: 'claude',
      agentSessionId: CLAUDE,
    })
    expect(() => parseHookReport({ event: 'Bogus', agent: 'claude' })).toThrow()
    expect(() => parseHookReport({ event: 'Stop', agent: 'pi' })).toThrow()
    expect(() => parseHookReport({ event: 'Stop', agent: 'claude', prompt: 'x' })).toThrow()
  })
})
