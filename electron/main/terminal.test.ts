import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { PERSONAL_WORKSPACE_ID } from './project'
import { createSessionCatalog } from './session-catalog'
import { clampSize, createTerminal } from './terminal'
import {
  type AttachTarget,
  type SessionDescriptor,
  TetherError,
  TetherUnavailable,
} from './tether-client'
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

function target(generation = 'g1'): AttachTarget {
  return {
    generation,
    argv: ['/usr/bin/tmux', '-S', '/run/t/sock', 'attach-session', '-t', '$1'],
    env: {},
    unset: [],
  }
}

function fakeLink(size: { cols: number; rows: number }) {
  const data: ((d: string) => void)[] = []
  const exits: (() => void)[] = []
  return {
    pid: 4242,
    cols: size.cols,
    rows: size.rows,
    write: vi.fn(),
    resize: vi.fn(function (this: { cols: number; rows: number }, cols: number, rows: number) {
      this.cols = cols
      this.rows = rows
    }),
    kill: vi.fn(),
    onData: (fn: (d: string) => void) => {
      data.push(fn)
    },
    onExit: (fn: () => void) => {
      exits.push(fn)
    },
    emitData: (d: string) => {
      for (const fn of data) fn(d)
    },
    emitExit: () => {
      for (const fn of exits) fn()
    },
  }
}
type FakeLink = ReturnType<typeof fakeLink>

function fakeWindow(id: number) {
  let destroyed = false
  return {
    id,
    focused: false,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true
    },
    isFocused(): boolean {
      return this.focused
    },
    webContents: { send: vi.fn(), reload: vi.fn() },
  }
}
type FakeWindow = ReturnType<typeof fakeWindow>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function setup(o: { forced?: 'attach' | 'control'; setting?: string } = {}) {
  const all: FakeWindow[] = [fakeWindow(1), fakeWindow(2), fakeWindow(3)]
  const registry = new WindowRegistry({
    fromId: (id) => (all.find((w) => w.id === id) ?? null) as unknown as BrowserWindow | null,
    fromWebContents: (wc) =>
      (all.find((w) => w.webContents === (wc as unknown)) ??
        null) as unknown as BrowserWindow | null,
    getAllWindows: () => all as unknown as BrowserWindow[],
    getFocusedWindow: () => null,
  })
  const catalog = createSessionCatalog()
  const settings = new Map<string, string>()
  if (o.setting) settings.set('terminal-transport', o.setting)
  const links: FakeLink[] = []
  const controls: FakeLink[] = []
  const tether = {
    createSession: vi.fn(async (_input: unknown) => descriptor('bbbbbbbb')),
    attach: vi.fn(async (_id: string) => target()),
    resizeClaim: vi.fn(async () => ({ applied: true }) as { applied: boolean; reason?: string }),
  }
  const state = { replacing: new Set<string>(), quitting: false, arranged: false }
  const deps = {
    tether,
    catalog,
    registry,
    bind: vi.fn((win: BrowserWindow, d: SessionDescriptor) => {
      catalog.upsert(d)
      registry.bindSession(win.id, d.id)
      registry.clearPending(win.id)
    }),
    ensureView: vi.fn(),
    refresh: vi.fn(async () => {}),
    requestRefresh: vi.fn(),
    isReplacing: (id: string) => state.replacing.has(id),
    recentlyArranged: () => state.arranged,
    titles: vi.fn(),
    tray: vi.fn(),
    getSetting: (key: string) => settings.get(key),
    setSetting: vi.fn((key: string, value: string) => {
      settings.set(key, value)
    }),
    forcedTransport: o.forced,
    sandboxTmux: (argv: string[]) => argv,
    tmuxClientPid: async (pid: number) => pid,
    spawnPty: vi.fn((_file: string, _args: string[], opts: { cols: number; rows: number }) => {
      const link = fakeLink(opts)
      links.push(link)
      return link
    }),
    controlTerminal: vi.fn((_argv: string[], _env: NodeJS.ProcessEnv, size) => {
      const link = fakeLink(size)
      controls.push(link)
      return link
    }),
    execFileAsync: vi.fn(async (_file: string, _args: string[], _o: unknown) => ({ stdout: '' })),
    ensurePersonalWorkspaceRoot: () => '/home/o/Personal',
    isQuitting: () => state.quitting,
    env: { HOME: '/home/o', PATH: '/usr/bin' } as NodeJS.ProcessEnv,
  }
  const terminal = createTerminal(deps as never)
  const on = new Map<string, (...args: unknown[]) => unknown>()
  const handle = new Map<string, (...args: unknown[]) => unknown>()
  terminal.registerIpc({
    on: ((channel: string, fn: (...args: unknown[]) => unknown) => {
      on.set(channel, fn)
    }) as never,
    handle: ((channel: string, fn: (...args: unknown[]) => unknown) => {
      handle.set(channel, fn)
    }) as never,
  })
  const from = (win: FakeWindow) => ({ sender: win.webContents })
  return {
    terminal,
    deps,
    tether,
    catalog,
    registry,
    state,
    links,
    controls,
    all,
    on,
    handle,
    from,
  }
}

