import type { BrowserWindow } from 'electron'
import {
  type AttachAnswer,
  createSessionCatalog,
  type SessionDescriptor,
  TetherError,
  TetherUnavailable,
} from 'tether/client'
import { controlSocketPath } from 'tether/term'
import { describe, expect, it, vi } from 'vitest'
import { BLANK_SLATE_ID, PERSONAL_WORKSPACE_ID } from './project'
import { OVERLAY_DELAY_MS, RECLAIM_SPACING_MS } from './size-holder'
import { clampSize, createTerminal, retryDelay } from './terminal'
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

const SERVER_SOCKET = `${process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`}/tether/default/tmux/${'ab'.repeat(16)}/server.sock`

function target(generation = 'g1'): AttachAnswer {
  return {
    generation,
    argv: ['/usr/bin/tmux', '-S', SERVER_SOCKET, 'attach-session', '-t', '$1'],
    env: { TERM: 'xterm-256color' },
  }
}

function fakeLink(size: { cols: number; rows: number }) {
  const data: ((d: string) => void)[] = []
  const exits: (() => void)[] = []
  return {
    pid: 4242,
    refusedByHost: false,
    cols: size.cols,
    rows: size.rows,
    write: vi.fn(),
    paste: vi.fn(),
    reseed: vi.fn(),
    settleSize: vi.fn(),
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

function setup() {
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
  const links: FakeLink[] = []
  const tether = {
    createSession: vi.fn(async (_input: unknown) => descriptor('bbbbbbbb')),
    attach: vi.fn(async (_id: string) => target()),
    resizeClaim: vi.fn(
      async () => ({ applied: true }) as { applied: boolean; changed?: boolean; reason?: string },
    ),
    hosts: vi.fn(async () => [] as unknown[]),
  }
  const state = { replacing: new Set<string>(), quitting: false, arranged: false }
  // Remote reattach tries: pending timers, run by hand.
  const timers = new Map<number, { fn: () => void; ms: number }>()
  let nextTimer = 0
  const deps = {
    setTimer: (fn: () => void, ms: number) => {
      nextTimer += 1
      timers.set(nextTimer, { fn, ms })
      return nextTimer
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number)
    },
    random: () => 0.5,
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
    controlTerminal: vi.fn((_argv: string[], _env: NodeJS.ProcessEnv, size) => {
      const link = fakeLink(size)
      links.push(link)
      return link
    }),
    ensurePersonalWorkspaceRoot: () => '/home/o/Personal',
    instructionsSnapshot: vi.fn(async (choice: { prompt: string; revision: string }) => ({
      ...choice,
      name: 'Code Reviewer',
      contentHash: null,
      createdAt: null,
      content: 'Review carefully.',
    })),
    isQuitting: () => state.quitting,
    viewer: { app: 'desktop', device: 'test-host' },
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
    all,
    on,
    handle,
    from,
    timers,
  }
}

type Setup = ReturnType<typeof setup>

/** Bind window 1 to session aaaaaaaa and start its terminal; resolves once attached. */
async function attached(s: Setup, size = { cols: 100, rows: 30 }) {
  s.catalog.upsert(descriptor('aaaaaaaa'))
  s.registry.bindSession(1, 'aaaaaaaa')
  s.on.get('pty:start')?.(s.from(s.all[0]), size)
  await vi.waitFor(() => expect(s.links).toHaveLength(1))
  return s.links[0]
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

describe('terminal channels', () => {
  it('registers its channels', () => {
    const { on, handle } = setup()
    expect([...on.keys(), ...handle.keys()].sort()).toEqual([
      'pty:claim-size',
      'pty:input',
      'pty:paste',
      'pty:reconnect',
      'pty:refresh',
      'pty:resize',
      'pty:start',
    ])
  })

  it('opens a control-mode client on the attach target', async () => {
    const s = setup()
    await attached(s)
    expect(s.deps.controlTerminal).toHaveBeenCalledWith(
      ['/usr/bin/tmux', '-S', SERVER_SOCKET, 'attach-session', '-t', '$1'],
      { TERM: 'xterm-256color', LANG: 'C.UTF-8' },
      { cols: 100, rows: 30 },
    )
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
    expect(link.paste).not.toHaveBeenCalled()
    s.state.replacing.clear()
    s.on.get('pty:input')?.(s.from(s.all[0]), 'ls\r')
    s.on.get('pty:paste')?.(s.from(s.all[0]), 'pasted')
    expect(link.write.mock.calls).toEqual([['ls\r']])
    expect(link.paste.mock.calls).toEqual([['pasted']])
  })

  it('sends terminal bytes to the window and claims the size on first output', async () => {
    const s = setup()
    const link = await attached(s)
    expect(s.tether.resizeClaim).not.toHaveBeenCalled()
    link.emitData('hello')
    expect(s.all[0].webContents.send).toHaveBeenCalledWith('pty:data', 'hello')
    await vi.waitFor(() =>
      expect(s.tether.resizeClaim).toHaveBeenCalledWith('aaaaaaaa', 'g1', 4242, 100, 30, {
        app: 'desktop',
        device: 'test-host',
      }),
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
  it('claims the size, then reseeds the link from tmux', async () => {
    const s = setup()
    const link = await attached(s)
    s.on.get('pty:refresh')?.(s.from(s.all[0]))
    await vi.waitFor(() => expect(link.reseed).toHaveBeenCalledTimes(1))
    expect(s.tether.resizeClaim).toHaveBeenCalledTimes(1)
  })

  it('shares an in-flight refresh for the same link and generation', async () => {
    const s = setup()
    const link = await attached(s)
    const claim = deferred<{ applied: boolean }>()
    s.tether.resizeClaim.mockReturnValueOnce(claim.promise)
    s.on.get('pty:refresh')?.(s.from(s.all[0]))
    s.on.get('pty:refresh')?.(s.from(s.all[0]))
    claim.resolve({ applied: true })
    await vi.waitFor(() => expect(link.reseed).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(link.reseed).toHaveBeenCalledTimes(1)
    // Settled: the next Refresh runs again.
    s.on.get('pty:refresh')?.(s.from(s.all[0]))
    await vi.waitFor(() => expect(link.reseed).toHaveBeenCalledTimes(2))
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

  it('says which step a host is on while a create waits for it to start', async () => {
    const s = setup()
    let finish: (d: SessionDescriptor) => void = () => {}
    s.tether.createSession.mockImplementationOnce(
      () => new Promise<SessionDescriptor>((resolve) => (finish = resolve)),
    )
    s.tether.hosts.mockResolvedValue([
      { name: 'agent-work', wake: { state: 'starting', step: 'connecting' } },
    ])
    s.registry.setPending(1, { tool: 'codex', projectId: 'aico', host: 'agent-work' })
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
    await vi.waitFor(() => expect(s.timers.size).toBe(1))
    const [id, look] = [...s.timers][0] ?? []
    s.timers.delete(id as number)
    look?.fn()
    await vi.waitFor(() =>
      expect(s.all[0].webContents.send).toHaveBeenCalledWith(
        'pty:data',
        expect.stringContaining('Starting agent-work… connecting'),
      ),
    )
    await vi.waitFor(() => expect(s.timers.size).toBe(1))
    finish(descriptor('bbbbbbbb'))
    await vi.waitFor(() => expect(s.links).toHaveLength(1))
    expect(s.timers.size).toBe(0)
  })

  it('sends the chosen revision as a snapshot, also for Blank Slate', async () => {
    const s = setup()
    const revision = '20110df2-9d3f-4e0d-85af-38d9b844a282'
    s.registry.setPending(1, {
      tool: 'codex',
      projectId: BLANK_SLATE_ID,
      instructions: { prompt: 'code-reviewer', revision },
    })
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
    await vi.waitFor(() => expect(s.links).toHaveLength(1))
    expect(s.tether.createSession).toHaveBeenCalledWith({
      tool: 'codex',
      blankSlate: true,
      instructions: {
        prompt: 'code-reviewer',
        revision,
        name: 'Code Reviewer',
        contentHash: null,
        createdAt: null,
        content: 'Review carefully.',
      },
      size: { cols: 100, rows: 30 },
    })
  })

  it('starts nothing when the chosen revision cannot be read, and says why', async () => {
    const s = setup()
    s.deps.instructionsSnapshot.mockRejectedValueOnce(
      new Error("Couldn't read code-reviewer from Agent Hub"),
    )
    s.registry.setPending(1, {
      tool: 'codex',
      projectId: 'p1',
      instructions: { prompt: 'code-reviewer', revision: '20110df2-9d3f-4e0d-85af-38d9b844a282' },
    })
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
    await vi.waitFor(() =>
      expect(s.all[0].webContents.send).toHaveBeenCalledWith(
        'pty:data',
        expect.stringContaining(
          "Could not start the session: Couldn't read code-reviewer from Agent Hub",
        ),
      ),
    )
    expect(s.tether.createSession).not.toHaveBeenCalled()
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

describe('another client holds the size', () => {
  const sent = (s: Setup) =>
    s.all[0].webContents.send.mock.calls.filter(([channel]) => channel === 'pty:size-other')
  /** A claim by a client other than this window's (pid 4242), once the notice delay passes. */
  async function lostTo(s: Setup, pid = 9999) {
    s.terminal.sizeHeldBy('aaaaaaaa', pid)
    await vi.advanceTimersByTimeAsync(OVERLAY_DELAY_MS + 10)
  }

  it('shows the notice only after another client has held the size a moment', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      await attached(s)
      await vi.advanceTimersByTimeAsync(0)
      s.terminal.sizeHeldBy('aaaaaaaa', 9999)
      await vi.advanceTimersByTimeAsync(OVERLAY_DELAY_MS - 100)
      expect(sent(s).at(-1)).toEqual(['pty:size-other', false])
      await vi.advanceTimersByTimeAsync(200)
      expect(sent(s).at(-1)).toEqual(['pty:size-other', true])
    } finally {
      vi.useRealTimers()
    }
  })

  it("stays quiet when the claim is this window's own", async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      await attached(s)
      await lostTo(s, 4242)
      expect(sent(s).every(([, shown]) => shown === false)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides the notice the moment this window claims the size again', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      const link = await attached(s)
      await lostTo(s)
      expect(sent(s).at(-1)).toEqual(['pty:size-other', true])
      s.on.get('pty:claim-size')?.(s.from(s.all[0]), true) // Use here
      await vi.advanceTimersByTimeAsync(0)
      expect(s.tether.resizeClaim).toHaveBeenCalledWith('aaaaaaaa', 'g1', 4242, 100, 30, {
        app: 'desktop',
        device: 'test-host',
      })
      expect(sent(s).at(-1)).toEqual(['pty:size-other', false])
      expect(link.settleSize).not.toHaveBeenCalled() // nothing changed in tmux
    } finally {
      vi.useRealTimers()
    }
  })

  it('reseeds when a claim took the size back from the other client', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      const link = await attached(s)
      await lostTo(s)
      s.tether.resizeClaim.mockResolvedValueOnce({ applied: true, changed: true })
      s.terminal.claimSize(1) // the window gained focus
      await vi.advanceTimersByTimeAsync(0)
      expect(link.settleSize).toHaveBeenCalledTimes(1)
      expect(sent(s).at(-1)).toEqual(['pty:size-other', false])
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the size back when the owner clicks in the terminal or types', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      const link = await attached(s)
      await lostTo(s)
      s.on.get('pty:claim-size')?.(s.from(s.all[0]), false) // a click
      await vi.advanceTimersByTimeAsync(0)
      expect(s.tether.resizeClaim).toHaveBeenCalledTimes(1)
      s.terminal.sizeHeldBy('aaaaaaaa', 9999)
      await vi.advanceTimersByTimeAsync(RECLAIM_SPACING_MS + 10)
      s.on.get('pty:input')?.(s.from(s.all[0]), 'x') // typing
      await vi.advanceTimersByTimeAsync(0)
      expect(link.write).toHaveBeenCalledWith('x')
      expect(s.tether.resizeClaim).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not flash the notice when the owner is typing and takes the size back at once', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      await attached(s)
      s.all[0].focused = true
      s.on.get('pty:input')?.(s.from(s.all[0]), 'x')
      s.terminal.sizeHeldBy('aaaaaaaa', 9999)
      await vi.advanceTimersByTimeAsync(0)
      expect(s.tether.resizeClaim).toHaveBeenCalledTimes(1) // reclaimed by itself
      s.terminal.sizeHeldBy('aaaaaaaa', 4242) // the claim landed
      await vi.advanceTimersByTimeAsync(OVERLAY_DELAY_MS * 2)
      expect(sent(s).every(([, shown]) => shown === false)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears the notice when the window attaches again', async () => {
    vi.useFakeTimers()
    try {
      const s = setup()
      await attached(s)
      await lostTo(s)
      s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
      await vi.advanceTimersByTimeAsync(0)
      expect(sent(s).at(-1)).toEqual(['pty:size-other', false])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sessions on another host', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const HOST = 'agent-work'
  const REMOTE_SOCKET = `/home/kasadis/.local/state/tether/default/tmux/${'cd'.repeat(16)}/server.sock`
  const remote = (extra: Partial<SessionDescriptor> = {}) =>
    descriptor('aaaaaaaa', { host: HOST, ...extra })
  const peer = (state: 'offline' | 'connecting' | 'powered_off') => ({
    state,
    since: 1,
    listedAt: 1,
  })
  function remoteTarget(generation = 'g1'): AttachAnswer {
    return {
      generation,
      argv: ['/usr/bin/tmux', '-S', REMOTE_SOCKET, 'attach-session', '-t', '$1'],
      env: { TERM: 'xterm-256color' },
      host: HOST,
      ssh: { alias: HOST, control: controlSocketPath(HOST) },
    } as AttachAnswer
  }
  const hostSends = (win: FakeWindow) =>
    win.webContents.send.mock.calls.filter(([channel]) => channel === 'pty:host').map(([, v]) => v)
  const runTimers = (s: Setup) => {
    const pending = [...s.timers.entries()]
    for (const [id, timer] of pending) {
      s.timers.delete(id)
      timer.fn()
    }
    return pending.map(([, timer]) => timer.ms)
  }

  async function attachedRemote(s: Setup) {
    s.catalog.upsert(remote())
    s.registry.bindSession(1, 'aaaaaaaa')
    s.tether.attach.mockResolvedValue(remoteTarget())
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 100, rows: 30 })
    await vi.waitFor(() => expect(s.links).toHaveLength(1))
    return s.links[0]
  }

  it('backs off exponentially, capped and jittered', () => {
    expect(retryDelay(0, () => 0.5)).toBe(1_000)
    expect(retryDelay(3, () => 0.5)).toBe(8_000)
    expect(retryDelay(10, () => 0.5)).toBe(30_000)
    expect(retryDelay(0, () => 0)).toBe(500)
    expect(retryDelay(10, () => 0.999)).toBe(44_970)
  })

  it('runs tmux on the host over ssh and says the session is live there', async () => {
    const s = setup()
    await attachedRemote(s)
    const [argv] = s.deps.controlTerminal.mock.calls[0]
    expect(argv.slice(0, 2)).toEqual(['/usr/bin/ssh', '-F'])
    expect(argv).toContain(`'${REMOTE_SOCKET}'`)
    expect(hostSends(s.all[0])).toEqual([{ host: HOST, state: 'live' }])
  })

  it('waits for an offline host without attaching, then attaches when it is back', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = setup()
    s.catalog.upsert(remote({ peer: peer('offline') }))
    s.registry.bindSession(1, 'aaaaaaaa')
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 90, rows: 25 })
    await vi.waitFor(() => expect(hostSends(s.all[0])).toEqual([{ host: HOST, state: 'offline' }]))
    expect(s.tether.attach).not.toHaveBeenCalled()
    expect(s.all[0].isDestroyed()).toBe(false)
    // Still away, now powered off: the notice follows, still no attach.
    s.terminal.sessionSeen(remote({ peer: peer('powered_off') }))
    await settle()
    expect(s.tether.attach).not.toHaveBeenCalled()
    expect(hostSends(s.all[0]).at(-1)).toEqual({ host: HOST, state: 'powered_off' })
    // Back: attach at the window's last grid.
    s.catalog.upsert(remote())
    s.tether.attach.mockResolvedValue(remoteTarget())
    s.terminal.sessionSeen(remote())
    await vi.waitFor(() => expect(s.links).toHaveLength(1))
    expect(s.links[0].cols).toBe(90)
    expect(hostSends(s.all[0]).at(-1)).toEqual({ host: HOST, state: 'live' })
  })

  it('a host that goes away drops the live link, and input stops', async () => {
    const s = setup()
    const link = await attachedRemote(s)
    s.terminal.sessionSeen(remote({ peer: peer('offline') }))
    expect(link.kill).toHaveBeenCalled()
    expect(hostSends(s.all[0]).at(-1)).toEqual({ host: HOST, state: 'offline' })
    s.on.get('pty:input')?.(s.from(s.all[0]), 'x')
    expect(link.write).not.toHaveBeenCalled()
  })

  it('a host_unavailable refusal waits for the host with its state', async () => {
    const s = setup()
    s.catalog.upsert(remote())
    s.registry.bindSession(1, 'aaaaaaaa')
    s.tether.attach.mockRejectedValueOnce(
      new TetherError(409, 'host_unavailable', { host: HOST, state: 'powered_off' }),
    )
    s.on.get('pty:start')?.(s.from(s.all[0]), { cols: 90, rows: 25 })
    await vi.waitFor(() =>
      expect(hostSends(s.all[0])).toEqual([{ host: HOST, state: 'powered_off' }]),
    )
    expect(s.links).toHaveLength(0)
    expect(s.timers.size).toBe(0)
  })

  it('a dropped link retries with growing waits, then stops and waits for Reconnect', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = setup()
    const link = await attachedRemote(s)
    s.tether.attach.mockRejectedValue(new Error('ssh: connect failed'))
    link.emitExit()
    expect(hostSends(s.all[0]).at(-1)).toEqual({ host: HOST, state: 'connecting' })
    const waits: number[] = []
    for (let i = 0; i < 8 && s.timers.size > 0; i += 1) {
      waits.push(...runTimers(s))
      await settle()
      await settle()
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
    expect(s.tether.attach).toHaveBeenCalledTimes(7)
    expect(hostSends(s.all[0]).at(-1)).toEqual({ host: HOST, state: 'disconnected' })
    // Reconnect tries once more, now successfully.
    s.tether.attach.mockResolvedValue(remoteTarget())
    s.on.get('pty:reconnect')?.(s.from(s.all[0]))
    await vi.waitFor(() => expect(s.links).toHaveLength(2))
    expect(hostSends(s.all[0]).at(-1)).toEqual({ host: HOST, state: 'live' })
  })

  it('a host with no room for another session says so and waits for Reconnect', async () => {
    const s = setup()
    const link = await attachedRemote(s)
    link.refusedByHost = true
    link.emitExit()
    expect(hostSends(s.all[0]).at(-1)).toEqual({ host: HOST, state: 'refused' })
    expect(s.timers.size).toBe(0)
    expect(s.tether.attach).toHaveBeenCalledTimes(1)
    s.on.get('pty:reconnect')?.(s.from(s.all[0]))
    await vi.waitFor(() => expect(s.links).toHaveLength(2))
    expect(hostSends(s.all[0]).at(-1)).toEqual({ host: HOST, state: 'live' })
  })

  it("the hub's resync reattaches a window between tries, its tries starting over", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = setup()
    const link = await attachedRemote(s)
    link.emitExit()
    expect(s.timers.size).toBe(1)
    s.terminal.peerResync('other-host')
    await settle()
    expect(s.tether.attach).toHaveBeenCalledTimes(1)
    s.terminal.peerResync(HOST)
    await vi.waitFor(() => expect(s.links).toHaveLength(2))
    expect(s.timers.size).toBe(0)
  })

  it('a forgotten window drops its pending try', async () => {
    const s = setup()
    const link = await attachedRemote(s)
    link.emitExit()
    expect(s.timers.size).toBe(1)
    s.terminal.forget(1)
    expect(s.timers.size).toBe(0)
  })
})
