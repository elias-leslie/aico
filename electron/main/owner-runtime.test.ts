import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ownershipGeneration, retireOwnedSession } from './owner-retirement'
import {
  headlessRetirementOperations,
  headlessSessionState,
  headlessVerifiedPane,
} from './owner-runtime'
import type { TmuxServerRow, WidgetRow } from './store'
import { serverRosterArgs } from './tmux'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  readFileSync: vi.fn(),
  scopeIdentity: vi.fn(),
  stopOwnedPaneScope: vi.fn(),
  getWidget: vi.fn(),
  getTmuxServer: vi.fn(),
  clearWidgetPendingScope: vi.fn(),
  removeWidgetIfOwnership: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
  execFileSync: mocks.execFileSync,
}))
vi.mock('node:fs', () => ({ readFileSync: mocks.readFileSync }))
vi.mock('./owner-scope', () => ({
  scopeIdentity: mocks.scopeIdentity,
  stopOwnedPaneScope: mocks.stopOwnedPaneScope,
}))
vi.mock('./store', () => ({
  getWidget: mocks.getWidget,
  getTmuxServer: mocks.getTmuxServer,
  clearWidgetPendingScope: mocks.clearWidgetPendingScope,
  removeWidgetIfOwnership: mocks.removeWidgetIfOwnership,
}))

const server: TmuxServerRow = {
  id: '11111111111111111111111111111111',
  kind: 'managed',
  phase: 'active',
  socketPath: '/tmp/aico-owner-runtime-test/server.sock',
  scopeUnit: 'aico-tmux-server-11111111111111111111111111111111.scope',
  controlGroup:
    '/user.slice/user-1000.slice/user@1000.service/app.slice/aico-tmux-server-11111111111111111111111111111111.scope',
  invocationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  serverPid: 1234,
  procStartTime: '987654',
  createdAt: 100,
  deadAt: null,
}

const widget: WidgetRow = {
  id: 'd0e6605d',
  seq: 1,
  bounds: null,
  displayId: null,
  open: false,
  createdAt: 100,
  tool: 'shell',
  name: null,
  projectId: null,
  projectRoot: null,
  externalTmuxSocket: null,
  externalTmuxSession: null,
  tmuxServerId: server.id,
  tmuxAllocationState: 'bound',
  tmuxSessionId: null,
  paneId: '%7',
  sessionId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  scopeUnit: 'aico-pane-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.scope',
  scopeInvocationId: 'cccccccccccccccccccccccccccccccc',
  pendingScopeUnit: null,
  pendingScopeInvocationId: null,
  launchState: 'none',
  launchNonce: null,
  lifecycleVersion: 1,
}

