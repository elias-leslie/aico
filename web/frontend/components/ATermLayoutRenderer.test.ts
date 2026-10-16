import { describe, expect, it } from 'vitest'
import { SLOT_BASE } from '@/test-stubs/session-fixtures'
import { getLayoutRemountKey } from './ATermLayoutRenderer'

describe('getLayoutRemountKey', () => {
  it('changes when the native pane order changes', () => {
    const firstOrder = getLayoutRemountKey('split-horizontal', [
      {
        type: 'adhoc',
        ...SLOT_BASE,
        paneId: 'pane-1',
        sessionId: 'native-1',
        name: 'Ad-Hoc A-Term',
        workingDir: null,
      },
      {
        type: 'adhoc',
        ...SLOT_BASE,
        paneId: 'pane-2',
        sessionId: 'native-2',
        name: 'Second A-Term',
        workingDir: null,
      },
    ])
    const swappedOrder = getLayoutRemountKey('split-horizontal', [
      {
        type: 'adhoc',
        ...SLOT_BASE,
        paneId: 'pane-2',
        sessionId: 'native-2',
        name: 'Second A-Term',
        workingDir: null,
      },
      {
        type: 'adhoc',
        ...SLOT_BASE,
        paneId: 'pane-1',
        sessionId: 'native-1',
        name: 'Ad-Hoc A-Term',
        workingDir: null,
      },
    ])

    expect(swappedOrder).not.toBe(firstOrder)
  })

  it('changes when the external slot set changes', () => {
    const withExternal = getLayoutRemountKey('split-horizontal', [
      {
        type: 'adhoc',
        ...SLOT_BASE,
        sessionId: 'codex-agent-hub',
        name: 'codex-agent-hub',
        workingDir: '/workspace/agent-hub',
        isExternal: true,
      },
    ])
    const withoutExternal = getLayoutRemountKey('split-horizontal', [
      {
        type: 'adhoc',
        ...SLOT_BASE,
        paneId: 'pane-1',
        sessionId: 'native-1',
        name: 'Ad-Hoc A-Term',
        workingDir: null,
      },
    ])

    expect(withExternal).not.toBe(withoutExternal)
  })
})
