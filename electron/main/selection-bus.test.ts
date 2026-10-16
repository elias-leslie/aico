import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compactRef, type SelectionRecord } from './selection'
import { createSelectionBus } from './selection-bus'
import { createSessionCatalog } from './session-catalog'
import { type SessionDescriptor, TetherError } from './tether-client'
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

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response
}

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
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    jsonResponse(record),
  )
  const sidecar = { healthy: false }
  const bus = createSelectionBus({
    registry,
    catalog,
    listViews: () => views,
    tether: tether as never,
    isReplacing: (id) => state.replacing.has(id),
    isQuitting: () => state.quitting,
    sidecar: {
      ready: () => sidecar.healthy,
      url: (path) => `http://127.0.0.1:18905${path}`,
    },
    fetch: fetch as unknown as typeof globalThis.fetch,
  })
  const on = new Map<string, (...args: unknown[]) => unknown>()
  bus.registerIpc({
    on: ((channel: string, fn: (...args: unknown[]) => unknown) => {
      on.set(channel, fn)
    }) as never,
  })
  /** Mark the sidecar healthy, so the grab may harvest. */
  const ready = () => {
    sidecar.healthy = true
  }
  return { bus, win1, win2, views, catalog, tether, state, fetch, on, ready }
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

describe('selection grab and delivery', () => {
  it('never harvests before its own sidecar is healthy', async () => {
    const { bus, fetch, ready } = setup()
    await bus.grab() // not started, or started and not yet healthy
    expect(fetch).not.toHaveBeenCalled()
    ready()
    await bus.grab()
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:18905/selection/current')
  })

  it('types the compact reference at the target, then shows and toasts it', async () => {
    const { bus, tether, win2, ready } = setup()
    ready()
    await bus.grab()
    await flush()
    expect(tether.inject).toHaveBeenCalledWith('bbbbbbbb', 'g7', compactRef([record]), 'type')
    expect(win2.show).toHaveBeenCalled()
    expect(win2.focus).toHaveBeenCalled()
    expect(win2.webContents.send).toHaveBeenCalledWith('selection:toast', {
      kind: 'dom',
      snippet: 'Save button',
    })
  })

  it('ignores an empty capture', async () => {
    const { bus, tether, fetch, ready } = setup()
    ready()
    fetch.mockResolvedValueOnce(jsonResponse({ kind: 'empty' }))
    await bus.grab()
    expect(tether.inject).not.toHaveBeenCalled()
  })

  it('refuses while the target terminal is being replaced', async () => {
    const { bus, tether, win2, state, ready } = setup()
    ready()
    state.replacing.add('bbbbbbbb')
    await bus.grab()
    expect(tether.inject).not.toHaveBeenCalled()
    expect(win2.webContents.send).toHaveBeenCalledWith('selection:toast', {
      kind: 'Session changing',
      snippet: 'Selection was not inserted while the terminal was being replaced.',
    })
  })

  it('refuses a second selection while one is still being inserted', async () => {
    const { bus, tether, win2, ready } = setup()
    ready()
    const first = deferred<never>()
    tether.inject.mockReturnValueOnce(first.promise)
    await bus.grab()
    await bus.grab()
    expect(tether.inject).toHaveBeenCalledTimes(1)
    expect(win2.webContents.send).toHaveBeenCalledWith('selection:toast', {
      kind: 'Selection not inserted',
      snippet: 'Another selection is still being inserted. Try again.',
    })
    first.resolve(undefined as never)
    await flush()
    await bus.grab()
    expect(tether.inject).toHaveBeenCalledTimes(2)
  })

  it('says the session changed on a stale generation, else that Tether could not insert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { bus, tether, win2, ready } = setup()
    ready()
    tether.inject.mockRejectedValueOnce(new TetherError(409, 'stale_generation', {}))
    await bus.grab()
    await flush()
    expect(win2.webContents.send).toHaveBeenLastCalledWith('selection:toast', {
      kind: 'Selection not inserted',
      snippet: 'The session changed. Try again.',
    })
    tether.inject.mockRejectedValueOnce(new Error('boom'))
    await bus.grab()
    await flush()
    expect(win2.webContents.send).toHaveBeenLastCalledWith('selection:toast', {
      kind: 'Selection not inserted',
      snippet: 'Tether could not insert the selection.',
    })
  })

  it('selection:grab runs the same harvest', async () => {
    const { on, fetch, ready } = setup()
    ready()
    on.get('selection:grab')?.()
    await flush()
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:18905/selection/current')
  })
})

describe('deliver-event stream', () => {
  it('delivers records from the deliver-event stream and stops on quit', async () => {
    const { bus, fetch, tether, state, ready } = setup()
    ready()
    const encoder = new TextEncoder()
    const frames = [
      ': ping\n\n',
      `data: ${JSON.stringify({ records: [record] })}\n\n`,
      'data: {not json\n\n',
    ]
    fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/selection/events')) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame))
            controller.close()
          },
        })
        return { ok: true, status: 200, body } as unknown as Response
      }
      return jsonResponse(record)
    })
    bus.subscribe()
    await vi.waitFor(() => expect(tether.inject).toHaveBeenCalledTimes(1))
    // Quitting before the 1 s reconnect backoff ends the loop.
    state.quitting = true
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:18905/selection/events', {
      signal: expect.any(AbortSignal),
    })
    await new Promise((r) => setTimeout(r, 1100))
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/events'))).toHaveLength(1)
    bus.stop()
  })

  it('stop() is safe before subscribing', () => {
    expect(() => setup().bus.stop()).not.toThrow()
  })
})