describe('headless owner session state', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.getWidget.mockReturnValue(widget)
    mocks.getTmuxServer.mockReturnValue(server)
    mocks.execFileSync.mockReturnValue('1234\t$3\taico-4369c029\t100\n')
    mocks.readFileSync.mockImplementation((path: string) => {
      if (path === '/proc/1234/stat') {
        return `1234 (tmux: server) ${Array.from({ length: 20 }, (_, index) =>
          index === 19 ? server.procStartTime : '0',
        ).join(' ')}`
      }
      if (path === '/proc/1234/cgroup') return `0::${server.controlGroup}\n`
      throw new Error(`unexpected proc read: ${path}`)
    })
    mocks.scopeIdentity.mockResolvedValue({
      loadState: 'loaded',
      activeState: 'active',
      controlGroup: server.controlGroup,
      invocationId: server.invocationId,
      job: '',
    })
  })

  it('proves a missing-ID session absent from the exact verified server roster', async () => {
    expect(await headlessSessionState(widget.id)).toBe('absent')
    expect(mocks.execFileSync).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/tmux',
      serverRosterArgs(server.socketPath),
      expect.objectContaining({ timeout: 2_000 }),
    )
    expect(mocks.scopeIdentity).toHaveBeenCalledExactlyOnceWith(server.scopeUnit)
  })

  it('preserves a missing-ID session with its exact managed name', async () => {
    mocks.execFileSync.mockReturnValue(`1234\t$3\taico-${widget.id}\t100\n`)
    expect(await headlessSessionState(widget.id)).toBe('present')
  })

  it('ends a reconciled missing-ID session after verified roster absence without killing work', async () => {
    const reconciled = {
      ...widget,
      tmuxSessionId: null,
      paneId: null,
      scopeUnit: null,
      scopeInvocationId: null,
      launchState: 'none' as const,
      launchNonce: null,
    }
    mocks.getWidget.mockReturnValue(reconciled)
    mocks.removeWidgetIfOwnership.mockReturnValue(true)

    expect(await retireOwnedSession(widget.id, headlessRetirementOperations)).toEqual({
      status: 'ended',
    })
    expect(mocks.removeWidgetIfOwnership).toHaveBeenCalledExactlyOnceWith(
      widget.id,
      ownershipGeneration(reconciled),
    )
    expect(mocks.execFileSync).toHaveBeenCalledTimes(3)
    for (const [, args] of mocks.execFileSync.mock.calls) {
      expect(args).toEqual(serverRosterArgs(server.socketPath))
    }
    expect(mocks.execFile).not.toHaveBeenCalled()
    expect(mocks.stopOwnedPaneScope).not.toHaveBeenCalled()
  })

  it('does not match a managed-name prefix', async () => {
    mocks.execFileSync.mockReturnValue(`1234\t$3\taico-${widget.id}-other\t100\n`)
    expect(await headlessSessionState(widget.id)).toBe('absent')
  })

  it.each([
    { id: '$3', name: 'renamed', expected: 'present' },
    { id: '$4', name: `aico-${widget.id}`, expected: 'absent' },
  ])('uses a stored session ID instead of the display name ($expected)', async ({
    id,
    name,
    expected,
  }) => {
    mocks.getWidget.mockReturnValue({ ...widget, tmuxSessionId: '$3' })
    mocks.execFileSync.mockReturnValue(`1234\t${id}\t${name}\t100\n`)
    expect(await headlessSessionState(widget.id)).toBe(expected)
  })

  it.each([
    'aico-d0e6605d',
    'aico-4369c029',
  ])('preserves unknown state for a socket collision with %s', async (name) => {
    mocks.execFileSync.mockReturnValue(`4321\t$3\t${name}\t100\n`)
    expect(await headlessSessionState(widget.id)).toBe('unknown')
  })

  it('preserves an exact live server whose socket is unreachable', async () => {
    mocks.execFileSync.mockImplementation(() => {
      throw Object.assign(new Error('transport failed'), {
        stderr: `no server running on ${server.socketPath}`,
      })
    })
    expect(await headlessSessionState(widget.id)).toBe('unknown')
    expect(mocks.scopeIdentity).toHaveBeenCalledExactlyOnceWith(server.scopeUnit)
  })

  it('requires the exact systemd invocation before interpreting missing-ID absence', async () => {
    mocks.scopeIdentity.mockResolvedValue({
      loadState: 'loaded',
      activeState: 'active',
      controlGroup: server.controlGroup,
      invocationId: 'dddddddddddddddddddddddddddddddd',
      job: '',
    })
    expect(await headlessSessionState(widget.id)).toBe('unknown')
  })

  it('keeps malformed roster evidence unknown', async () => {
    mocks.execFileSync.mockReturnValue('1234\tinvalid-id\taico-4369c029\t100\n')
    expect(await headlessSessionState(widget.id)).toBe('unknown')
  })

  it('does not grant pane verification or stop authority from a name fallback', async () => {
    mocks.execFileSync.mockReturnValue(`1234\t$3\taico-${widget.id}\t100\n`)
    expect(await headlessVerifiedPane(widget)).toBe(false)
    await expect(headlessRetirementOperations.stopTmuxSession(widget)).rejects.toThrow(
      'managed pane identity changed before stop',
    )
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
})
