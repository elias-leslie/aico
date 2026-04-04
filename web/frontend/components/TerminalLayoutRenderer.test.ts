import { describe, expect, it } from 'vitest'
import { getLayoutRemountKey } from './TerminalLayoutRenderer'

describe('getLayoutRemountKey', () => {
  it('changes when the native pane order changes', () => {
    const firstOrder = getLayoutRemountKey('split-horizontal', [
      {
        type: 'adhoc',
        paneId: 'pane-1',
        sessionId: 'native-1',
        name: 'Ad-Hoc Terminal',
        workingDir: null,
      },
      {
        type: 'adhoc',
        paneId: 'pane-2',
        sessionId: 'native-2',
        name: 'Second Terminal',
        workingDir: null,
      },
    ])
    const swappedOrder = getLayoutRemountKey('split-horizontal', [
      {
        type: 'adhoc',
        paneId: 'pane-2',
        sessionId: 'native-2',
        name: 'Second Terminal',
        workingDir: null,
      },
      {
        type: 'adhoc',
        paneId: 'pane-1',
        sessionId: 'native-1',
        name: 'Ad-Hoc Terminal',
        workingDir: null,
      },
    ])

    expect(swappedOrder).not.toBe(firstOrder)
  })

  it('changes when the external slot set changes', () => {
    const withExternal = getLayoutRemountKey('split-horizontal', [
      {
        type: 'adhoc',
        sessionId: 'codex-agent-hub',
        name: 'codex-agent-hub',
        workingDir: '/workspace/agent-hub',
        isExternal: true,
      },
    ])
    const withoutExternal = getLayoutRemountKey('split-horizontal', [
      {
        type: 'adhoc',
        paneId: 'pane-1',
        sessionId: 'native-1',
        name: 'Ad-Hoc Terminal',
        workingDir: null,
      },
    ])

    expect(withExternal).not.toBe(withoutExternal)
  })
})