type Setup = ReturnType<typeof setup>

/** Bind window 1 to session aaaaaaaa and start its terminal; resolves once attached. */
async function attached(s: Setup, size = { cols: 100, rows: 30 }) {
  s.catalog.upsert(descriptor('aaaaaaaa'))
  s.registry.bindSession(1, 'aaaaaaaa')
  s.on.get('pty:start')?.(s.from(s.all[0]), size)
  await vi.waitFor(() => expect(s.links.length + s.controls.length).toBe(1))
  return s.links[0] ?? s.controls[0]
}

describe('clampSize', () => {
  it('keeps sane grids and clamps the rest', () => {
    expect(clampSize({ cols: 120.7, rows: 40 })).toEqual({ cols: 120, rows: 40 })
    expect(clampSize({ cols: -5, rows: 5000 })).toEqual({ cols: 1, rows: 1000 })
    expect(clampSize({ cols: Number.NaN, rows: Number.POSITIVE_INFINITY })).toEqual({
      cols: 80,
      rows: 24,
    })
    expect(clampSize(undefined as never)).toEqual({ cols: 80, rows: 24 })
  })
})

describe('terminal transport', () => {
  it('registers its eight channels', () => {
    const { on, handle } = setup()
    expect([...on.keys(), ...handle.keys()].sort()).toEqual([
      'pty:input',
      'pty:paste',
      'pty:refresh',
      'pty:resize',
      'pty:start',
      'terminal:toggle-transport',
      'terminal:transport',
      'terminal:transport-setting',
    ])
  })

  it('tells every window the setting, and records it per window', async () => {
    const s = setup()
    expect(s.handle.get('terminal:transport')?.(s.from(s.all[0]))).toBe('control')
    expect(s.handle.get('terminal:transport')?.({ sender: {} })).toBe('attach')
    expect(s.handle.get('terminal:transport-setting')?.()).toBe('control')
    // Window 1 was told control, so its link is a control-mode client.
    await attached(s)
    expect(s.controls).toHaveLength(1)
    expect(s.links).toHaveLength(0)
  })

  it('a window never asked runs a PTY with the attach argv', async () => {
    const s = setup()
    await attached(s)
    expect(s.deps.spawnPty).toHaveBeenCalledWith(
      '/usr/bin/tmux',
      ['-S', '/run/t/sock', 'attach-session', '-t', '$1'],
      expect.objectContaining({ name: 'xterm-256color', cols: 100, rows: 30, cwd: '/home/o' }),
    )
  })

  it('the attach setting and the forced environment both pick attach; forced wins', () => {
    expect(setup({ setting: 'attach' }).handle.get('terminal:transport-setting')?.()).toBe('attach')
    expect(
      setup({ forced: 'attach', setting: 'control' }).handle.get('terminal:transport-setting')?.(),
    ).toBe('attach')
    expect(
      setup({ forced: 'control', setting: 'attach' }).handle.get('terminal:transport-setting')?.(),
    ).toBe('control')
  })

  it('switching the transport saves it and reloads only session windows', () => {
    const s = setup()
    s.registry.bindSession(1, 'aaaaaaaa')
    s.registry.bindSession(2, 'bbbbbbbb')
    s.on.get('terminal:toggle-transport')?.()
    expect(s.deps.setSetting).toHaveBeenCalledWith('terminal-transport', 'attach')
    expect(s.all[0].webContents.reload).toHaveBeenCalledTimes(1)
    expect(s.all[1].webContents.reload).toHaveBeenCalledTimes(1)
    expect(s.all[2].webContents.reload).not.toHaveBeenCalled()
    s.on.get('terminal:toggle-transport')?.()
    expect(s.deps.setSetting).toHaveBeenLastCalledWith('terminal-transport', 'control')
  })
})

