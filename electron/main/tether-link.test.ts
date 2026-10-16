import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionCatalog } from './session-catalog'
import {
  type EventSubscriber,
  followEvents,
  type GuiCommand,
  type GuiVerdict,
  holdGuiChannel,
  type SessionDescriptor,
  type TetherClient,
  type TetherEvent,
  type TetherTool,
  TetherUnavailable,
  type TetherVersion,
} from './tether-client'
import { createTetherLink } from './tether-link'

vi.mock('./tether-client', async (original) => ({
  ...(await original<typeof import('./tether-client')>()),
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

function setup(o: { list?: SessionDescriptor[]; version?: TetherVersion | Error } = {}) {
  const calls: string[] = []
  const tether = {
    socketPath: '/run/test/tether.sock',
    listSessions: vi.fn(async () => o.list ?? []),
    tools: vi.fn(async () => ({ items: [tool('b', 2), tool('a', 1), tool('off', 0, false)] })),
    version: vi.fn(async () => {
      const v = o.version ?? { name: 'tether', version: '1.0.0', apiVersion: 1, minApiVersion: 1 }
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
    retired: vi.fn((id: string, known: SessionDescriptor | undefined, reason: string) =>
      calls.push(`retired ${id} ${known?.ownershipId ?? '-'} ${reason}`),
    ),
    firstList: vi.fn(() => calls.push('firstList')),
    titles: vi.fn(() => calls.push('titles')),
    tray: vi.fn(() => calls.push('tray')),
    connected: vi.fn(() => calls.push('connected')),
    legacyChanged: vi.fn((names: unknown[]) => calls.push(`legacyChanged ${names.join(',')}`)),
  }
  const link = createTetherLink({
    tether: tether as unknown as TetherClient,
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
  it('session.updated with a snapshot upserts, then agent state, titles and tray', () => {
    const { connect, catalog, calls, tether } = setup()
    const subscriber = connect()
    const snapshot = descriptor('aaaaaaaa', { state: 'blocked' })
    subscriber.onEvent(event('session.updated', { id: 'aaaaaaaa', session: snapshot }))
    expect(catalog.get('aaaaaaaa')).toMatchObject({ state: 'blocked' })
    expect(calls).toEqual(['agentState aaaaaaaa', 'titles', 'tray'])
    expect(tether.listSessions).not.toHaveBeenCalled()
  })

  it('without a snapshot it re-lists', async () => {
    const { connect, tether, catalog } = setup({ list: [descriptor('aaaaaaaa')] })
    const subscriber = connect()
    subscriber.onEvent(event('session.created', { id: 'aaaaaaaa' }))
    await vi.waitFor(() => expect(tether.listSessions).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(catalog.get('aaaaaaaa')).toBeDefined())
  })

  it('session.ended runs removed, closeEnded, retired, then tray, and re-lists', async () => {
    const { connect, catalog, calls, tether } = setup()
    catalog.upsert(descriptor('aaaaaaaa'))
    const subscriber = connect()
    subscriber.onEvent(event('session.ended', { id: 'aaaaaaaa' }))
    expect(catalog.get('aaaaaaaa')).toBeUndefined()
    expect(calls.slice(0, 4)).toEqual([
      'removed aaaaaaaa',
      'closeEnded aaaaaaaa',
      'retired aaaaaaaa aico-widget-aaaaaaaa tether_event',
      'tray',
    ])
    await vi.waitFor(() => expect(tether.listSessions).toHaveBeenCalledTimes(1))
  })

  it('passes legacy name changes, tool and project changes through', async () => {
    const { connect, calls, tether, link, projects } = setup()
    const subscriber = connect()
    subscriber.onEvent(event('legacy.changed', { names: ['x', 'y'] }))
    subscriber.onEvent(event('legacy.changed', { names: 'nope' }))
    expect(calls).toEqual(['legacyChanged x,y'])
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

  it('sessionEnded forgets a session nobody knew without a retired record', () => {
    const { link, calls } = setup()
    link.sessionEnded('cccccccc', 'absent')
    expect(calls).toEqual([
      'removed cccccccc',
      'closeEnded cccccccc',
      'retired cccccccc - absent',
      'tray',
    ])
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
      'Tether 9.0.0 (API 9) is not compatible with this Aico. Your sessions keep running. Install a current Tether (scripts/install.sh in the Tether repo) and restart Aico.',
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

  it('stop is safe before connect and stops both streams after', () => {
    const { link, connect, stopEvents, stopGui } = setup()
    link.stop()
    connect()
    link.stop()
    expect(stopEvents).toHaveBeenCalledTimes(1)
    expect(stopGui).toHaveBeenCalledTimes(1)
  })
})
