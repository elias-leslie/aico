import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEALTH_POLL_MS,
  HEALTH_STREAM_RETRY_MS,
  HEALTH_STREAM_URL,
  useHealth,
} from './use-health'

/** A stand-in EventSource the test drives: `emit` an event, `fail` it (closed: refused for good). */
class FakeEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  static all: FakeEventSource[] = []
  readyState = FakeEventSource.CONNECTING
  onerror: (() => void) | null = null
  closed = false
  private handlers = new Map<string, ((event: MessageEvent) => void)[]>()

  constructor(readonly url: string) {
    FakeEventSource.all.push(this)
  }

  addEventListener(name: string, handler: (event: MessageEvent) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler])
  }

  close() {
    this.closed = true
    this.readyState = FakeEventSource.CLOSED
  }

  emit(name: string, data: unknown) {
    this.readyState = FakeEventSource.OPEN
    for (const h of this.handlers.get(name) ?? [])
      h(new MessageEvent(name, { data: JSON.stringify(data) }))
  }

  fail(closed: boolean) {
    this.readyState = closed
      ? FakeEventSource.CLOSED
      : FakeEventSource.CONNECTING
    this.onerror?.()
  }
}

const VIEW = { available: false, reason: 'not_answering' }

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

describe('useHealth', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  const views = () =>
    fetchMock.mock.calls.filter(([url]) => url === '/api/nightshift/view')
      .length

  beforeEach(() => {
    vi.useFakeTimers()
    FakeEventSource.all = []
    vi.stubGlobal('EventSource', FakeEventSource)
    fetchMock = vi.fn(async () => new Response(JSON.stringify(VIEW)))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reads the view again when the feed says it changed, without polling', async () => {
    const { result } = renderHook(() => useHealth(), { wrapper: wrapper() })
    await settle()
    expect(result.current.result).toEqual(VIEW)
    expect(FakeEventSource.all.map((s) => s.url)).toEqual([HEALTH_STREAM_URL])
    const [feed] = FakeEventSource.all
    act(() => feed.emit('live', { live: true }))
    await settle()
    const afterLive = views()

    await settle(HEALTH_POLL_MS * 3)
    expect(views()).toBe(afterLive)

    act(() => feed.emit('changed', {}))
    await settle()
    expect(views()).toBe(afterLive + 1)
  })

  it('polls while the feed is down and reads again when it comes back', async () => {
    renderHook(() => useHealth(), { wrapper: wrapper() })
    await settle()
    const [feed] = FakeEventSource.all
    act(() => feed.emit('live', { live: false }))
    const before = views()
    await settle(HEALTH_POLL_MS)
    expect(views()).toBe(before + 1)

    act(() => feed.emit('live', { live: true }))
    await settle()
    expect(views()).toBe(before + 2)

    // A dropped connection (the browser reconnects it): polling again meanwhile.
    act(() => feed.fail(false))
    await settle(HEALTH_POLL_MS)
    expect(views()).toBe(before + 3)
  })

  it('opens the feed again after the server refused it', async () => {
    renderHook(() => useHealth(), { wrapper: wrapper() })
    await settle()
    act(() => FakeEventSource.all[0].fail(true))
    await settle(HEALTH_STREAM_RETRY_MS)
    expect(FakeEventSource.all).toHaveLength(2)
  })

  it('shares one feed between the pill and the sheet and closes it when both are gone', async () => {
    const wrap = wrapper()
    const pill = renderHook(() => useHealth(), { wrapper: wrap })
    const sheet = renderHook(() => useHealth(), { wrapper: wrap })
    await settle()
    expect(FakeEventSource.all).toHaveLength(1)
    pill.unmount()
    expect(FakeEventSource.all[0].closed).toBe(false)
    sheet.unmount()
    expect(FakeEventSource.all[0].closed).toBe(true)
  })
})