describe('terminal input', () => {
  it('drops input with no session or while the pane is replaced', async () => {
    const s = setup()
    const link = await attached(s)
    s.on.get('pty:input')?.(s.from(s.all[1]), 'x')
    s.on.get('pty:input')?.(s.from(s.all[0]), '')
    s.on.get('pty:input')?.(s.from(s.all[0]), 42)
    s.state.replacing.add('aaaaaaaa')
    s.on.get('pty:input')?.(s.from(s.all[0]), 'x')
    s.on.get('pty:paste')?.(s.from(s.all[0]), 'x')
    expect(link.write).not.toHaveBeenCalled()
    s.state.replacing.clear()
    s.on.get('pty:input')?.(s.from(s.all[0]), 'ls\r')
    s.on.get('pty:paste')?.(s.from(s.all[0]), 'pasted')
    expect(link.write.mock.calls).toEqual([['ls\r'], ['pasted']])
  })

  it('sends terminal bytes to the window and claims the size on first output', async () => {
    const s = setup()
    const link = await attached(s)
    expect(s.tether.resizeClaim).not.toHaveBeenCalled()
    link.emitData('hello')
    expect(s.all[0].webContents.send).toHaveBeenCalledWith('pty:data', 'hello')
    await vi.waitFor(() =>
      expect(s.tether.resizeClaim).toHaveBeenCalledWith('aaaaaaaa', 'g1', 4242, 100, 30),
    )
    link.emitData('more')
    expect(s.tether.resizeClaim).toHaveBeenCalledTimes(1)
  })

  it('resizes the link and claims the size only when focused or just arranged', async () => {
    const s = setup()
    const link = await attached(s)
    s.on.get('pty:resize')?.(s.from(s.all[0]), { cols: 90.9, rows: 20 })
    expect(link.resize).toHaveBeenCalledWith(90, 20)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.tether.resizeClaim).not.toHaveBeenCalled()
    s.state.arranged = true
    s.on.get('pty:resize')?.(s.from(s.all[0]), { cols: 80, rows: 20 })
    await vi.waitFor(() => expect(s.tether.resizeClaim).toHaveBeenCalledTimes(1))
  })

  it('a focus claims the size for that window', async () => {
    const s = setup()
    await attached(s)
    s.terminal.claimSize(1)
    s.terminal.claimSize(2) // no link: nothing
    await vi.waitFor(() => expect(s.tether.resizeClaim).toHaveBeenCalledTimes(1))
  })

  it('a stale size claim re-lists and tries again', async () => {
    const s = setup()
    await attached(s)
    s.tether.resizeClaim.mockRejectedValueOnce(new TetherError(409, 'stale_generation', {}))
    s.terminal.claimSize(1)
    await vi.waitFor(() => expect(s.tether.resizeClaim).toHaveBeenCalledTimes(2))
    expect(s.deps.refresh).toHaveBeenCalledTimes(1)
  })
})

describe('manual refresh', () => {
  it('shares an in-flight refresh for the same link and generation', async () => {
    const s = setup()
    await attached(s)
    const listing = deferred<{ stdout: string }>()
    s.deps.execFileAsync.mockReturnValueOnce(listing.promise)
    s.on.get('pty:refresh')?.(s.from(s.all[0]))
    await vi.waitFor(() => expect(s.deps.execFileAsync).toHaveBeenCalledTimes(1))
    s.on.get('pty:refresh')?.(s.from(s.all[0]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.deps.execFileAsync).toHaveBeenCalledTimes(1)
    expect(s.deps.execFileAsync.mock.calls[0][1]).toEqual([
      '-S',
      '/run/t/sock',
      'list-clients',
      '-t',
      '$1',
      '-F',
      '#{client_name}',
    ])
    listing.resolve({ stdout: 'client-1\n' })
    await vi.waitFor(() =>
      expect(s.deps.execFileAsync).toHaveBeenLastCalledWith(
        '/usr/bin/tmux',
        ['-S', '/run/t/sock', 'refresh-client', '-t', 'client-1'],
        expect.objectContaining({ timeout: 2000 }),
      ),
    )
    // Settled: the next Refresh runs again.
    const calls = s.deps.execFileAsync.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 0))
    s.on.get('pty:refresh')?.(s.from(s.all[0]))
    await vi.waitFor(() => expect(s.deps.execFileAsync.mock.calls.length).toBeGreaterThan(calls))
  })

  it('re-pairs a drifted link size before repainting, and does nothing while replaced', async () => {
    const s = setup()
    const link = await attached(s)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    s.state.replacing.add('aaaaaaaa')
    s.on.get('pty:refresh')?.(s.from(s.all[0]), { cols: 90, rows: 25 })
    expect(link.resize).not.toHaveBeenCalled()
    s.state.replacing.clear()
    s.on.get('pty:refresh')?.(s.from(s.all[0]), { cols: 90, rows: 25 })
    expect(link.resize).toHaveBeenCalledWith(90, 25)
    expect(warn).toHaveBeenCalledWith(
      '[aico] refresh: size desync (pty 100x30, term 90x25); re-pairing',
    )
    warn.mockRestore()
  })
})

