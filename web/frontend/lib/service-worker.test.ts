// @vitest-environment node
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const ORIGIN = 'https://aico.test'
const SOURCE = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8')

type Handler = (event: unknown) => void
type FetchImpl = (request: unknown, init?: unknown) => Promise<unknown>

/** The worker's file run against a fake scope: caches in memory, the network is `fetchImpl`. */
function loadWorker(fetchImpl: FetchImpl) {
  const handlers: Record<string, Handler> = {}
  const stores = new Map<string, Map<string, Response>>()
  const messages: unknown[] = []
  const href = (key: unknown) =>
    new URL(
      typeof key === 'string' ? key : (key as { url: string }).url,
      ORIGIN,
    ).href
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name) as Map<string, Response>
    return {
      match: async (key: unknown) => store.get(href(key))?.clone(),
      put: async (key: unknown, response: Response) =>
        void store.set(href(key), response),
      delete: async (key: unknown) => store.delete(href(key)),
      keys: async () => [...store.keys()].map((url) => ({ url })),
    }
  }
  const scope = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler
    },
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [
        { postMessage: (message: unknown) => messages.push(message) },
      ],
    },
  }
  runInNewContext(SOURCE, {
    self: scope,
    caches: {
      // A real cache answers after the page has started reading the response.
      open: async (name: string) => {
        await new Promise((resolve) => setTimeout(resolve, 0))
        return open(name)
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    fetch: fetchImpl,
    Response,
    URL,
    Date,
    JSON,
    Math,
    Set,
  })

  /** Send a GET through the worker's fetch handler; null when it left the request alone. */
  async function get(
    path: string,
    options: { mode?: string; method?: string; range?: boolean } = {},
  ): Promise<Response | null> {
    const pending: Promise<unknown>[] = []
    const given: { answer: Promise<Response> | null } = { answer: null }
    const headers = new Headers(options.range ? { range: 'bytes=0-9' } : {})
    handlers.fetch?.({
      request: {
        method: options.method ?? 'GET',
        mode: options.mode ?? 'cors',
        url: `${ORIGIN}${path}`,
        headers,
      },
      respondWith: (promise: Promise<Response>) => {
        given.answer = promise
      },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    })
    const response = given.answer ? await given.answer : null
    // The page reads the body at once; the worker's copies must have been taken before that.
    const body =
      response && response.status !== 0 ? await response.text() : null
    await Promise.all(pending)
    if (!response || body === null) return response
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    })
  }

  return { handlers, stores, messages, get, scope }
}

const ok = (
  body: string,
  headers: Record<string, string> = { 'x-aico-host': 'gem' },
) => new Response(body, { status: 200, headers })

describe('service worker fallback decision', () => {
  const { scope } = loadWorker(async () => ok(''))
  const { shouldFallBack } = (
    scope as unknown as { aicoSw: Record<string, never> }
  ).aicoSw as unknown as {
    shouldFallBack: (input: {
      threw: boolean
      status: number
      hostHeader: string | null
    }) => boolean
  }

  it.each([
    ['the fetch throws', { threw: true, status: 0, hostHeader: null }, true],
    [
      'the status is 500',
      { threw: false, status: 500, hostHeader: 'gem' },
      true,
    ],
    [
      'Cloudflare answers 530 with its own page',
      { threw: false, status: 530, hostHeader: null },
      true,
    ],
    [
      'a 200 has no X-Aico-Host header',
      { threw: false, status: 200, hostHeader: null },
      true,
    ],
    [
      'a 502 has no header',
      { threw: false, status: 502, hostHeader: null },
      true,
    ],
    [
      'aico-web answers 200',
      { threw: false, status: 200, hostHeader: 'gem' },
      false,
    ],
    [
      'aico-web answers 404',
      { threw: false, status: 404, hostHeader: 'workstation' },
      false,
    ],
  ])('%s', (_name, input, expected) => {
    expect(shouldFallBack(input)).toBe(expected)
  })
})

