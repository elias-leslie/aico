import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionCatalog } from './catalog'
import { type EventSubscriber, followEvents, holdGuiChannel, type TetherClient } from './client'
import {
  type GuiCommand,
  type GuiVerdict,
  type SessionDescriptor,
  type TetherEvent,
  type TetherTool,
  TetherUnavailable,
  type TetherVersion,
} from './contracts'
import { coalesceAsync, createTetherLink } from './link'

vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  followEvents: vi.fn(),
  holdGuiChannel: vi.fn(),
}))

const follow = vi.mocked(followEvents)
const hold = vi.mocked(holdGuiChannel)

function descriptor(id: string, extra: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id,
    ownershipId: `aico-widget-${id}`,
    generation: 'g1',
    status: 'running',
    available: true,
    tool: 'shell',
    name: null,
    label: 'Session 4',
    projectId: null,
    projectRoot: null,
    origin: 'aico',
    rootRequestId: null,
    lifecycleVersion: 1,
    tmux: {
      serverId: null,
      socket: null,
      sessionId: '$1',
      paneId: '%1',
      sessionName: `aico-${id}`,
    },
    createdAt: 1,
    ...extra,
  }
}

const tool = (slug: string, displayOrder: number, enabled = true): TetherTool => ({
  slug,
  name: slug.toUpperCase(),
  color: null,
  displayOrder,
  isDefault: false,
  enabled,
})

const event = (type: string, data: Record<string, unknown> = {}): TetherEvent => ({
  seq: 1,
  bootId: 'b',
  type,
  at: 0,
  data,
})

function setup(
  o: {
    list?: SessionDescriptor[]
    version?: TetherVersion | Error
    other?: TetherClient
    activeSocket?: string
    shareSocket?: string
  } = {},
) {
  const calls: string[] = []
  const tether = {
    socketPath: o.activeSocket ?? '/run/test/tether.sock',
    instances: (): unknown[] => (o.other ? [tether, o.other] : [tether]),
    listSessions: vi.fn(async () => o.list ?? []),
    tools: vi.fn(async () => ({ items: [tool('b', 2), tool('a', 1), tool('off', 0, false)] })),
    version: vi.fn(async () => {
      const v = o.version ?? { name: 'tether', version: '1.0.0', apiVersion: 3, minApiVersion: 1 }
      if (v instanceof Error) throw v
      return v
    }),
  }
  const catalog = createSessionCatalog()
  const projects = {
    invalidate: vi.fn(() => calls.push('projects.invalidate')),
    refresh: vi.fn(async () => {
      calls.push('projects.refresh')
    }),
  }
  const dialog = { showErrorBox: vi.fn() }
  const hooks = {
    agentState: vi.fn((d: SessionDescriptor) => calls.push(`agentState ${d.id}`)),
    removed: vi.fn((id: string) => calls.push(`removed ${id}`)),
    destroyWindow: vi.fn((id: string) => calls.push(`destroyWindow ${id}`)),
    closeEnded: vi.fn((id: string) => calls.push(`closeEnded ${id}`)),
    retired: vi.fn((id: string) => calls.push(`retired ${id}`)),
    firstList: vi.fn(() => calls.push('firstList')),
    titles: vi.fn(() => calls.push('titles')),
    tray: vi.fn(() => calls.push('tray')),
    connected: vi.fn(() => calls.push('connected')),
    shared: vi.fn(),
    sizeHeld: vi.fn(),
  }
  const link = createTetherLink({
    tether: tether as unknown as TetherClient,
    shareSocket: o.shareSocket ?? '/run/test/default.sock',
    catalog,
    projects,
    dialog,
    hooks,
  })
  const stopEvents = vi.fn()
  const stopGui = vi.fn()
  follow.mockReturnValue(stopEvents)
  hold.mockReturnValue(stopGui)
  const apply = vi.fn(async (_c: GuiCommand): Promise<GuiVerdict> => ({ applied: true }))
  const connect = (): EventSubscriber => {
    link.connect(apply)
    return follow.mock.calls.at(-1)?.[1] as EventSubscriber
  }
  return {
    link,
    tether,
    catalog,
    projects,
    dialog,
    hooks,
    calls,
    connect,
    stopEvents,
    stopGui,
    apply,
  }
}

