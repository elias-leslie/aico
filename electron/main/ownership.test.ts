import { describe, expect, it } from 'vitest'
import {
  durableTmuxServerArgs,
  durableTmuxServerUnit,
  isOwnedPaneControlGroup,
  isOwnedPaneScope,
  isOwnedTmuxServerControlGroup,
  isSystemdInvocationId,
  MANAGED_LIFECYCLE_VERSION,
  ownershipEnvironment,
  paneScopeFromCgroup,
  parseScopeResources,
} from './ownership'

describe('session ownership', () => {
  it('stamps stable ownership on every managed pane descendant', () => {
    expect(
      ownershipEnvironment({
        widgetId: 'abc12345',
        sessionId: 'aico-widget-abc12345',
        projectId: 'aico',
        tool: 'codex',
      }),
    ).toEqual({
      AICO_WORKLOAD_CLASS: 'durable-session',
      AICO_OWNER: 'aico',
      AICO_WIDGET_ID: 'abc12345',
      AICO_SESSION_ID: 'aico-widget-abc12345',
      AICO_PROJECT_ID: 'aico',
      AICO_AGENT_SLUG: 'codex',
      AICO_LIFECYCLE_VERSION: String(MANAGED_LIFECYCLE_VERSION),
    })
  })

  it('accepts only the narrow per-pane tmux scope', () => {
    const unit = 'tmux-spawn-2cb113f0-f895-415e-a786-ef5f83db546d.scope'
    expect(
      paneScopeFromCgroup(`0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`),
    ).toBe(unit)
    expect(isOwnedPaneScope(unit)).toBe(true)
    expect(
      paneScopeFromCgroup('0::/user.slice/user-1000.slice/app.slice/app-aico-9189.scope'),
    ).toBe(null)
    expect(isOwnedPaneScope('app-aico-9189.scope')).toBe(false)
    expect(isOwnedPaneScope('org.gnome.Shell@x11.service')).toBe(false)
    expect(isSystemdInvocationId('a385eed9e48d477a9a3bb924a10655f1')).toBe(true)
    expect(isSystemdInvocationId('not-an-invocation')).toBe(false)
    expect(
      isOwnedPaneControlGroup(
        unit,
        `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`,
        1000,
      ),
    ).toBe(true)
    expect(isOwnedPaneControlGroup(unit, `/system.slice/${unit}`, 1000)).toBe(false)
    expect(isOwnedPaneControlGroup(unit, `/user.slice/user-1001.slice/${unit}`, 1000)).toBe(false)
    expect(
      isOwnedTmuxServerControlGroup(
        'aico-tmux-server-abc12345.scope',
        '/user.slice/user-1000.slice/user@1000.service/app.slice/aico-tmux-server-abc12345.scope',
        1000,
      ),
    ).toBe(true)
    expect(
      isOwnedTmuxServerControlGroup(
        'aico-tmux-server-abc12345.service',
        '/user.slice/user-1000.slice/user@1000.service/app.slice/aico-tmux-server-abc12345.service',
        1000,
      ),
    ).toBe(true)
    expect(
      isOwnedTmuxServerControlGroup(
        'aico-tmux-server-abc12345.socket',
        '/user.slice/user-1000.slice/user@1000.service/app.slice/aico-tmux-server-abc12345.socket',
        1000,
      ),
    ).toBe(false)
    expect(
      isOwnedTmuxServerControlGroup(
        'app-aico-9189.scope',
        '/user.slice/user-1000.slice/user@1000.service/app.slice/app-aico-9189.scope',
        1000,
      ),
    ).toBe(false)
  })

  it('builds a manager-spawned durable tmux-server service for first creation', () => {
    expect(durableTmuxServerUnit('abc12345')).toBe('aico-tmux-server-abc12345.service')
    expect(durableTmuxServerArgs('abc12345', ['-L', 'aico', 'new-session'])).toEqual([
      '--user',
      '--quiet',
      '--collect',
      '--unit=aico-tmux-server-abc12345.service',
      '--slice=app.slice',
      '--description=Aico durable tmux server (abc12345)',
      '--service-type=exec',
      '--expand-environment=no',
      '--property=ExitType=cgroup',
      '--property=StandardInput=null',
      '--property=StandardOutput=journal',
      '--property=StandardError=journal',
      '--property=CPUAccounting=yes',
      '--property=MemoryAccounting=yes',
      '--property=TasksAccounting=yes',
      '--setenv=AICO_OWNER=aico',
      '--setenv=AICO_WORKLOAD_CLASS=durable-tmux-server',
      '--setenv=AICO_TMUX_SERVER_ID=abc12345',
      '--',
      '/usr/bin/tmux',
      '-L',
      'aico',
      'new-session',
    ])
    expect(() => durableTmuxServerArgs('../../user', [])).toThrow(
      /unsafe tmux server generation id/,
    )
    expect(() => durableTmuxServerUnit('../../user')).toThrow(/unsafe tmux server generation id/)
  })

  it('parses resource counters and derives scope age from monotonic time', () => {
    expect(
      parseScopeResources(
        [
          'ActiveState=active',
          'ControlGroup=/user.slice/example.scope',
          'CPUUsageNSec=3000000000',
          'MemoryCurrent=2048',
          'MemoryPeak=4096',
          'MemorySwapCurrent=128',
          'MemorySwapPeak=256',
          'TasksCurrent=7',
          'ActiveEnterTimestampMonotonic=10000000',
        ].join('\n'),
        25,
      ),
    ).toEqual({
      activeState: 'active',
      controlGroup: '/user.slice/example.scope',
      cpuUsageNSec: 3_000_000_000,
      memoryCurrent: 2048,
      memoryPeak: 4096,
      swapCurrent: 128,
      swapPeak: 256,
      tasksCurrent: 7,
      ageSeconds: 15,
    })
  })
})
