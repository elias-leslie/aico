import type { BrowserWindow } from 'electron'
import {
  createSessionCatalog,
  type SessionDescriptor,
  TetherError,
  type TetherTool,
} from 'tether/client'
import { describe, expect, it, vi } from 'vitest'
import { PERSONAL_WORKSPACE_ID } from './project'
import { createSessionActions } from './session-actions'
import { WindowRegistry } from './window-registry'

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

function fakeWindow(id: number) {
  return { id, isDestroyed: () => false, webContents: { send: vi.fn() } }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const notFound = () => new TetherError(404, 'not_found', {})

function setup() {
  const win = fakeWindow(1)
  const all = [win]
  const registry = new WindowRegistry({
    fromId: (id) => (all.find((w) => w.id === id) ?? null) as unknown as BrowserWindow | null,
    fromWebContents: (wc) =>
      (all.find((w) => w.webContents === (wc as unknown)) ??
        null) as unknown as BrowserWindow | null,
    getAllWindows: () => all as unknown as BrowserWindow[],
    getFocusedWindow: () => null,
  })
  registry.bindSession(1, 'aaaaaaaa')
  const catalog = createSessionCatalog()
  catalog.upsert(descriptor('aaaaaaaa'))
  const tether = {
    getSession: vi.fn(async (id: string) => descriptor(id)),
    end: vi.fn(async (_id: string, _generation: string) => {}),
    setCoordinator: vi.fn(async () => ({})),
    loadTui: vi.fn(async (id: string) => descriptor(id, { tool: 'claude' })),
    switchProject: vi.fn(async (id: string) => descriptor(id)),
    rename: vi.fn(async (id: string, _g: string, name: string | null) => descriptor(id, { name })),
    diagnostics: vi.fn(async (id: string) => ({ sessionId: id })),
    sessionWakes: vi.fn(async () => ({
      items: [],
      policy: { laterMinutes: 60, tonightHour: 21, morningHour: 8 },
    })),
    addWake: vi.fn(async (_id: string, input: { dueAt: number }) => ({
      id: '5f1c0a9b2e7d',
      dueAt: input.dueAt,
    })),
    cancelWake: vi.fn(async () => ({ deleted: true })),
  }
  const link = {
    tools: () => [codex],
    refresh: vi.fn(async () => {}),
    requestRefresh: vi.fn(),
    refreshTools: vi.fn(async () => {}),
    sessionEnded: vi.fn(),
  }
  const windows = {
    openNew: vi.fn(),
    showAll: vi.fn(),
    focusOrReopen: vi.fn(),
  }
  const titles = vi.fn()
  const tray = vi.fn()
  const dialog = { showMessageBox: vi.fn(async () => ({ response: 1 })) }
  const workspace = { root: null as string | null }
  const sessions = createSessionActions({
    tether: tether as never,
    catalog,
    link,
    registry,
    windows,
    projects: { listFresh: async () => [], nameFor: () => 'Docs' },
    titles,
    tray,
    dialog,
    personalWorkspace: { ensureRoot: () => workspace.root, root: () => '/home/o/Personal' },
  })
  const on = new Map<string, (...args: unknown[]) => unknown>()
  const handle = new Map<string, (...args: unknown[]) => unknown>()
  sessions.registerIpc({
    on: ((channel: string, fn: (...args: unknown[]) => unknown) => {
      on.set(channel, fn)
    }) as never,
    handle: ((channel: string, fn: (...args: unknown[]) => unknown) => {
      handle.set(channel, fn)
    }) as never,
  })
  const event = { sender: win.webContents }
  return {
    sessions,
    tether,
    link,
    windows,
    catalog,
    win,
    titles,
    tray,
    dialog,
    workspace,
    on,
    handle,
    event,
  }
}

describe('session actions', () => {
  it('registers its fifteen channels', () => {
    const { on, handle } = setup()
    expect([...on.keys()].sort()).toEqual([
      'widget:hub',
      'widget:load-tui',
      'widget:new',
      'widget:set-name',
      'widget:switch-project',
      'widget:toggle-coordinator',
    ])
    expect([...handle.keys()].sort()).toEqual([
      'project:list',
      'session:cancel-check-in',
      'session:check-in',
      'session:check-in-menu',
      'session:diagnostics',
      'session:end-self',
      'session:list-openable',
      'session:open',
      'tui:list',
    ])
  })

  it('shares one Tether End between concurrent requests for a session', async () => {
    const { sessions, tether, link } = setup()
    const ending = deferred<void>()
    tether.end.mockReturnValueOnce(ending.promise)
    const first = sessions.end('aaaaaaaa')
    const second = sessions.end('aaaaaaaa')
    expect(second).toBe(first)
    await vi.waitFor(() => expect(tether.end).toHaveBeenCalledTimes(1))
    ending.resolve()
    await first
    expect(tether.getSession).toHaveBeenCalledTimes(1)
    expect(link.sessionEnded).toHaveBeenCalledWith('aaaaaaaa', 'ended')
    // Settled: the next End is a fresh attempt.
    await sessions.end('aaaaaaaa')
    expect(tether.end).toHaveBeenCalledTimes(2)
  })

  it('treats a session Tether no longer has as ended (absent), on read or on End', async () => {
    const { sessions, tether, link } = setup()
    tether.getSession.mockRejectedValueOnce(notFound())
    await sessions.end('aaaaaaaa')
    expect(tether.end).not.toHaveBeenCalled()
    expect(link.sessionEnded).toHaveBeenLastCalledWith('aaaaaaaa', 'absent')
    tether.end.mockRejectedValueOnce(notFound())
    await sessions.end('aaaaaaaa')
    expect(link.sessionEnded).toHaveBeenLastCalledWith('aaaaaaaa', 'absent')
    expect(link.sessionEnded).toHaveBeenCalledTimes(2)
  })

  it('end-self turns a failure into plain words', async () => {
    const { tether, handle, event } = setup()
    tether.end.mockRejectedValueOnce(new Error('boom'))
    await expect(handle.get('session:end-self')?.(event)).rejects.toThrow(/^End failed/)
    await expect(handle.get('session:end-self')?.({ sender: { other: true } })).rejects.toThrow(
      'Session view is unavailable',
    )
  })

  it('holds input while a pane is replaced and drops a second replacement meanwhile', async () => {
    const { sessions, tether, on, event, catalog, titles, tray } = setup()
    const loading = deferred<SessionDescriptor>()
    tether.loadTui.mockReturnValueOnce(loading.promise)
    on.get('widget:load-tui')?.(event, 'claude')
    expect(sessions.isReplacing('aaaaaaaa')).toBe(true)
    on.get('widget:switch-project')?.(event, 'p1')
    expect(tether.switchProject).not.toHaveBeenCalled()
    expect(tether.loadTui).toHaveBeenCalledWith('aaaaaaaa', 'g1', 'claude')
    loading.resolve(descriptor('aaaaaaaa', { tool: 'claude', generation: 'g2' }))
    await vi.waitFor(() => expect(sessions.isReplacing('aaaaaaaa')).toBe(false))
    expect(catalog.get('aaaaaaaa')?.generation).toBe('g2')
    expect(titles).toHaveBeenCalledTimes(1)
    expect(tray).toHaveBeenCalledTimes(1)
  })

  it('a failed replacement shows a notice, re-lists and releases input', async () => {
    const { sessions, tether, on, event, win, link } = setup()
    tether.loadTui.mockRejectedValueOnce(new Error('nope'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    on.get('widget:load-tui')?.(event, 'claude')
    await vi.waitFor(() => expect(sessions.isReplacing('aaaaaaaa')).toBe(false))
    expect(link.requestRefresh).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith(
      'pty:data',
      expect.stringContaining('Could not switch the tool'),
    )
    warn.mockRestore()
  })

  it('switches to the Personal Workspace by root, or says why it cannot', async () => {
    const { tether, on, event, win, workspace, sessions } = setup()
    on.get('widget:switch-project')?.(event, PERSONAL_WORKSPACE_ID)
    expect(tether.switchProject).not.toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenCalledWith(
      'pty:data',
      expect.stringContaining('/home/o/Personal could not be created'),
    )
    workspace.root = '/home/o/Personal'
    on.get('widget:switch-project')?.(event, PERSONAL_WORKSPACE_ID)
    expect(tether.switchProject).toHaveBeenCalledWith('aaaaaaaa', 'g1', {
      projectRoot: '/home/o/Personal',
    })
    await vi.waitFor(() => expect(sessions.isReplacing('aaaaaaaa')).toBe(false))
  })

  it('renames with a trimmed name, empty clearing it, then refreshes titles and tray', async () => {
    const { tether, on, event, titles, tray, catalog } = setup()
    on.get('widget:set-name')?.(event, '  Docs  ')
    await vi.waitFor(() => expect(titles).toHaveBeenCalledTimes(1))
    expect(tether.rename).toHaveBeenCalledWith('aaaaaaaa', 'g1', 'Docs')
    expect(catalog.get('aaaaaaaa')?.name).toBe('Docs')
    expect(tray).toHaveBeenCalledTimes(1)
    on.get('widget:set-name')?.(event, '   ')
    await vi.waitFor(() => expect(titles).toHaveBeenCalledTimes(2))
    expect(tether.rename).toHaveBeenLastCalledWith('aaaaaaaa', 'g1', null)
  })

  it('toggles the coordinator mark through Tether', () => {
    const { tether, on, event, catalog } = setup()
    on.get('widget:toggle-coordinator')?.(event)
    expect(tether.setCoordinator).toHaveBeenLastCalledWith('aaaaaaaa', 'g1', true)
    catalog.upsert(descriptor('aaaaaaaa', { coordinator: true }))
    on.get('widget:toggle-coordinator')?.(event)
    expect(tether.setCoordinator).toHaveBeenLastCalledWith('aaaaaaaa', 'g1', false)
  })

  it('widget:new ignores a missing tool or workspace', () => {
    const { on, windows } = setup()
    on.get('widget:new')?.({}, 'codex')
    on.get('widget:new')?.({}, '', 'p1')
    on.get('widget:new')?.({}, 'codex', 7)
    expect(windows.openNew).not.toHaveBeenCalled()
    on.get('widget:new')?.({}, 'codex', 'p1')
    expect(windows.openNew).toHaveBeenCalledWith('codex', 'p1')
  })

  it('widget:new passes chosen instructions and refuses malformed ones', () => {
    const { on, windows } = setup()
    const revision = '20110df2-9d3f-4e0d-85af-38d9b844a282'
    on.get('widget:new')?.({}, 'codex', 'p1', { prompt: 'code-reviewer', revision: 'abc' })
    on.get('widget:new')?.({}, 'codex', 'p1', { prompt: '../x', revision })
    expect(windows.openNew).not.toHaveBeenCalled()
    on.get('widget:new')?.({}, 'codex', 'p1', { prompt: 'code-reviewer', revision })
    expect(windows.openNew).toHaveBeenCalledWith('codex', 'p1', {
      prompt: 'code-reviewer',
      revision,
    })
  })

  it('session:open rejects a bad id and opens a running session', async () => {
    const { handle, windows, tether } = setup()
    const open = handle.get('session:open')
    await expect(open?.({}, 'not-an-id')).rejects.toThrow('Invalid session')
    await expect(open?.({}, 42)).rejects.toThrow('Invalid session')
    tether.getSession.mockResolvedValueOnce(descriptor('bbbbbbbb', { status: 'pending' }))
    await expect(open?.({}, 'bbbbbbbb')).rejects.toThrow('Session is unavailable')
    await open?.({}, 'bbbbbbbb')
    expect(windows.focusOrReopen).toHaveBeenCalledWith('bbbbbbbb')
  })

  it('rejects an old pre-Tether web app id', async () => {
    const { handle, windows, tether } = setup()
    const open = handle.get('session:open')
    await expect(
      open?.({}, 'legacy:summitflow-1234abcd-0000-0000-0000-000000000000'),
    ).rejects.toThrow('Invalid session')
    expect(tether.getSession).not.toHaveBeenCalled()
    expect(windows.focusOrReopen).not.toHaveBeenCalled()
  })

  it('lists openable sessions', async () => {
    const { handle, link } = setup()
    const rows = (await handle.get('session:list-openable')?.()) as { id: string }[]
    expect(link.refresh).toHaveBeenCalledTimes(1)
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'aaaaaaaa',
        tool: 'Codex',
        project: 'Docs',
        locallyOpen: true,
      }),
    ])
  })

  it('the tray End asks first and ends only on confirm', async () => {
    const { sessions, dialog, tether } = setup()
    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await sessions.confirmTrayDiscard('aaaaaaaa')
    expect(tether.getSession).not.toHaveBeenCalled()
    await sessions.confirmTrayDiscard('aaaaaaaa')
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'End session?', message: 'End Session 4 · Codex?' }),
    )
    await vi.waitFor(() =>
      expect(tether.end).toHaveBeenCalledWith('aaaaaaaa', 'g1', { keepWakes: false }),
    )
  })

  it('an End of a session with check-ins names them and can keep them', async () => {
    const { sessions, dialog, tether, catalog, handle, event } = setup()
    const dueAt = new Date(2026, 9, 26, 17, 30).getTime()
    catalog.upsert(
      descriptor('aaaaaaaa', {
        wakes: [{ id: '5f1c0a9b2e7d', dueAt, note: 'n', createdBy: 'agent' }],
      }),
    )
    dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await sessions.confirmTrayDiscard('aaaaaaaa')
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        buttons: ['Cancel', 'End, keep check-in', 'End session'],
        detail: expect.stringMatching(/^This also cancels its check-in at (\w+ )?5:30 PM\./),
      }),
    )
    await vi.waitFor(() =>
      expect(tether.end).toHaveBeenCalledWith('aaaaaaaa', 'g1', { keepWakes: true }),
    )
    // In the window, a cancelled dialog ends nothing.
    tether.end.mockClear()
    dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await handle.get('session:end-self')?.(event)
    expect(tether.end).not.toHaveBeenCalled()
  })

  it('sets and cancels the window’s own check-ins', async () => {
    const { handle, tether, event, catalog } = setup()
    catalog.upsert(descriptor('aaaaaaaa', { state: 'idle' }))
    const menu = (await handle.get('session:check-in-menu')?.(event)) as {
      status: string
      choices: { label: string }[]
    }
    expect(menu.status).toBe('ready')
    expect(menu.choices.map((choice) => choice.label)).toHaveLength(3)
    tether.addWake.mockRejectedValueOnce(new TetherError(409, 'wake_unsupported', {}))
    await expect(handle.get('session:check-in')?.(event, Date.now() + 60_000)).rejects.toThrow(
      "Aico can't tell when this session is idle, so it can't take check-ins",
    )
    expect(await handle.get('session:check-in')?.(event, Date.now() + 60_000)).toMatch(/\d:\d\d/)
    expect(tether.addWake).toHaveBeenLastCalledWith(
      'aaaaaaaa',
      expect.objectContaining({ createdBy: 'owner' }),
    )
    // Only a check-in of this window's session.
    await handle.get('session:cancel-check-in')?.(event, '5f1c0a9b2e7d')
    expect(tether.cancelWake).not.toHaveBeenCalled()
    catalog.upsert(
      descriptor('aaaaaaaa', {
        wakes: [{ id: '5f1c0a9b2e7d', dueAt: 1, note: 'n', createdBy: 'owner' }],
      }),
    )
    await handle.get('session:cancel-check-in')?.(event, '5f1c0a9b2e7d')
    expect(tether.cancelWake).toHaveBeenCalledWith('5f1c0a9b2e7d')
  })

  it('diagnostics without a session, and a failure, answer in plain words', async () => {
    const { handle, tether, event } = setup()
    const diagnostics = handle.get('session:diagnostics')
    expect(await diagnostics?.({ sender: {} })).toMatchObject({ error: 'no session' })
    expect(await diagnostics?.(event)).toEqual({ sessionId: 'aaaaaaaa' })
    tether.diagnostics.mockRejectedValueOnce(new Error('x'))
    expect(await diagnostics?.(event)).toMatchObject({
      sessionId: 'aaaaaaaa',
      error: expect.stringMatching(/^Diagnostics unavailable/),
    })
  })
})
