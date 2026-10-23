import type { BrowserWindow } from 'electron'
import {
  type ContextHook,
  createSessionCatalog,
  type SessionDescriptor,
  type TetherTool,
} from 'tether/client'
import { describe, expect, it, vi } from 'vitest'
import { createWindowChrome } from './window-chrome'
import { WindowRegistry } from './window-registry'

type Send = ReturnType<typeof vi.fn>

function fakeWindow(id: number) {
  let destroyed = false
  return {
    id,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    webContents: { send: vi.fn() as Send },
  }
}
type FakeWindow = ReturnType<typeof fakeWindow>

function descriptor(id: string, extra: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    id,
    ownershipId: `aico-widget-${id}`,
    generation: 'g1',
    status: 'running',
    available: true,
    tool: 'codex',
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

const codex: TetherTool = {
  slug: 'codex',
  name: 'Codex',
  color: null,
  displayOrder: 1,
  isDefault: false,
  enabled: true,
}

function setup(o: { windows?: FakeWindow[]; quitting?: boolean } = {}) {
  const windows = o.windows ?? []
  const registry = new WindowRegistry({
    fromId: (id) => (windows.find((w) => w.id === id) ?? null) as unknown as BrowserWindow | null,
    fromWebContents: (wc) =>
      (windows.find((w) => w.webContents === (wc as unknown)) ??
        null) as unknown as BrowserWindow | null,
    getAllWindows: () => windows as unknown as BrowserWindow[],
    getFocusedWindow: () => null,
  })
  const catalog = createSessionCatalog()
  const layout = { scheduleWrite: vi.fn(), noteCoordinator: vi.fn() }
  const tray = { createTray: vi.fn(), refreshTray: vi.fn(), setWidgetActivity: vi.fn() }
  const groups: Record<string, 'needs-you'> = {}
  const state = { quitting: o.quitting ?? false, tools: [codex], notice: null as string | null }
  const contextCheck = vi.fn(async (_id: string): Promise<ContextHook | null> => null)
  const chrome = createWindowChrome({
    registry,
    catalog,
    tools: () => state.tools,
    notice: () => state.notice,
    projects: { list: () => [{ id: 'p1', name: 'Docs', root: '/srv/docs', current: false }] },
    attention: {
      group: (id) =>
        groups[id] === 'needs-you'
          ? { group: 'needs-you', state: 'blocked', at: 400 }
          : { group: 'idle', state: 'idle', at: null },
    },
    layout,
    contextCheck,
    isQuitting: () => state.quitting,
    tray,
    now: () => 1_000,
  })
  return { chrome, registry, catalog, layout, tray, state, groups, contextCheck }
}

const asWin = (w: FakeWindow) => w as unknown as BrowserWindow

describe('pushTitles', () => {
  it('pushes every session window its title and schedules one layout write', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const { chrome, registry, catalog, layout } = setup({ windows: [win1, win2] })
    registry.bindSession(1, 'aaaaaaaa')
    catalog.upsert(descriptor('aaaaaaaa', { name: 'Docs', label: 'Docs' }))

    chrome.pushTitles()

    expect(win1.webContents.send).toHaveBeenCalledWith('win:title', {
      label: 'Docs',
      name: 'Docs',
      icon: expect.any(String),
      accent: expect.any(String),
      tuiName: 'Codex',
      tuiSlug: 'codex',
      sessionId: '$1',
      coordinator: false,
      chip: null,
    })
    // Window 2 has no session yet (Tether is still creating it): no title.
    expect(win2.webContents.send).not.toHaveBeenCalledWith('win:title', expect.anything())
    expect(layout.noteCoordinator).toHaveBeenCalledTimes(1)
    expect(layout.noteCoordinator).toHaveBeenCalledWith(win1, false)
    expect(layout.scheduleWrite).toHaveBeenCalledTimes(1)
  })

  it('schedules the write even with no windows', () => {
    const { chrome, layout } = setup()
    chrome.pushTitles()
    expect(layout.scheduleWrite).toHaveBeenCalledTimes(1)
  })

  it('skips destroyed windows and windows whose session is not in the catalog', () => {
    const gone = fakeWindow(1)
    const unknown = fakeWindow(2)
    const { chrome, registry, catalog, layout } = setup({ windows: [gone, unknown] })
    registry.bindSession(1, 'aaaaaaaa')
    registry.bindSession(2, 'bbbbbbbb')
    catalog.upsert(descriptor('aaaaaaaa'))
    gone.destroy()
    chrome.pushTitles()
    expect(gone.webContents.send).not.toHaveBeenCalled()
    expect(unknown.webContents.send).not.toHaveBeenCalled()
    expect(layout.noteCoordinator).not.toHaveBeenCalled()
    expect(layout.scheduleWrite).toHaveBeenCalledTimes(1)
  })

  it('shows the coordinator mark and Tether chip and tells the tiler', () => {
    const win = fakeWindow(1)
    const { chrome, registry, catalog, layout } = setup({ windows: [win] })
    registry.bindSession(1, 'aaaaaaaa')
    const badge = { kind: 'coordinator' as const, text: 'Coordinator', color: '#123456' }
    catalog.upsert(descriptor('aaaaaaaa', { coordinator: true, badge }))
    chrome.pushTitles()
    expect(win.webContents.send).toHaveBeenCalledWith(
      'win:title',
      expect.objectContaining({
        coordinator: true,
        chip: { text: 'Coordinator', color: '#123456' },
      }),
    )
    expect(layout.noteCoordinator).toHaveBeenCalledWith(win, true)
  })
})

