import { describe, expect, it } from 'vitest'
import { sessionGeneration } from './generation'

describe('sessionGeneration', () => {
  it("matches Aico's owner-retirement sessionGeneration byte for byte", () => {
    // Vector computed with aico electron/main/owner-retirement.ts at aico dfe73a3.
    expect(
      sessionGeneration({
        id: '0a1b2c3d',
        ownershipId: 'aico-widget-0a1b2c3d',
        scopeUnit: 'tmux-spawn-01234567-89ab-cdef-0123-456789abcdef.scope',
        scopeInvocationId: '0123456789abcdef0123456789abcdef',
        pendingScopeUnit: null,
        pendingScopeInvocationId: null,
        lifecycleVersion: 1,
        tmuxSessionId: '$3',
        paneId: '%7',
        tmuxServerId: '06e633492f792ad10439f675491801ee',
        tmuxAllocationState: 'bound',
        launchState: 'dispatched',
        launchNonce: 'n0nce',
      }),
    ).toBe('078197329bf7179f655225e5ff16cb041d919f3e23a43684c1eb1af66dd5cf1a')
  })
})