describe('service worker', () => {
  it('leaves terminals, uploads, writes, streams, ranges and photo files to the network', async () => {
    let calls = 0
    const worker = loadWorker(async () => {
      calls += 1
      return ok('')
    })
    expect(await worker.get('/api/notes', { method: 'POST' })).toBeNull()
    expect(await worker.get('/api/captures', { method: 'PATCH' })).toBeNull()
    expect(await worker.get('/api/sessions')).toBeNull()
    expect(await worker.get('/api/nightshift/stream')).toBeNull()
    expect(await worker.get('/api/notes/abc/attachments/x/file')).toBeNull()
    expect(await worker.get('/api/captures/abc/preview')).toBeNull()
    expect(await worker.get('/api/notes', { range: true })).toBeNull()
    expect(await worker.get('/ws/terminal/abc')).toBeNull()
    expect(await worker.get('/manifest.webmanifest')).toBeNull()
    expect(
      await worker.get('/some/other/page', { mode: 'navigate' }),
    ).toBeNull()
    expect(calls).toBe(0)
  })

  it('answers from the network and keeps the answer while a host is up', async () => {
    const worker = loadWorker(async () => ok('{"notes":[]}'))
    const response = await worker.get('/api/notes?limit=100')
    expect(await response?.text()).toBe('{"notes":[]}')
    expect(worker.stores.get('aico-data-v1')?.size).toBe(1)
    expect(worker.messages).toEqual([])
  })

  it.each([
    [
      'the fetch throws',
      async () => {
        throw new TypeError('Failed to fetch')
      },
    ],
    [
      'the status is 5xx',
      async () =>
        new Response('down', {
          status: 503,
          headers: { 'x-aico-host': 'gem' },
        }),
    ],
    [
      'Cloudflare answers with its own error page',
      async () => new Response('<html>1033</html>', { status: 530 }),
    ],
    [
      'a 200 comes back without the host header',
      async () => new Response('<html>captive</html>', { status: 200 }),
    ],
  ])(
    'serves the kept copy and says it is offline when %s',
    async (_name, failing) => {
      let up = true
      const worker = loadWorker(async () =>
        up ? ok('{"notes":["kept"]}') : failing(),
      )
      await worker.get('/api/notes')
      up = false
      const response = await worker.get('/api/notes')
      expect(await response?.text()).toBe('{"notes":["kept"]}')
      expect(worker.messages.at(-1)).toMatchObject({
        type: 'aico-state',
        offline: true,
      })
      expect(
        (worker.messages.at(-1) as { notesAt: number }).notesAt,
      ).toBeGreaterThan(0)
      // The error page never replaced the good copy.
      expect(await (await worker.get('/api/notes'))?.text()).toBe(
        '{"notes":["kept"]}',
      )
    },
  )

  it('tells the pages when the hosts are back', async () => {
    let up = false
    const worker = loadWorker(async () =>
      up ? ok('fresh') : new Response('', { status: 530 }),
    )
    up = true
    await worker.get('/api/notes')
    up = false
    await worker.get('/api/notes')
    expect(worker.messages.at(-1)).toMatchObject({ offline: true })
    up = true
    expect(await (await worker.get('/api/notes'))?.text()).toBe('fresh')
    expect(worker.messages.at(-1)).toMatchObject({ offline: false })
  })

  it('passes the failure through when nothing was kept', async () => {
    const worker = loadWorker(async () => new Response('', { status: 530 }))
    const response = await worker.get('/api/notes/abc123')
    expect(response?.status).toBe(530)
    expect(worker.messages).toEqual([])
  })

  it('hands a redirect (Cloudflare Access sending you to sign in) to the browser untouched', async () => {
    const redirect = {
      type: 'opaqueredirect',
      status: 0,
      headers: new Headers(),
    }
    const worker = loadWorker(async () => redirect)
    expect(await worker.get('/notes', { mode: 'navigate' })).toBe(redirect)
    expect(await worker.get('/api/notes')).toBe(redirect)
    expect(worker.messages).toEqual([])
  })

  it('opens a page offline from the kept shell, any /notes?id= from /notes', async () => {
    let up = true
    const worker = loadWorker(async () =>
      up ? ok('<html>notes</html>') : new Response('', { status: 530 }),
    )
    await worker.get('/notes?id=abc', { mode: 'navigate' })
    up = false
    expect(
      await (await worker.get('/notes?id=other', { mode: 'navigate' }))?.text(),
    ).toBe('<html>notes</html>')
    // A page that was never kept falls back to the kept '/' shell, which is also missing here: the failure shows.
    expect((await worker.get('/captures', { mode: 'navigate' }))?.status).toBe(
      530,
    )
  })

  it('keeps app files first-hand: the second request never reaches the network', async () => {
    let calls = 0
    const worker = loadWorker(async () => {
      calls += 1
      return ok('chunk')
    })
    await worker.get('/_next/static/chunks/a1.js')
    expect(await (await worker.get('/_next/static/chunks/a1.js'))?.text()).toBe(
      'chunk',
    )
    expect(calls).toBe(1)
  })

  it('keeps the last 200 thumbs', async () => {
    const worker = loadWorker(async () => ok('jpg'))
    for (let n = 0; n < 205; n += 1)
      await worker.get(`/api/captures/c${n}/thumb`)
    const kept = [...(worker.stores.get('aico-thumbs-v1')?.keys() ?? [])]
    expect(kept).toHaveLength(200)
    expect(kept[0]).toBe(`${ORIGIN}/api/captures/c5/thumb`)
    expect(kept.at(-1)).toBe(`${ORIGIN}/api/captures/c204/thumb`)
  })

  it('clears what an older version kept when it activates', async () => {
    const worker = loadWorker(async () => ok(''))
    worker.stores.set('aico-data-v0', new Map([['x', ok('old')]]))
    worker.stores.set('aico-thumbs-v0', new Map())
    worker.stores.set('unrelated', new Map())
    worker.stores.set('aico-data-v1', new Map())
    let done: Promise<unknown> = Promise.resolve()
    worker.handlers.activate?.({
      waitUntil: (promise: Promise<unknown>) => (done = promise),
    })
    await done
    expect([...worker.stores.keys()].sort()).toEqual([
      'aico-data-v1',
      'unrelated',
    ])
  })

  it('answers a page that asks where things stand', async () => {
    const worker = loadWorker(async () => ok('x'))
    const replies: unknown[] = []
    let done: Promise<unknown> = Promise.resolve()
    worker.handlers.message?.({
      data: { type: 'aico-state?' },
      source: { postMessage: (message: unknown) => replies.push(message) },
      waitUntil: (promise: Promise<unknown>) => (done = promise),
    })
    await done
    expect(replies).toEqual([
      { type: 'aico-state', offline: false, notesAt: null },
    ])
  })
})