describe('starting a session', () => {
  it('creates the session at the first grid, binds the window and attaches', async () => {
    const s = setup()
    s.registry.setPending(1, { tool: 'codex', projectId: PERSONAL_WORKSPACE_ID })
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
    await vi.waitFor(() => expect(s.links).toHaveLength(1))
    expect(s.tether.createSession).toHaveBeenCalledWith({
      tool: 'codex',
      projectRoot: '/home/o/Personal',
      size: { cols: 100, rows: 30 },
    })
    expect(s.deps.bind).toHaveBeenCalledTimes(1)
    expect(s.tether.attach).toHaveBeenCalledWith('bbbbbbbb')
    await vi.waitFor(() => expect(s.deps.titles).toHaveBeenCalledTimes(1))
  })

  it('a window closed during the create keeps the session as a closed view, unbound', async () => {
    const s = setup()
    s.registry.setPending(1, { tool: 'codex', projectId: 'p1' })
    const creating = deferred<SessionDescriptor>()
    s.tether.createSession.mockReturnValueOnce(creating.promise)
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
    s.all[0].destroy()
    creating.resolve(descriptor('bbbbbbbb'))
    await vi.waitFor(() => expect(s.deps.ensureView).toHaveBeenCalledWith('bbbbbbbb', false))
    expect(s.catalog.get('bbbbbbbb')).toBeDefined()
    expect(s.deps.bind).not.toHaveBeenCalled()
    expect(s.tether.attach).not.toHaveBeenCalled()
    expect(s.deps.tray).toHaveBeenCalledTimes(1)
  })

  it('waits for an unreachable Tether with a notice, then resumes when it is back', async () => {
    const s = setup()
    s.catalog.upsert(descriptor('aaaaaaaa'))
    s.registry.bindSession(1, 'aaaaaaaa')
    s.tether.attach.mockRejectedValueOnce(new TetherUnavailable('down'))
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
    await vi.waitFor(() =>
      expect(s.all[0].webContents.send).toHaveBeenCalledWith(
        'pty:data',
        expect.stringContaining('Could not attach: Tether is not reachable'),
      ),
    )
    expect(s.links).toHaveLength(0)
    s.terminal.resumeAwaiting()
    await vi.waitFor(() => expect(s.links).toHaveLength(1))
    expect(s.links[0].cols).toBe(100)
    // Resumed once: a second reconnect has nothing waiting.
    s.terminal.resumeAwaiting()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.tether.attach).toHaveBeenCalledTimes(2)
  })

  it('a link that exits re-lists sessions, except while quitting', async () => {
    const s = setup()
    const link = await attached(s)
    link.emitExit()
    expect(s.deps.requestRefresh).toHaveBeenCalledTimes(1)
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
    await vi.waitFor(() => expect(s.links).toHaveLength(2))
    s.state.quitting = true
    s.links[1].emitExit()
    expect(s.deps.requestRefresh).toHaveBeenCalledTimes(1)
  })
})

