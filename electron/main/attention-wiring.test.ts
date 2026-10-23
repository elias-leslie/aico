import type { ExecFileException } from 'node:child_process'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PUSH_AFTER_MS } from './attention'
import { createAttentionWiring } from './attention-wiring'
import { createSessionCatalog } from './session-catalog'
import type { SessionDescriptor, TetherTool } from './tether-client'
import { WindowRegistry } from './window-registry'

function fakeWindow(id: number) {
  return {
    id,
    focused: false,
    isDestroyed: () => false,
    isFocused() {
      return this.focused
    },
    flashFrame: vi.fn(),
    webContents: { send: vi.fn() },
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
    name: 'Docs',
    label: 'Docs',
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
const claudeCode: TetherTool = {
  slug: 'claude-code',
  name: 'Claude Code',
  color: '#D97757',
  processName: 'claude',
  aliases: ['claude'],
  displayOrder: 0,
  isDefault: false,
  enabled: true,
}

type PushCallback = (error: ExecFileException | null, stdout: string | Buffer) => void

function setup(windows: FakeWindow[] = [], tools: TetherTool[] = [claudeCode, codex]) {
  const registry = new WindowRegistry({
    fromId: (id) => (windows.find((w) => w.id === id) ?? null) as unknown as BrowserWindow | null,
    fromWebContents: () => null,
    getAllWindows: () => windows as unknown as BrowserWindow[],
    getFocusedWindow: () => null,
  })
  const catalog = createSessionCatalog()
  const setNeedsYou = vi.fn()
  const pushes: { file: string; args: string[]; options: unknown; done: PushCallback }[] = []
  const execFile = vi.fn(
    (file: string, args: string[], options: { timeout: number }, done: PushCallback) => {
      pushes.push({ file, args, options, done })
    },
  )
  const wiring = createAttentionWiring({
    registry,
    catalog,
    tools: () => tools,
    setNeedsYou,
    execFile,
    nightshift: '/usr/local/bin/nightshift',
    webUrl: 'http://web.test',
  })
  return { wiring, registry, catalog, setNeedsYou, execFile, pushes }
}

const asWin = (w: FakeWindow) => w as unknown as BrowserWindow

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.useFakeTimers()
  log = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('attention wiring', () => {
  it('shows a blocked session on its window, flashes it and lights the tray', () => {
    const win = fakeWindow(1)
    const { wiring, registry, catalog, setNeedsYou } = setup([win])
    registry.bindSession(1, 'aaaaaaaa')
    const d = descriptor('aaaaaaaa', { state: 'blocked', stateAt: 5 })
    catalog.upsert(d)

    wiring.update(d)

    expect(win.webContents.send).toHaveBeenCalledWith('eyes:attention', {
      mode: 'blocked',
      stage: 'fresh',
    })
    expect(win.flashFrame).toHaveBeenCalledWith(true)
    expect(setNeedsYou).toHaveBeenCalledWith(true)
    expect(wiring.group('aaaaaaaa')).toMatchObject({ group: 'needs-you', at: 5 })
  })

  it('a focused window is not flagged', () => {
    const win = fakeWindow(1)
    win.focused = true
    const { wiring, registry } = setup([win])
    registry.bindSession(1, 'aaaaaaaa')
    wiring.update(descriptor('aaaaaaaa', { state: 'blocked' }))
    expect(win.webContents.send).not.toHaveBeenCalled()
    expect(win.flashFrame).not.toHaveBeenCalled()
  })

  it('pushes once through Nightshift after two minutes unanswered', () => {
    const win = fakeWindow(1)
    const { wiring, registry, catalog, execFile } = setup([win])
    registry.bindSession(1, 'aaaaaaaa')
    const d = descriptor('aaaaaaaa', { state: 'blocked', stateSource: 'claude-hook' })
    catalog.upsert(d)
    wiring.update(d)

    vi.advanceTimersByTime(PUSH_AFTER_MS - 1)
    expect(execFile).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(execFile).toHaveBeenCalledTimes(1)
    expect(execFile).toHaveBeenCalledWith(
      '/usr/local/bin/nightshift',
      [
        'push',
        'Claude Code in Docs is waiting for you',
        '--title',
        'Aico: waiting for you',
        '--severity',
        'warning',
        '--open',
        'http://web.test/?session=aaaaaaaa',
      ],
      { timeout: 30_000 },
      expect.any(Function),
    )
    expect(win.webContents.send).toHaveBeenLastCalledWith('eyes:attention', {
      mode: 'blocked',
      stage: 'urgent',
    })
    expect(wiring.urgent()).toEqual(['aaaaaaaa'])
  })

  it('falls back to the tool name when the state source is not a known agent', () => {
    const { wiring, catalog, execFile } = setup()
    const d = descriptor('aaaaaaaa', { state: 'blocked' })
    catalog.upsert(d)
    wiring.update(d)
    vi.advanceTimersByTime(PUSH_AFTER_MS)
    expect(execFile.mock.calls[0]?.[1][1]).toBe('Codex in Docs is waiting for you')
  })

  it("names the agent by Aico's built-in name while Tether's tool list is unavailable", () => {
    const win = fakeWindow(1)
    const { wiring, registry, catalog, execFile } = setup([win], [])
    registry.bindSession(1, 'aaaaaaaa')
    const d = descriptor('aaaaaaaa', {
      tool: 'claude-code',
      state: 'blocked',
      stateSource: 'claude-hook',
    })
    catalog.upsert(d)
    wiring.update(d)
    vi.advanceTimersByTime(PUSH_AFTER_MS)
    expect(execFile.mock.calls[0]?.[1][1]).toBe('Claude Code in Docs is waiting for you')
  })

  it('a sent push goes to the journal', () => {
    const { wiring, catalog, pushes } = setup()
    const d = descriptor('aaaaaaaa', { state: 'blocked' })
    catalog.upsert(d)
    wiring.update(d)
    vi.advanceTimersByTime(PUSH_AFTER_MS)

    pushes[0]?.done(null, 'state file ok\nsent 1/1\n')

    expect(log).toHaveBeenCalledWith(
      '[aico:event] needs_you_push result=sent widget=aaaaaaaa nightshift=sent_1/1',
    )
  })

  it('a suppressed push goes to the journal as suppressed', () => {
    const { wiring, catalog, pushes } = setup()
    const d = descriptor('aaaaaaaa', { state: 'blocked' })
    catalog.upsert(d)
    wiring.update(d)
    vi.advanceTimersByTime(PUSH_AFTER_MS)

    pushes[0]?.done(null, 'suppressed\n')

    expect(log).toHaveBeenCalledWith(
      '[aico:event] needs_you_push result=suppressed widget=aaaaaaaa nightshift=suppressed',
    )
  })

  it('no push for a session that left the catalog', () => {
    const { wiring, execFile } = setup()
    wiring.update(descriptor('aaaaaaaa', { state: 'blocked' }))
    vi.advanceTimersByTime(PUSH_AFTER_MS)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('focusing the window clears what it shows and cancels the push', () => {
    const win = fakeWindow(1)
    const { wiring, registry, catalog, execFile, setNeedsYou } = setup([win])
    registry.bindSession(1, 'aaaaaaaa')
    const d = descriptor('aaaaaaaa', { state: 'blocked' })
    catalog.upsert(d)
    wiring.update(d)

    wiring.focused('aaaaaaaa')
    vi.advanceTimersByTime(PUSH_AFTER_MS)

    expect(win.webContents.send).toHaveBeenLastCalledWith('eyes:attention', {
      mode: 'none',
      stage: 'fresh',
    })
    expect(setNeedsYou).toHaveBeenLastCalledWith(false)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('a removed session clears its window', () => {
    const win = fakeWindow(1)
    const { wiring, registry } = setup([win])
    registry.bindSession(1, 'aaaaaaaa')
    wiring.update(descriptor('aaaaaaaa', { state: 'blocked' }))
    wiring.removed('aaaaaaaa')
    expect(win.webContents.send).toHaveBeenLastCalledWith('eyes:attention', {
      mode: 'none',
      stage: 'fresh',
    })
    expect(wiring.group('aaaaaaaa').group).toBe('idle')
  })

  it('a reloaded window gets what it shows, or nothing to show', () => {
    const win1 = fakeWindow(1)
    const win2 = fakeWindow(2)
    const win3 = fakeWindow(3)
    const { wiring, registry } = setup([win1, win2, win3])
    registry.bindSession(1, 'aaaaaaaa')
    registry.bindSession(2, 'bbbbbbbb')
    wiring.update(descriptor('aaaaaaaa', { state: 'blocked' }))
    win1.webContents.send.mockClear()

    wiring.sendTo(asWin(win1))
    wiring.sendTo(asWin(win2))
    wiring.sendTo(asWin(win3)) // no session: nothing

    expect(win1.webContents.send).toHaveBeenCalledWith('eyes:attention', {
      mode: 'blocked',
      stage: 'fresh',
    })
    expect(win2.webContents.send).toHaveBeenCalledWith('eyes:attention', {
      mode: 'none',
      stage: 'fresh',
    })
    expect(win3.webContents.send).not.toHaveBeenCalled()
  })

  it('a finished session shows the done state', () => {
    const win = fakeWindow(1)
    const { wiring, registry } = setup([win])
    registry.bindSession(1, 'aaaaaaaa')
    wiring.update(descriptor('aaaaaaaa', { state: 'working' }))
    wiring.update(descriptor('aaaaaaaa', { state: 'idle' }))
    expect(win.webContents.send).toHaveBeenLastCalledWith('eyes:attention', {
      mode: 'finished',
      stage: 'fresh',
    })
  })
})