beforeEach(() => {
  follow.mockReset()
  hold.mockReset()
})

describe('Tether events', () => {
  it.each([false, true])('accepts handoffs only from tether@default (active=%s)', (active) => {
    const shareSocket = '/run/test/default.sock'
    const agentSocket = '/run/user/1000/tether/dev/control.sock'
    const { link, apply, hooks } = setup({
      activeSocket: active ? shareSocket : agentSocket,
      other: { socketPath: active ? agentSocket : shareSocket } as TetherClient,
      shareSocket,
    })
    link.connect(apply)
    const data = { id: 'aabbccddeeff', kind: 'url', name: 'https://example.com' }
    for (const [client, subscriber] of follow.mock.calls) {
      subscriber.onEvent(event('show.requested', data))
      expect(hooks.shared).toHaveBeenCalledTimes(
        client.socketPath === shareSocket ? 1 : active ? 1 : 0,
      )
    }
    expect(hooks.shared).toHaveBeenCalledExactlyOnceWith(data)
  })

  it('ignores a handoff from an unrelated active socket', () => {
    const { connect, hooks } = setup({ activeSocket: '/custom/unrelated.sock' })
    connect().onEvent(event('show.requested', { kind: 'file' }))
    expect(hooks.shared).not.toHaveBeenCalled()
  })

  it('session.updated with a snapshot upserts, then agent state, titles and tray', () => {
    const { connect, catalog, calls, tether } = setup()
    const subscriber = connect()
    const snapshot = descriptor('aaaaaaaa', { state: 'blocked' })
    subscriber.onEvent(event('session.updated', { id: 'aaaaaaaa', session: snapshot }))
    expect(catalog.get('aaaaaaaa')).toMatchObject({ state: 'blocked' })
    expect(calls).toEqual(['agentState aaaaaaaa', 'titles', 'tray'])
    expect(tether.listSessions).not.toHaveBeenCalled()
  })

  it('session.resized hands the size holder to the window; one without a holder is ignored', () => {
    const { connect, hooks } = setup()
    const subscriber = connect()
    subscriber.onEvent(event('session.resized', { id: 'aaaaaaaa', generation: 'g1' }))
    expect(hooks.sizeHeld).not.toHaveBeenCalled()
    subscriber.onEvent(event('session.resized', { id: 'aaaaaaaa', clientPid: 4242, cols: 40 }))
    expect(hooks.sizeHeld).toHaveBeenCalledExactlyOnceWith('aaaaaaaa', 4242, null)
    const viewer = { app: 'web', device: 'Pixel 9' }
    subscriber.onEvent(event('session.resized', { id: 'aaaaaaaa', clientPid: 7, viewer }))
    expect(hooks.sizeHeld).toHaveBeenLastCalledWith('aaaaaaaa', 7, viewer)
    subscriber.onEvent(
      event('session.resized', { id: 'aaaaaaaa', clientPid: 8, viewer: { app: 1 } }),
    )
    expect(hooks.sizeHeld).toHaveBeenLastCalledWith('aaaaaaaa', 8, null)
  })

  it('without a snapshot it re-lists', async () => {
    const { connect, tether, catalog } = setup({ list: [descriptor('aaaaaaaa')] })
    const subscriber = connect()
    subscriber.onEvent(event('session.created', { id: 'aaaaaaaa' }))
    await vi.waitFor(() => expect(tether.listSessions).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(catalog.get('aaaaaaaa')).toBeDefined())
  })

  it('session.ended runs removed, closeEnded, retired, then tray, journals it, and re-lists', async () => {
    const { connect, catalog, calls, tether } = setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    catalog.upsert(descriptor('aaaaaaaa'))
    const subscriber = connect()
    log.mockClear()
    subscriber.onEvent(event('session.ended', { id: 'aaaaaaaa' }))
    expect(catalog.get('aaaaaaaa')).toBeUndefined()
    expect(calls.slice(0, 4)).toEqual([
      'removed aaaaaaaa',
      'closeEnded aaaaaaaa',
      'retired aaaaaaaa',
      'tray',
    ])
    expect(log).toHaveBeenCalledWith(
      '[aico:event] lifecycle_retired widget=aaaaaaaa session=aico-widget-aaaaaaaa reason=tether_event',
    )
    log.mockRestore()
    await vi.waitFor(() => expect(tether.listSessions).toHaveBeenCalledTimes(1))
  })

  it('ignores legacy name changes and passes tool and project changes through', async () => {
    const { connect, calls, tether, link, projects } = setup()
    const subscriber = connect()
    subscriber.onEvent(event('legacy.changed', { names: ['x', 'y'] }))
    expect(calls).toEqual([])
    subscriber.onEvent(event('tools.changed'))
    await vi.waitFor(() => expect(link.tools().map((t) => t.slug)).toEqual(['a', 'b']))
    expect(tether.tools).toHaveBeenCalledTimes(1)
    subscriber.onEvent(event('projects.changed'))
    expect(projects.invalidate).toHaveBeenCalledTimes(1)
    expect(projects.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('refresh', () => {
  it('the first complete list restores windows once; a gone session closes its window', async () => {
    const { link, catalog, calls, tether } = setup({ list: [descriptor('aaaaaaaa')] })
    tether.listSessions.mockResolvedValueOnce([descriptor('aaaaaaaa'), descriptor('bbbbbbbb')])
    await link.refresh()
    expect(calls).toEqual([
      'agentState aaaaaaaa',
      'agentState bbbbbbbb',
      'firstList',
      'titles',
      'tray',
    ])
    calls.length = 0
    await link.refresh()
    expect(calls).toEqual([
      'removed bbbbbbbb',
      'agentState aaaaaaaa',
      'destroyWindow bbbbbbbb',
      'titles',
      'tray',
    ])
    expect(catalog.get('bbbbbbbb')).toBeUndefined()
    expect(tether.listSessions).toHaveBeenCalledTimes(2)
  })

  it('callers share one in-flight list', async () => {
    const { link, tether } = setup()
    await Promise.all([link.refresh(), link.refresh(), link.refresh()])
    expect(tether.listSessions).toHaveBeenCalledTimes(1)
  })

  it('requestRefresh swallows an unreachable Tether quietly', async () => {
    const { link, tether } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    tether.listSessions.mockRejectedValueOnce(new TetherUnavailable('down'))
    link.requestRefresh()
    await vi.waitFor(() => expect(tether.listSessions).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(warn).not.toHaveBeenCalled()
    tether.listSessions.mockRejectedValueOnce(new Error('boom'))
    link.requestRefresh()
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[aico] session refresh failed:', expect.any(Error)),
    )
    warn.mockRestore()
  })

  it('sessionEnded forgets a session nobody knew without a journal line', () => {
    const { link, calls } = setup()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    link.sessionEnded('cccccccc', 'absent')
    expect(calls).toEqual(['removed cccccccc', 'closeEnded cccccccc', 'retired cccccccc', 'tray'])
    expect(log).not.toHaveBeenCalled()
    log.mockRestore()
  })
})

describe('connection', () => {
  it('connects once per reconnect and holds the GUI channel with the given handler', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { connect, hooks, apply, tether, projects, link } = setup()
    expect(link.notice()).toBe('Tether is not reachable. Sessions keep running.')
    const subscriber = connect()
    expect(hold).toHaveBeenCalledWith(tether, apply, expect.any(Function))
    subscriber.onConnected?.()
    subscriber.onConnected?.() // still connected: nothing new
    expect(hooks.connected).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[aico:tether] connected at /run/test/tether.sock')
    expect(projects.refresh).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(tether.version).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(tether.tools).toHaveBeenCalledTimes(1))
    expect(link.notice()).toBeNull()

    subscriber.onDisconnected?.(new Error('gone'))
    expect(warn).toHaveBeenCalledWith('[aico:tether] event stream lost:', expect.any(Error))
    expect(hooks.tray).toHaveBeenCalled()
    expect(link.notice()).toBe('Tether is not reachable. Sessions keep running.')
    subscriber.onConnected?.()
    expect(hooks.connected).toHaveBeenCalledTimes(2)

    // The GUI channel's log lines keep their wording.
    const gui = hold.mock.calls[0]?.[2] as (m: string, e?: unknown) => void
    gui('connected')
    gui('channel lost', new Error('reset'))
    expect(log).toHaveBeenCalledWith('[aico:gui] connected')
    expect(warn).toHaveBeenCalledWith('[aico:gui] channel lost:', 'reset')
    log.mockRestore()
    warn.mockRestore()
  })

  it('an incompatible Tether stops events and the GUI channel and says so', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { connect, stopEvents, stopGui, dialog, link, hooks } = setup({
      version: { name: 'tether', version: '9.0.0', apiVersion: 9, minApiVersion: 9 },
    })
    connect().onConnected?.()
    await vi.waitFor(() => expect(dialog.showErrorBox).toHaveBeenCalledTimes(1))
    expect(stopEvents).toHaveBeenCalledTimes(1)
    expect(stopGui).toHaveBeenCalledTimes(1)
    expect(hooks.tray).toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      '[aico:tether] Tether 9.0.0 (API 9) is not compatible with this Aico; session control is disabled',
    )
    expect(dialog.showErrorBox).toHaveBeenCalledWith(
      'Update Tether',
      'Tether 9.0.0 (API 9) is not compatible with this Aico. Your sessions keep running. Update Aico (scripts/install.sh) and restart it.',
    )
    expect(link.notice()).toBe(
      'Tether 9.0.0 (API 9) is not compatible with this Aico. Sessions keep running.',
    )
    vi.restoreAllMocks()
  })

  it('an unreachable Tether during the version check is not an incompatibility', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { connect, dialog, tether } = setup({ version: new TetherUnavailable('down') })
    connect().onConnected?.()
    await vi.waitFor(() => expect(tether.version).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(dialog.showErrorBox).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })

  it('follows the other instance too: its sessions join the catalog, its outage is quiet, stop stops all', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const other = { socketPath: '/run/test/agent.sock' } as TetherClient
    const { link, tether, catalog, hooks, apply, stopEvents, stopGui, projects } = setup({ other })
    link.connect(apply)
    expect(follow).toHaveBeenCalledTimes(2)
    expect(follow.mock.calls[0]?.[0]).toBe(tether)
    expect(follow.mock.calls[1]?.[0]).toBe(other)
    expect(hold.mock.calls.map((call) => call[0])).toEqual([tether, other])
    const second = follow.mock.calls[1]?.[1] as EventSubscriber
    second.onDisconnected?.(new Error('no agent tether')) // never connected: nothing to say
    expect(warn).not.toHaveBeenCalled()
    second.onConnected?.()
    expect(hooks.connected).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[aico:tether] also connected at /run/test/agent.sock')
    second.onEvent({
      seq: 2,
      bootId: 'b',
      type: 'session.created',
      at: 0,
      data: { id: 'bbbbbbbb', session: descriptor('bbbbbbbb') },
    })
    expect(catalog.get('bbbbbbbb')).toBeDefined()
    second.onEvent(event('projects.changed'))
    expect(projects.invalidate).not.toHaveBeenCalled()
    link.stop()
    expect(stopEvents).toHaveBeenCalledTimes(2) // one stop per instance
    expect(stopGui).toHaveBeenCalledTimes(2)
    log.mockRestore()
    warn.mockRestore()
  })

  it('stop is safe before connect and stops both streams after', () => {
    const { link, connect, stopEvents, stopGui } = setup()
    link.stop()
    connect()
    link.stop()
    expect(stopEvents).toHaveBeenCalledTimes(1)
    expect(stopGui).toHaveBeenCalledTimes(1)
  })
})

describe('coalescing', () => {
  it('shares one pending load and starts a fresh one afterwards', async () => {
    const load = vi.fn(async () => 1)
    const run = coalesceAsync(load)
    await Promise.all([run(), run()])
    await run()
    expect(load).toHaveBeenCalledTimes(2)
  })
})
