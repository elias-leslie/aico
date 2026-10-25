import type { BrowserWindow } from 'electron'
import { createSessionCatalog, type SessionDescriptor, TetherError } from 'tether/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compactRef, type SelectionRecord } from './selection'
import { createSelectionBus } from './selection-bus'
import type { ViewRow } from './views'
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

function fakeWindow(id: number) {
  return {
    id,
    isDestroyed: () => false,
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  }
}

function view(id: string): ViewRow {
  return { id } as ViewRow
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

const record: SelectionRecord = { kind: 'dom', snippet: 'Save button' }

function setup() {
  const win1 = fakeWindow(1)
  const win2 = fakeWindow(2)
  const all = [win1, win2]
  const registry = new WindowRegistry({
    fromId: (id) => (all.find((w) => w.id === id) ?? null) as unknown as BrowserWindow | null,
    fromWebContents: () => null,
    getAllWindows: () => all as unknown as BrowserWindow[],
    getFocusedWindow: () => null,
  })
  registry.bindSession(1, 'aaaaaaaa')
  registry.bindSession(2, 'bbbbbbbb')
  const catalog = createSessionCatalog()
  catalog.upsert(descriptor('aaaaaaaa'))
  catalog.upsert(descriptor('bbbbbbbb', { generation: 'g7' }))
  const views = [view('aaaaaaaa'), view('bbbbbbbb')]
  const tether = { inject: vi.fn(async () => ({}) as never) }
  const state = { replacing: new Set<string>(), quitting: false }
  const bus = createSelectionBus({
    registry,
    catalog,
    listViews: () => views,
    tether: tether as never,
    isReplacing: (id) => state.replacing.has(id),
    isQuitting: () => state.quitting,
    raise: (win) => {
      win.show()
      win.focus()
    },
  })
  const on = new Map<string, (...args: unknown[]) => unknown>()
  bus.registerIpc({
    on: ((channel: string, fn: (...args: unknown[]) => unknown) => {
      on.set(channel, fn)
    }) as never,
  })
  return { bus, win1, win2, views, catalog, tether, state, on }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.restoreAllMocks())

describe('selection target', () => {
  it('is the last focused session while its window is open, else the newest open view', () => {
    const { bus, views } = setup()
    expect(bus.target()).toBe('bbbbbbbb')
    bus.noteFocus('aaaaaaaa')
    expect(bus.target()).toBe('aaaaaaaa')
    // A window without a session keeps the last target.
    bus.noteFocus(undefined)
    expect(bus.target()).toBe('aaaaaaaa')
    bus.noteFocus('cccccccc') // not open in any window
    expect(bus.target()).toBe('bbbbbbbb')
    views.length = 0
    expect(bus.target()).toBeUndefined()
  })
})

describe('delivery', () => {
  it('types one compact reference at the target, then shows and toasts it', async () => {
    const { bus, tether, win2 } = setup()
    await expect(bus.deliver([record, { kind: 'empty' }])).resolves.toEqual({
      delivered: true,
      reason: null,
    })
    expect(tether.inject).toHaveBeenCalledWith('bbbbbbbb', 'g7', compactRef([record]), 'type')
    expect(win2.show).toHaveBeenCalled()
    expect(win2.focus).toHaveBeenCalled()
    expect(win2.webContents.send).toHaveBeenCalledWith('selection:toast', {
      kind: 'dom',
      snippet: 'Save button',
    })
  })

  it('toasts a batch as a count', async () => {
    const { bus, win2 } = setup()
    await bus.deliver([record, { kind: 'region', snippet: '/tmp/x.png' }])
    expect(win2.webContents.send).toHaveBeenCalledWith('selection:toast', {
      kind: '2 items',
      snippet: 'Save button · /tmp/x.png',
    })
  })

  it('ignores an empty capture', async () => {
    const { bus, tether } = setup()
    await expect(bus.deliver([{ kind: 'empty' }])).resolves.toEqual({
      delivered: false,
      reason: 'empty',
    })
    expect(tether.inject).not.toHaveBeenCalled()
  })

  it('says so when no session window is open', async () => {
    const { bus, tether, views } = setup()
    views.length = 0
    await expect(bus.deliver([record])).resolves.toEqual({
      delivered: false,
      reason: 'no_session',
    })
    expect(tether.inject).not.toHaveBeenCalled()
  })

  it('refuses while the target terminal is being replaced', async () => {
    const { bus, tether, win2, state } = setup()
    state.replacing.add('bbbbbbbb')
    await expect(bus.deliver([record])).resolves.toEqual({
      delivered: false,
      reason: 'session_changing',
    })
    expect(tether.inject).not.toHaveBeenCalled()
    expect(win2.webContents.send).toHaveBeenCalledWith('selection:toast', {
      kind: 'Session changing',
      snippet: 'Selection was not inserted while the terminal was being replaced.',
    })
  })

  it('sends nothing while quitting', async () => {
    const { bus, tether, state } = setup()
    state.quitting = true
    await expect(bus.deliver([record])).resolves.toMatchObject({ delivered: false })
    expect(tether.inject).not.toHaveBeenCalled()
  })

  it('refuses a second selection while one is still being inserted', async () => {
    const { bus, tether, win2 } = setup()
    const first = deferred<never>()
    tether.inject.mockReturnValueOnce(first.promise)
    const pending = bus.deliver([record])
    await expect(bus.deliver([record])).resolves.toEqual({ delivered: false, reason: 'busy' })
    expect(tether.inject).toHaveBeenCalledTimes(1)
    expect(win2.webContents.send).toHaveBeenCalledWith('selection:toast', {
      kind: 'Selection not inserted',
      snippet: 'Another selection is still being inserted. Try again.',
    })
    first.resolve(undefined as never)
    await expect(pending).resolves.toEqual({ delivered: true, reason: null })
    await bus.deliver([record])
    expect(tether.inject).toHaveBeenCalledTimes(2)
  })

  it('says the session changed on a stale generation, else that Tether could not insert; never retries', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { bus, tether, win2 } = setup()
    tether.inject.mockRejectedValueOnce(new TetherError(409, 'stale_generation', {}))
    await expect(bus.deliver([record])).resolves.toEqual({
      delivered: false,
      reason: 'stale_generation',
    })
    expect(win2.webContents.send).toHaveBeenLastCalledWith('selection:toast', {
      kind: 'Selection not inserted',
      snippet: 'The session changed. Try again.',
    })
    tether.inject.mockRejectedValueOnce(new Error('boom'))
    await expect(bus.deliver([record])).resolves.toEqual({
      delivered: false,
      reason: 'insert_failed',
    })
    expect(win2.webContents.send).toHaveBeenLastCalledWith('selection:toast', {
      kind: 'Selection not inserted',
      snippet: 'Tether could not insert the selection.',
    })
    expect(tether.inject).toHaveBeenCalledTimes(2)
    expect(win2.show).not.toHaveBeenCalled()
  })

  it('does not raise the window when the session changed during the insert', async () => {
    const { bus, tether, win2, catalog } = setup()
    tether.inject.mockImplementationOnce(async () => {
      catalog.upsert(descriptor('bbbbbbbb', { generation: 'g8' }))
      return {} as never
    })
    await expect(bus.deliver([record])).resolves.toEqual({ delivered: true, reason: null })
    expect(win2.show).not.toHaveBeenCalled()
  })
})

describe('indicate', () => {
  it('does nothing before any capture arrived', async () => {
    const { bus, tether } = setup()
    await bus.grab()
    expect(tether.inject).not.toHaveBeenCalled()
  })

  it('re-sends the newest capture, from memory, to the current target', async () => {
    const { bus, tether } = setup()
    const older = { kind: 'dom', snippet: 'older' }
    await bus.deliver([older, record])
    bus.noteFocus('aaaaaaaa')
    await bus.grab()
    expect(tether.inject).toHaveBeenLastCalledWith('aaaaaaaa', 'g1', compactRef([record]), 'type')
  })

  it('keeps a capture that was not delivered, so indicate can retry it', async () => {
    const { bus, tether, views } = setup()
    const saved = [...views]
    views.length = 0
    await bus.deliver([record])
    views.push(...saved)
    await bus.grab()
    expect(tether.inject).toHaveBeenCalledWith('bbbbbbbb', 'g7', compactRef([record]), 'type')
  })

  it('selection:grab runs the same re-send', async () => {
    const { bus, on, tether } = setup()
    await bus.deliver([record])
    on.get('selection:grab')?.()
    await flush()
    expect(tether.inject).toHaveBeenCalledTimes(2)
  })
})