describe('reattaching when the session comes back', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('a window whose pane died reattaches once the session runs under a new generation', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = setup()
    const link = await attached(s, { cols: 120, rows: 40 })
    link.emitExit()
    // Still the old workload, or not running yet: nothing to attach to.
    s.terminal.sessionSeen(descriptor('aaaaaaaa'))
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g2', status: 'uncertain' }))
    await settle()
    expect(s.tether.attach).toHaveBeenCalledTimes(1)
    s.tether.attach.mockResolvedValueOnce(target('g2'))
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g2' }))
    await vi.waitFor(() => expect(s.links).toHaveLength(2))
    expect(s.tether.attach).toHaveBeenLastCalledWith('aaaaaaaa')
    expect(s.links[1].cols).toBe(120)
    expect(s.links[1].rows).toBe(40)
    // Attached again: later reports of the same or a newer generation leave it be.
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g2' }))
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g3' }))
    await settle()
    expect(s.tether.attach).toHaveBeenCalledTimes(2)
    // The window's input reaches the new link.
    s.on.get('pty:input')?.(s.from(s.all[0]), 'x')
    expect(s.links[1].write).toHaveBeenCalledWith('x')
  })

  it('tries once per generation, so a refused or dying attach cannot loop', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = setup()
    const link = await attached(s)
    link.emitExit()
    s.catalog.upsert(descriptor('aaaaaaaa', { generation: 'g2' }))
    s.tether.attach.mockRejectedValueOnce(new TetherError(409, 'workload_unavailable', {}))
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g2' }))
    await vi.waitFor(() => expect(s.tether.attach).toHaveBeenCalledTimes(2))
    await settle()
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g2' }))
    await settle()
    expect(s.tether.attach).toHaveBeenCalledTimes(2)
    // A link that exits at once is lost on its own generation: no retry either.
    s.tether.attach.mockResolvedValueOnce(target('g3'))
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g3' }))
    await vi.waitFor(() => expect(s.links).toHaveLength(2))
    s.links[1].emitExit()
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g3' }))
    await settle()
    expect(s.tether.attach).toHaveBeenCalledTimes(3)
  })

  it('a window whose attach was refused attaches once the session runs again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = setup()
    s.catalog.upsert(descriptor('aaaaaaaa', { status: 'uncertain' }))
    s.registry.bindSession(1, 'aaaaaaaa')
    s.tether.attach.mockRejectedValueOnce(new TetherError(409, 'workload_unavailable', {}))
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 90, rows: 25 })
    await vi.waitFor(() => expect(s.tether.attach).toHaveBeenCalledTimes(1))
    await settle()
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g2' }))
    await vi.waitFor(() => expect(s.links).toHaveLength(1))
    expect(s.links[0].cols).toBe(90)
  })

  it('never reattaches a forgotten window, a live link, another session, or while quitting', async () => {
    const s = setup()
    // A live link is left alone when the generation moves (a pane respawn).
    await attached(s)
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g2' }))
    await settle()
    expect(s.tether.attach).toHaveBeenCalledTimes(1)
    // A lost link while quitting, then for another session's report.
    s.links[0].emitExit()
    s.terminal.sessionSeen(descriptor('bbbbbbbb', { generation: 'g2' }))
    s.state.quitting = true
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g3' }))
    await settle()
    expect(s.tether.attach).toHaveBeenCalledTimes(1)
    // The window closed (or its session ended): it is forgotten.
    s.state.quitting = false
    s.terminal.forget(1)
    s.terminal.sessionSeen(descriptor('aaaaaaaa', { generation: 'g4' }))
    await settle()
    expect(s.tether.attach).toHaveBeenCalledTimes(1)
  })
})

describe('forget', () => {
  it('detaches the link and drops the window, so input no longer reaches it', async () => {
    const s = setup()
    const link = await attached(s)
    s.terminal.forget(1)
    expect(link.kill).toHaveBeenCalledTimes(1)
    s.on.get('pty:input')?.(s.from(s.all[0]), 'x')
    expect(link.write).not.toHaveBeenCalled()
    s.terminal.forget(1) // nothing left: no second kill
    expect(link.kill).toHaveBeenCalledTimes(1)
  })

  it('a forgotten window no longer resumes when Tether comes back', async () => {
    const s = setup()
    s.catalog.upsert(descriptor('aaaaaaaa'))
    s.registry.bindSession(1, 'aaaaaaaa')
    s.tether.attach.mockRejectedValueOnce(new TetherUnavailable('down'))
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
    await vi.waitFor(() => expect(s.tether.attach).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    s.terminal.forget(1)
    s.terminal.resumeAwaiting()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(s.tether.attach).toHaveBeenCalledTimes(1)
  })
})