describe('context badge', () => {
  const hook = (state: string, tool = 'codex', detail = ''): ContextHook => ({
    state,
    tool,
    detail,
    applicable: true,
    checkedAt: null,
  })
  const badges = (win: FakeWindow) =>
    win.webContents.send.mock.calls.filter(([channel]) => channel === 'context:mandate')

  it('is sent once per change', () => {
    const win = fakeWindow(1)
    const { chrome, registry, catalog } = setup({ windows: [win] })
    registry.bindSession(1, 'aaaaaaaa')
    catalog.upsert(descriptor('aaaaaaaa', { contextHook: hook('available') }))
    chrome.pushTitles()
    chrome.pushTitles()
    expect(badges(win)).toEqual([
      ['context:mandate', { slug: 'codex', state: 'available', detail: '', applicable: true }],
    ])
    catalog.upsert(descriptor('aaaaaaaa', { contextHook: hook('missing', 'codex', 'no AGENTS') }))
    chrome.pushTitles()
    expect(badges(win)).toHaveLength(2)
  })

  it('an unknown state keeps a same-tool badge and hides another tool’s', () => {
    const win = fakeWindow(1)
    const { chrome, registry, catalog } = setup({ windows: [win] })
    registry.bindSession(1, 'aaaaaaaa')
    // Nothing shown yet: an unknown check shows nothing.
    catalog.upsert(descriptor('aaaaaaaa', { contextHook: hook('unknown') }))
    chrome.pushTitles()
    expect(badges(win)).toHaveLength(0)
    catalog.upsert(descriptor('aaaaaaaa', { contextHook: hook('available') }))
    chrome.pushTitles()
    catalog.upsert(descriptor('aaaaaaaa', { contextHook: hook('unknown') }))
    chrome.pushTitles()
    expect(badges(win)).toHaveLength(1) // same tool: the badge stays
    catalog.upsert(descriptor('aaaaaaaa', { contextHook: hook('unknown', 'claude') }))
    chrome.pushTitles()
    expect(badges(win).at(-1)).toEqual([
      'context:mandate',
      { slug: 'claude', state: 'unknown', detail: '', applicable: false },
    ])
  })

  it('on load resends the known badge and stores Tether’s fresh check', async () => {
    const win = fakeWindow(1)
    const { chrome, registry, catalog, contextCheck } = setup({ windows: [win] })
    registry.bindSession(1, 'aaaaaaaa')
    catalog.upsert(descriptor('aaaaaaaa', { contextHook: hook('available') }))
    chrome.pushTitles()
    contextCheck.mockResolvedValueOnce(hook('missing', 'codex', 'no AGENTS'))
    chrome.refreshContextBadge(asWin(win))
    expect(badges(win)).toHaveLength(2) // reload forgot what it showed: shown again
    expect(contextCheck).toHaveBeenCalledWith('aaaaaaaa')
    await vi.waitFor(() => expect(badges(win)).toHaveLength(3))
    expect(catalog.get('aaaaaaaa')?.contextHook?.state).toBe('missing')
  })

  it('forget drops the window’s badge and thinking mark', () => {
    const win = fakeWindow(1)
    const { chrome, registry, catalog, tray } = setup({ windows: [win] })
    registry.bindSession(1, 'aaaaaaaa')
    catalog.upsert(descriptor('aaaaaaaa', { contextHook: hook('available') }))
    chrome.pushTitles()
    chrome.forget(1)
    expect(tray.setWidgetActivity).toHaveBeenCalledWith(1, false)
    chrome.pushTitles()
    expect(badges(win)).toHaveLength(2)
  })
})

