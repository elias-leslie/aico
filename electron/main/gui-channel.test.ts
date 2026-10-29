import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import {
  createSessionCatalog,
  type GuiMutationCommand,
  type SessionDescriptor,
} from 'tether/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlaceResult } from './compositor'
import { createGuiChannel } from './gui-channel'
import { sessionTitle } from './session-catalog'
import { createWindowChrome } from './window-chrome'
import { createLayoutFile } from './window-layout'
import { WindowRegistry } from './window-registry'

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

const command = (extra: Partial<GuiMutationCommand>): GuiMutationCommand => ({
  commandId: 'c1',
  kind: 'title',
  sessionId: 'aaaaaaaa',
  generation: 'g1',
  ...extra,
})

function setup(o: { listed?: SessionDescriptor[] } = {}) {
  const catalog = createSessionCatalog()
  catalog.upsert(descriptor('aaaaaaaa'))
  const state = { quitting: false }
  const win = { id: 1 } as unknown as BrowserWindow
  const deps = {
    layout: vi.fn(() => ({
      v: 1 as const,
      boundsReliable: true,
      pid: 4242,
      startTime: null,
      updatedAt: 'now',
      displays: [],
      windows: [],
    })),
    isQuitting: () => state.quitting,
    catalog,
    refresh: vi.fn(async () => {
      if (o.listed) catalog.replace(o.listed)
    }),
    ownerOnDesktop: vi.fn(() => true),
    focusOrReopen: vi.fn(),
    reopenIfViewed: vi.fn((_id: string): 'open' | 'reopened' | 'no_view' => 'no_view'),
    forSession: vi.fn((_id: string): BrowserWindow | undefined => undefined),
    arrange: vi.fn(async (): Promise<PlaceResult> => ({ ok: true })),
    canPlace: vi.fn(() => true),
    saveBounds: vi.fn(),
    displayIdFor: vi.fn(() => '7'),
    titles: vi.fn(),
    tray: vi.fn(),
  }
  return { gui: createGuiChannel(deps), deps, catalog, state, win }
}

