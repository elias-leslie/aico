import { describe, expect, it, vi } from 'vitest'
import { type ChatBridge, createBridgeClient } from './bridge-client'
import type { ChatCallResult, ChatStreamItem } from './types'

const INFO = { sessionId: 'hub-1', agentSlug: 'coder', requestedModel: null }

/** A bridge whose streams the test feeds by hand. */
function fakeBridge(answers: Record<string, (args: Record<string, unknown>) => ChatCallResult>) {
  const opened: { afterSeq: number; push: (item: ChatStreamItem) => void; closed: boolean }[] = []
  const calls: [string, Record<string, unknown>][] = []
  const bridge: ChatBridge = {
    call: async (method, args) => {
      calls.push([method, args])
      return answers[method]?.(args) ?? { ok: true, value: null }
    },
    openStream: async (afterSeq, push) => {
      const stream = { afterSeq, push, closed: false }
      opened.push(stream)
      return () => {
        stream.closed = true
      }
    },
  }
  return { bridge, opened, calls }
}

const event = (type: string, seq?: number, extra: object = {}) => ({
  kind: 'event' as const,
  event: { type, ...(seq === undefined ? {} : { seq }), ...extra },
})

async function collect(iterator: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const item of iterator) out.push(item)
  return out
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('bridge client', () => {
  it('starts a turn through the follow-up queue, then follows it from its first event', async () => {
    const { bridge, opened, calls } = fakeBridge({
      send: () => ({ ok: true, value: { queued: false } }),
    })
    const client = createBridgeClient(bridge, INFO)
    const events = client.turns.stream({
      messages: [
        { role: 'assistant', content: 'earlier' },
        { role: 'user', content: 'hello' },
      ],
    } as never)
    const done = collect(events)
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    expect(calls).toEqual([['send', { sessionId: 'hub-1', text: 'hello' }]])
    expect(opened[0].afterSeq).toBe(0)
    for (const item of [
      event('connected', 1),
      event('content', 2, { content: 'hi' }),
      event('done', 3),
    ])
      opened[0].push(item)
    expect(await done).toEqual([
      { type: 'connected', seq: 1 },
      { type: 'content', seq: 2, content: 'hi' },
      { type: 'done', seq: 3 },
    ])
    expect(opened[0].closed).toBe(true)
  })

  it('drops an event it already delivered and ends at an idle session', async () => {
    const { bridge, opened } = fakeBridge({})
    const client = createBridgeClient(bridge, INFO)
    const done = collect(client.turns.attach('hub-1', { afterSeq: 4 }))
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    expect(opened[0].afterSeq).toBe(4)
    for (const item of [
      event('content', 4),
      event('content', 5),
      event('content', 5),
      event('idle'),
    ])
      opened[0].push(item)
    expect(await done).toEqual([{ type: 'content', seq: 5 }, { type: 'idle' }])
  })

  it('reconnects from the last seq when the stream drops, and says so', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, opened } = fakeBridge({})
      const client = createBridgeClient(bridge, INFO)
      const reattached = vi.fn()
      const done = collect(client.turns.attach('hub-1', { onReattach: reattached }))
      await vi.advanceTimersByTimeAsync(0)
      opened[0].push(event('content', 1))
      opened[0].push({
        kind: 'error',
        error: { code: 'tether_unavailable', message: 'down' },
      })
      await vi.advanceTimersByTimeAsync(600)
      expect(opened).toHaveLength(2)
      expect(opened[1].afterSeq).toBe(1)
      expect(reattached).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1, afterSeq: 1, delayMs: 500 }),
      )
      opened[1].push(event('content', 2))
      opened[1].push(event('done', 3))
      expect(await done).toEqual([
        { type: 'content', seq: 1 },
        { type: 'content', seq: 2 },
        { type: 'done', seq: 3 },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after bounded reconnects with an SDK-shaped error', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, opened } = fakeBridge({})
      const client = createBridgeClient(bridge, INFO)
      const outcome = collect(client.turns.attach('hub-1')).catch((error: Error) => error)
      for (let n = 0; n < 6; n++) {
        await vi.advanceTimersByTimeAsync(11_000)
        opened[n]?.push({ kind: 'end' })
      }
      await vi.advanceTimersByTimeAsync(11_000)
      const error = (await outcome) as Error & { code: string }
      expect(error.name).toBe('AgentHubError')
      expect(error.code).toBe('stream_interrupted')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails at once on an error that retrying cannot fix', async () => {
    const { bridge, opened } = fakeBridge({})
    const client = createBridgeClient(bridge, INFO)
    const outcome = collect(client.turns.attach('hub-1')).catch((error: Error) => error)
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    opened[0].push({ kind: 'error', error: { code: 'not_a_chat', message: 'Not a chat.' } })
    expect(await outcome).toMatchObject({ code: 'not_a_chat', message: 'Not a chat.' })
    expect(opened).toHaveLength(1)
  })

  it('aborting closes the bridge stream and rejects with AbortError', async () => {
    const { bridge, opened } = fakeBridge({})
    const client = createBridgeClient(bridge, INFO)
    const controller = new AbortController()
    const outcome = collect(client.turns.attach('hub-1', { signal: controller.signal })).catch(
      (error: Error) => error,
    )
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(opened[0].closed).toBe(true)
  })

  it('sends a follow-up and reads the queue by the window’s session', async () => {
    const { bridge, calls } = fakeBridge({
      send: () => ({ ok: true, value: { queued: true } }),
      queue: () => ({ ok: true, value: ['next'] }),
      cancel: () => ({ ok: true, value: { cancelled: true } }),
      session: () => ({ ok: true, value: { id: 'hub-1', messages: [] } }),
    })
    const client = createBridgeClient(bridge, INFO)
    expect(await client.followUps?.send('hub-1', 'and then?')).toEqual({ queued: true })
    expect(await client.followUps?.pending('hub-1')).toEqual(['next'])
    expect(await client.turns.cancel('hub-1')).toEqual({ cancelled: true })
    expect(await client.sessions.get('hub-1')).toMatchObject({ id: 'hub-1' })
    expect(calls.map(([method]) => method)).toEqual(['send', 'queue', 'cancel', 'session'])
    expect(calls.every(([, args]) => args.sessionId === 'hub-1')).toBe(true)
    await nextTick()
  })

  it('sends the window’s chosen model with a message and with a queued follow-up', async () => {
    const { bridge, opened, calls } = fakeBridge({
      send: () => ({ ok: true, value: { queued: false } }),
    })
    let model: string | null = 'gemini-flash'
    const client = createBridgeClient(bridge, INFO, { model: () => model })
    const done = collect(
      client.turns.stream({ messages: [{ role: 'user', content: 'first' }] } as never),
    )
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    opened[0].push(event('done', 1))
    await done
    model = null
    await client.followUps?.send('hub-1', 'second')
    model = 'deepseek-flash'
    await client.followUps?.send('hub-1', 'third')
    expect(calls).toEqual([
      ['send', { sessionId: 'hub-1', text: 'first', model: 'gemini-flash' }],
      ['send', { sessionId: 'hub-1', text: 'second', model: null }],
      ['send', { sessionId: 'hub-1', text: 'third', model: 'deepseek-flash' }],
    ])
  })

  it('says when a turn is running: from its first event to its end, once', async () => {
    const { bridge, opened } = fakeBridge({})
    const busy: boolean[] = []
    const client = createBridgeClient(bridge, INFO, { onBusy: (on) => busy.push(on) })
    const done = collect(client.turns.attach('hub-1', { afterSeq: 0 }))
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    expect(busy).toEqual([])
    opened[0].push(event('connected', 1))
    opened[0].push(event('content', 2))
    opened[0].push(event('done', 3))
    await done
    expect(busy).toEqual([true, false])
  })

  it('does not call an idle session busy, and a dropped or aborted stream is not busy', async () => {
    const { bridge, opened } = fakeBridge({})
    const busy: boolean[] = []
    const client = createBridgeClient(bridge, INFO, { onBusy: (on) => busy.push(on) })
    const idle = collect(client.turns.attach('hub-1', { afterSeq: 0 }))
    await vi.waitFor(() => expect(opened).toHaveLength(1))
    opened[0].push(event('idle'))
    await idle
    expect(busy).toEqual([])

    const controller = new AbortController()
    const running = collect(
      client.turns.attach('hub-1', { afterSeq: 0, signal: controller.signal }),
    )
    await vi.waitFor(() => expect(opened).toHaveLength(2))
    opened[1].push(event('content', 1))
    await vi.waitFor(() => expect(busy).toEqual([true]))
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(busy).toEqual([true, false])
  })

  it('turns a failed call into an error with its code and status', async () => {
    const { bridge } = fakeBridge({
      queue: () => ({
        ok: false,
        error: {
          code: 'agent_hub_unavailable',
          status: 503,
          message: 'Agent Hub is not reachable.',
        },
      }),
    })
    const client = createBridgeClient(bridge, INFO)
    await expect(client.followUps?.pending('hub-1')).rejects.toMatchObject({
      name: 'AgentHubError',
      code: 'agent_hub_unavailable',
      status: 503,
      message: 'Agent Hub is not reachable.',
    })
  })

  it('does not offer forking', async () => {
    const client = createBridgeClient(fakeBridge({}).bridge, INFO)
    await expect(client.sessions.fork('hub-1')).rejects.toMatchObject({ code: 'unsupported' })
  })
})