describe('tray', () => {
  it('lists sessions grouped, with tools, workspaces and the Tether notice', () => {
    const win = fakeWindow(1)
    const { chrome, registry, catalog, tray, state, groups } = setup({ windows: [win] })
    registry.bindSession(1, 'aaaaaaaa')
    catalog.upsert(descriptor('aaaaaaaa', { label: 'Docs' }))
    catalog.upsert(descriptor('bbbbbbbb', { label: 'Site', tool: 'shell', createdAt: 2 }))
    groups.bbbbbbbb = 'needs-you'
    state.notice = 'Tether is not reachable. Sessions keep running.'
    chrome.syncTray()
    expect(tray.refreshTray).toHaveBeenCalledWith(
      [
        {
          id: 'bbbbbbbb',
          label: 'Site · Shell',
          open: false,
          group: 'needs-you',
          detail: 'waiting <1m',
        },
        { id: 'aaaaaaaa', label: 'Docs · Codex', open: true, group: 'idle', detail: 'idle' },
      ],
      [{ slug: 'codex', label: 'Codex' }],
      [{ id: 'p1', name: 'Docs', root: '/srv/docs', current: false }],
      'Tether is not reachable. Sessions keep running.',
    )
  })

  it('does nothing while quitting', () => {
    const { chrome, tray } = setup({ quitting: true })
    chrome.syncTray()
    expect(tray.refreshTray).not.toHaveBeenCalled()
  })

  it('creates the tray with the handlers, tools and workspaces', () => {
    const { chrome, tray } = setup()
    const handlers = {
      onSelect: vi.fn(),
      onDiscard: vi.fn(),
      onNewWidget: vi.fn(),
      onRefreshSessions: vi.fn(),
      onHubView: vi.fn(),
    }
    chrome.createTray(handlers)
    expect(tray.createTray).toHaveBeenCalledWith(
      handlers,
      [{ slug: 'codex', label: 'Codex' }],
      [{ id: 'p1', name: 'Docs', root: '/srv/docs', current: false }],
    )
  })

  it('win:thinking marks the sender window busy', () => {
    const win = fakeWindow(7)
    const { chrome, tray } = setup({ windows: [win] })
    const on = new Map<string, (...args: unknown[]) => void>()
    chrome.registerIpc({
      on: (channel: string, fn: (...args: unknown[]) => void) => {
        on.set(channel, fn)
      },
    } as never)
    on.get('win:thinking')?.({ sender: win.webContents }, true)
    on.get('win:thinking')?.({ sender: {} }, true) // not a window: ignored
    expect(tray.setWidgetActivity.mock.calls).toEqual([[7, true]])
  })
})