describe('applyGuiCommand', () => {
  it('reads layout without a session or generation and without mutating views', async () => {
    const { gui, deps, catalog, state } = setup()
    catalog.remove('aaaaaaaa')
    expect(await gui({ commandId: 'layout-1', kind: 'layout' })).toEqual({
      applied: true,
      layout: deps.layout.mock.results[0]?.value,
    })
    expect(deps.refresh).not.toHaveBeenCalled()
    expect(deps.arrange).not.toHaveBeenCalled()
    expect(deps.saveBounds).not.toHaveBeenCalled()
    expect(deps.titles).not.toHaveBeenCalled()
    state.quitting = true
    expect(await gui({ commandId: 'layout-2', kind: 'layout' })).toEqual({
      applied: false,
      error: 'gui_unavailable',
    })
    expect(deps.layout).toHaveBeenCalledTimes(1)
  })

  it('applies a title command and refreshes titles and tray', async () => {
    const { gui, deps, catalog } = setup()
    expect(await gui(command({ kind: 'title', label: 'New' }))).toEqual({ applied: true })
    expect(catalog.get('aaaaaaaa')).toMatchObject({ name: 'New', label: 'New' })
    expect(deps.titles).toHaveBeenCalledTimes(1)
    expect(deps.tray).toHaveBeenCalledTimes(1)
    expect(deps.refresh).not.toHaveBeenCalled()
  })

  it('re-lists once on a generation mismatch, then refuses stale', async () => {
    const { gui, deps, catalog } = setup({ listed: [descriptor('aaaaaaaa', { generation: 'g2' })] })
    expect(await gui(command({ generation: 'g3', label: 'New' }))).toEqual({
      applied: false,
      error: 'stale_generation',
    })
    expect(deps.refresh).toHaveBeenCalledTimes(1)
    expect(catalog.get('aaaaaaaa')?.label).toBe('Session 4')
    expect(deps.titles).not.toHaveBeenCalled()
  })

  it('applies after the re-list finds the generation', async () => {
    const { gui, deps } = setup({ listed: [descriptor('aaaaaaaa', { generation: 'g2' })] })
    expect(await gui(command({ kind: 'show', generation: 'g2' }))).toEqual({ applied: true })
    expect(deps.refresh).toHaveBeenCalledTimes(1)
    expect(deps.focusOrReopen).toHaveBeenCalledWith('aaaaaaaa')
  })

  it('reopens only a viewed session for a check-in, never focusing it', async () => {
    const { gui, deps } = setup()
    expect(await gui(command({ kind: 'show', ifViewed: true }))).toEqual({
      applied: false,
      error: 'no_view',
    })
    deps.reopenIfViewed.mockReturnValue('reopened')
    expect(await gui(command({ kind: 'show', ifViewed: true }))).toEqual({ applied: true })
    expect(deps.focusOrReopen).not.toHaveBeenCalled()
  })

  it('opens, reopens and raises no window while the owner is in the web app', async () => {
    const { gui, deps } = setup()
    deps.ownerOnDesktop.mockReturnValue(false)
    deps.reopenIfViewed.mockReturnValue('reopened')
    for (const show of [command({ kind: 'show' }), command({ kind: 'show', ifViewed: true })])
      expect(await gui(show)).toEqual({ applied: false, error: 'owner_on_web' })
    expect(deps.focusOrReopen).not.toHaveBeenCalled()
    expect(deps.reopenIfViewed).not.toHaveBeenCalled()
    // Titles still apply: they are the session's, not a window's.
    expect(await gui(command({ label: 'Renamed' }))).toEqual({ applied: true })
  })

  it('answers not_found for a session Tether no longer lists, and survives a failed re-list', async () => {
    const { gui, deps } = setup({ listed: [] })
    expect(await gui(command({ sessionId: 'bbbbbbbb' }))).toEqual({
      applied: false,
      error: 'not_found',
    })
    deps.refresh.mockRejectedValueOnce(new Error('down'))
    expect(await gui(command({ sessionId: 'cccccccc' }))).toEqual({
      applied: false,
      error: 'not_found',
    })
  })

  it('refuses while quitting without touching the catalog', async () => {
    const { gui, deps, catalog, state } = setup()
    state.quitting = true
    expect(await gui(command({ label: 'New' }))).toEqual({
      applied: false,
      error: 'gui_unavailable',
    })
    expect(catalog.get('aaaaaaaa')?.label).toBe('Session 4')
    expect(deps.refresh).not.toHaveBeenCalled()
  })

  it('refuses an unknown kind', async () => {
    const { gui } = setup()
    expect(await gui(command({ kind: 'resize' as never }))).toEqual({
      applied: false,
      error: 'invalid_body',
    })
    // A title with no label, or a position with no bounds, is malformed too.
    expect(await gui(command({ kind: 'title' }))).toEqual({ applied: false, error: 'invalid_body' })
    expect(await gui(command({ kind: 'position' }))).toEqual({
      applied: false,
      error: 'invalid_body',
    })
  })

  it('positions an open window, or remembers the place of a closed one', async () => {
    const { gui, deps, win } = setup()
    const bounds = { x: 10, y: 20, width: 800, height: 600 }
    expect(await gui(command({ kind: 'position', bounds }))).toEqual({ applied: true })
    expect(deps.saveBounds).toHaveBeenCalledWith('aaaaaaaa', bounds, '7')
    expect(deps.displayIdFor).toHaveBeenCalledWith(bounds)
    deps.forSession.mockReturnValue(win)
    expect(await gui(command({ kind: 'position', bounds }))).toEqual({ applied: true })
    expect(deps.arrange).toHaveBeenCalledWith(win, bounds)
    expect(deps.saveBounds).toHaveBeenCalledTimes(1)
  })

  it('says so when the compositor cannot place windows, and when a placement fails', async () => {
    const { gui, deps, win } = setup()
    const bounds = { x: 10, y: 20, width: 800, height: 600 }
    deps.canPlace.mockReturnValue(false)
    expect(await gui(command({ kind: 'position', bounds }))).toEqual({
      applied: false,
      error: 'compositor_unavailable',
    })
    expect(deps.arrange).not.toHaveBeenCalled()
    expect(deps.saveBounds).not.toHaveBeenCalled()
    deps.canPlace.mockReturnValue(true)
    deps.forSession.mockReturnValue(win)
    deps.arrange.mockResolvedValueOnce({ ok: false, error: 'placement_unconfirmed' })
    expect(await gui(command({ kind: 'position', bounds }))).toEqual({
      applied: false,
      error: 'placement_unconfirmed',
    })
  })

  it('shows a coordinator mark at once and refreshes titles only', async () => {
    const { gui, deps, catalog } = setup()
    expect(await gui(command({ kind: 'coordinator', coordinator: true }))).toEqual({
      applied: true,
    })
    expect(catalog.get('aaaaaaaa')?.coordinator).toBe(true)
    expect(deps.titles).toHaveBeenCalledTimes(1)
    expect(deps.tray).not.toHaveBeenCalled()
  })
})

