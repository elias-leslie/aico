import { describe, expect, it, vi } from 'vitest'
import type { ChatStreamItem } from '../../../../shared/chat/types'
import {
  ChatInfoError,
  createHttpTransport,
  fetchChatInfo,
} from './http-transport'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/** A response whose body the test feeds chunk by chunk. */
function sseResponse() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c
    },
  })
  return {
    response: new Response(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    write: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  }
}

const frame = (item: ChatStreamItem) => `data: ${JSON.stringify(item)}\n\n`

describe('chat info and calls', () => {
  it('asks the server which session it shows', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        ok: true,
        value: { sessionId: 'hub-1', agentSlug: 'coder', requestedModel: null },
      }),
    )
    const info = await fetchChatInfo({ session: 'ab12cd34' }, fetchImpl)
    expect(info.sessionId).toBe('hub-1')
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/chat/info',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ session: 'ab12cd34' }),
      }),
    )
  })

  it('throws the server’s words when the chat cannot be opened', async () => {
    const fetchImpl = vi.fn(async () =>
      json(
        {
          ok: false,
          error: {
            code: 'not_a_chat',
            message: 'This session is not an Agent Hub chat.',
          },
        },
        409,
      ),
    )
    const error = await fetchChatInfo({ session: 'x' }, fetchImpl).catch(
      (caught) => caught,
    )
    expect(error).toBeInstanceOf(ChatInfoError)
    expect(error.message).toBe('This session is not an Agent Hub chat.')
  })

  it('names the target on every call and returns the server’s answer', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ ok: true, value: { queued: true } }),
    )
    const transport = createHttpTransport(
      { run: 'r1', step: 'build', attempt: 'att-2' },
      fetchImpl,
    )
    const answer = await transport.call('send', {
      sessionId: 'att-2',
      text: 'x',
    })
    expect(answer).toEqual({ ok: true, value: { queued: true } })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      run: 'r1',
      step: 'build',
      attempt: 'att-2',
      method: 'send',
      args: { sessionId: 'att-2', text: 'x' },
    })
  })

  it('words a refusal by the web guard and an unreachable server', async () => {
    const refused = createHttpTransport(
      { session: 's' },
      vi.fn(async () => json({ error: 'origin_not_allowed' }, 403)),
    )
    expect(await refused.call('models', {})).toMatchObject({
      ok: false,
      error: { code: 'refused', status: 403 },
    })
    const down = createHttpTransport(
      { session: 's' },
      vi.fn(async () => {
        throw new TypeError('network')
      }),
    )
    expect(await down.call('models', {})).toMatchObject({
      ok: false,
      error: { code: 'tether_unavailable' },
    })
    const odd = createHttpTransport(
      { session: 's' },
      vi.fn(async () => new Response('<html>', { status: 502 })),
    )
    expect(await odd.call('models', {})).toMatchObject({
      ok: false,
      error: { code: 'chat_failed', status: 502 },
    })
  })
})

describe('chat stream', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

  it('delivers items across chunk boundaries and stops at the end', async () => {
    const stream = sseResponse()
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => stream.response,
    )
    const items: ChatStreamItem[] = []
    await createHttpTransport({ session: 's1' }, fetchImpl).openStream(
      7,
      (item) => items.push(item),
    )
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/chat/stream?session=s1&afterSeq=7',
    )
    const first = frame({ kind: 'event', event: { type: 'content', seq: 8 } })
    stream.write(`: open\n\n${first.slice(0, 12)}`)
    await settle()
    expect(items).toEqual([])
    stream.write(`${first.slice(12)}: keep-alive\n\n${frame({ kind: 'end' })}`)
    await settle()
    expect(items).toEqual([
      { kind: 'event', event: { type: 'content', seq: 8 } },
      { kind: 'end' },
    ])
    stream.close()
  })

  it('names a step by run, step and attempt', async () => {
    const stream = sseResponse()
    const fetchImpl = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) => stream.response,
    )
    await createHttpTransport(
      { run: 'r1', step: 'build', attempt: 'att-2' },
      fetchImpl,
    ).openStream(0, () => {})
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      '/api/chat/stream?run=r1&step=build&attempt=att-2',
    )
  })

  it('reports a connection that dropped as one to reattach', async () => {
    const stream = sseResponse()
    const items: ChatStreamItem[] = []
    await createHttpTransport(
      { session: 's' },
      async () => stream.response,
    ).openStream(0, (item) => items.push(item))
    stream.close()
    await settle()
    expect(items).toEqual([
      {
        kind: 'error',
        error: expect.objectContaining({ code: 'stream_interrupted' }),
      },
    ])
    const failed: ChatStreamItem[] = []
    await createHttpTransport({ session: 's' }, async () => {
      throw new TypeError('network')
    }).openStream(0, (item) => failed.push(item))
    await settle()
    expect(failed).toEqual([
      {
        kind: 'error',
        error: expect.objectContaining({ code: 'stream_interrupted' }),
      },
    ])
  })

  it('passes on a refusal before any stream opened', async () => {
    const items: ChatStreamItem[] = []
    await createHttpTransport({ session: 's' }, async () =>
      json(
        {
          ok: false,
          error: { code: 'too_many_streams', message: 'Too many.' },
        },
        429,
      ),
    ).openStream(0, (item) => items.push(item))
    await settle()
    expect(items).toEqual([
      {
        kind: 'error',
        error: { code: 'too_many_streams', message: 'Too many.' },
      },
    ])
  })

  it('closing stops delivery and aborts the request', async () => {
    const stream = sseResponse()
    let signal: AbortSignal | undefined
    const items: ChatStreamItem[] = []
    const close = await createHttpTransport({ session: 's' }, (async (
      _url: string,
      init: RequestInit,
    ) => {
      signal = init.signal ?? undefined
      return stream.response
    }) as unknown as typeof fetch).openStream(0, (item) => items.push(item))
    await settle()
    close()
    expect(signal?.aborted).toBe(true)
    stream.write(frame({ kind: 'event', event: { type: 'content', seq: 1 } }))
    await settle()
    expect(items).toEqual([])
  })
})