describe('a GUI title reaches layout.json', () => {
  let dir: string | undefined
  afterEach(() => {
    vi.useRealTimers()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('within one debounce', async () => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'aico-gui-'))
    const path = join(dir, 'layout.json')
    const win = {
      id: 1,
      isDestroyed: () => false,
      webContents: { send: vi.fn() },
    }
    const windows = [win] as unknown as BrowserWindow[]
    const registry = new WindowRegistry({
      fromId: (id) => windows.find((w) => w.id === id) ?? null,
      fromWebContents: () => null,
      getAllWindows: () => windows,
      getFocusedWindow: () => null,
    })
    registry.bindSession(1, 'aaaaaaaa')
    const catalog = createSessionCatalog()
    catalog.upsert(descriptor('aaaaaaaa'))
    const bounds = { x: 0, y: 0, width: 900, height: 560 }
    const file = createLayoutFile({
      path,
      owner: { pid: 4242, startTime: '777' },
      isReady: () => true,
      isQuitting: () => false,
      collect: () => ({
        boundsReliable: true,
        displays: [],
        windows: ['aaaaaaaa'].map((id) => ({
          id,
          name: sessionTitle(catalog.get(id) ?? descriptor(id)),
          bounds,
          displayId: '1',
          focused: false,
          visible: true,
          minimized: false,
          maximized: false,
          coordinator: false,
        })),
      }),
    })
    const chrome = createWindowChrome({
      registry,
      catalog,
      tools: () => [],
      notice: () => null,
      projects: { list: () => [] },
      attention: { group: () => ({ group: 'idle', state: 'idle', at: null }) },
      layout: { noteCoordinator: vi.fn(), scheduleWrite: file.scheduleWrite },
      contextCheck: async () => null,
      isQuitting: () => false,
      tray: { createTray: vi.fn(), refreshTray: vi.fn(), setWidgetActivity: vi.fn() },
    })
    const gui = createGuiChannel({
      layout: () => null,
      isQuitting: () => false,
      catalog,
      refresh: async () => {},
      ownerOnDesktop: () => true,
      focusOrReopen: vi.fn(),
      reopenIfViewed: vi.fn(() => 'open' as const),
      forSession: registry.forSession,
      arrange: vi.fn(),
      canPlace: () => true,
      saveBounds: vi.fn(),
      displayIdFor: () => '1',
      titles: () => chrome.pushTitles(),
      tray: () => chrome.syncTray(),
    })

    expect(await gui(command({ kind: 'title', label: 'New' }))).toEqual({ applied: true })
    expect(win.webContents.send).toHaveBeenCalledWith(
      'win:title',
      expect.objectContaining({ label: 'New', name: 'New' }),
    )
    vi.advanceTimersByTime(1000)
    expect(JSON.parse(readFileSync(path, 'utf8')).windows[0].name).toBe('New')
  })
})
