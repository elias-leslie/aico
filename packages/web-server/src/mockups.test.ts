import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TetherError, TetherUnavailable } from '@aico/tether-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { viewDocument, WRAPPED_CSP } from './design-render'
import { MOCKUP_CSP, registerMockupRoutes } from './mockups'
import { serveRoutes } from './testing'

interface Ask {
  id: string
  session: string | null
  requester: string | null
  state: string
  answer: string | null
  note: string | null
  delivery?: string
  answerTo?: string | null
}

class MockupTether {
  asks = new Map<string, Ask>()
  calls: { method: string; path: string; body: unknown }[] = []
  unavailable = false

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    this.calls.push({ method, path, body })
    if (this.unavailable) throw new TetherUnavailable('offline')
    const input = (body ?? {}) as Record<string, unknown>
    let ask: Ask
    if (method === 'POST' && path === '/v1/asks') {
      ask = {
        id: (this.asks.size + 1).toString(16).padStart(12, '0'),
        session: input.session as string | null,
        requester: input.requester as string | null,
        state: 'open',
        answer: null,
        note: null,
      }
      this.asks.set(ask.id, ask)
    } else {
      const found = this.asks.get(path.split('/')[3])
      if (!found) throw new TetherError(404, 'not_found', {})
      ask = found
      if (method === 'POST' && path.endsWith('/answer')) {
        ask.state = 'answered'
        ask.answer = input.text as string
        ask.note = input.note as string | null
        ask.delivery = ask.session ? 'wake' : 'pull'
        ask.answerTo = ask.session
      }
    }
    return { status: 200, body: { ...ask } as T }
  }
}

interface Mockup {
  id: string
  project: string
  title: string
  note: string
  session: string | null
  askId: string
  selectedAt: string | null
  state: string
  viewUrl: string
  kind: string
  updatedAt: string
}

describe('mockup routes', () => {
  let directory: string
  let tether: MockupTether
  let server: Awaited<ReturnType<typeof serveRoutes>>
  const project = '../aico'
  const query = `?project=${encodeURIComponent(project)}`
  const start = () =>
    serveRoutes((router) => registerMockupRoutes(router, { dataDir: directory, tether }))
  const call = (path: string, body: unknown, method = 'POST') =>
    fetch(`${server.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const add = async (fields: Record<string, unknown> = {}) => {
    const response = await call('/api/mockups', {
      project,
      title: 'Compact layout',
      note: 'Keep the short labels',
      html: '<!doctype html><h1>Example</h1>',
      session: '0123abcd',
      ...fields,
    })
    expect(response.status).toBe(200)
    return (await response.json()) as { mockup: Mockup; pageUrl: string }
  }
  const list = async () =>
    (await (await fetch(`${server.base}/api/mockups${query}`)).json()) as { items: Mockup[] }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'aico-mockups-'))
    tether = new MockupTether()
    server = await start()
  })
  afterEach(async () => {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  })

  it('keeps one safe project file and its note across server restarts, without listing source HTML', async () => {
    expect((await list()).items).toEqual([])
    const { mockup, pageUrl } = await add()
    expect(pageUrl).toBe(`/workbench?tab=designs&project=..%2Faico&design=${mockup.id}`)
    expect(mockup).toMatchObject({
      project,
      note: 'Keep the short labels',
      state: 'pending',
      session: '0123abcd',
    })
    expect(mockup).not.toHaveProperty('html')
    expect(await readdir(join(directory, 'mockups'))).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}\.json$/),
    ])
    expect(
      (await call(`/api/mockups/${mockup.id}${query}`, { note: 'A saved review' }, 'PATCH')).status,
    ).toBe(200)
    await server.close()
    server = await start()
    expect((await list()).items[0]).toMatchObject({ id: mockup.id, note: 'A saved review' })
  })

  it('groups alternatives only for the same project and originating session', async () => {
    const first = (await add()).mockup
    const second = (await add({ title: 'Wide layout' })).mockup
    const other = (await add({ session: 'abcd0123' })).mockup
    expect(first.askId).toBe(second.askId)
    expect(other.askId).not.toBe(first.askId)
    expect(tether.calls.filter((call) => call.path === '/v1/asks')).toHaveLength(2)
  })

  it('sends the saved note to the original ask, selects once, and starts a fresh question for later work', async () => {
    const first = (await add()).mockup
    const alternative = (await add({ title: 'Wide layout' })).mockup
    const path = `/api/mockups/${first.id}/select${query}`
    const response = await call(path, { note: 'Use compact spacing' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      delivery: 'wake',
      answerTo: '0123abcd',
      mockup: { state: 'selected' },
    })
    expect(tether.asks.get(first.askId)).toMatchObject({
      session: '0123abcd',
      note: 'Use compact spacing',
      answer: `Use this one: Compact layout (${first.id})`,
    })
    expect((await call(path, {})).status).toBe(200)
    expect(tether.calls.filter((call) => call.path.endsWith('/answer'))).toHaveLength(1)
    expect((await call(`/api/mockups/${alternative.id}/select${query}`, {})).status).toBe(409)
    expect(
      (await call(`/api/mockups/${first.id}${query}`, { note: 'Too late' }, 'PATCH')).status,
    ).toBe(409)
    expect((await list()).items.map((item) => item.state)).toEqual(['selected', 'passed'])
    expect((await add()).mockup.askId).not.toBe(first.askId)
  })

  it('refuses to deliver an answer when the associated ask has a different origin', async () => {
    const { mockup } = await add()
    const ask = tether.asks.get(mockup.askId) as Ask
    ask.session = 'ffffffff'
    const response = await call(`/api/mockups/${mockup.id}/select${query}`, { session: 'ffffffff' })
    expect(response.status).toBe(409)
    expect(tether.calls.some((call) => call.path.endsWith('/answer'))).toBe(false)
    expect((await list()).items[0].state).toBe('pending')
  })

  it('keeps a failed delivery pending and a standalone CLI choice pull-only', async () => {
    const { mockup } = await add({ session: null })
    expect(tether.asks.get(mockup.askId)?.requester).toMatch(/^mockups:[0-9a-f]{12}$/)
    tether.unavailable = true
    expect((await call(`/api/mockups/${mockup.id}/select${query}`, {})).status).toBe(503)
    expect((await list()).items[0].state).toBe('pending')
    tether.unavailable = false
    const response = await call(`/api/mockups/${mockup.id}/select${query}`, {})
    expect(await response.json()).toMatchObject({
      delivery: 'pull',
      answerTo: null,
      mockup: { session: null, state: 'selected' },
    })
  })

  it('does not overwrite an answer made outside the mockup page', async () => {
    const { mockup } = await add()
    const ask = tether.asks.get(mockup.askId) as Ask
    ask.state = 'answered'
    ask.answer = 'Keep exploring'
    expect((await call(`/api/mockups/${mockup.id}/select${query}`, {})).status).toBe(409)
    expect(ask.answer).toBe('Keep exploring')
  })

  it('starts a new question when Tether no longer retains the old one', async () => {
    const first = (await add()).mockup
    tether.asks.delete(first.askId)
    const next = (await add()).mockup
    expect(next.state).toBe('pending')
    expect(tether.calls.filter((call) => call.path === '/v1/asks')).toHaveLength(2)
  })

  it('serves untrusted HTML only with sandbox CSP and same-origin embedding', async () => {
    const html =
      '<script>parent.document.body.textContent = "changed"; fetch("/api/sessions")</script>'
    const { mockup } = await add({ html })
    const response = await fetch(`${server.base}${mockup.viewUrl}`)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBe(MOCKUP_CSP)
    expect(MOCKUP_CSP).toContain('sandbox allow-scripts')
    expect(MOCKUP_CSP).not.toContain('allow-same-origin')
    expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe(html)
    expect(
      (await fetch(`${server.base}/api/mockups/${mockup.id}/view?project=another`)).status,
    ).toBe(404)
  })

  it.each([
    { project: '' },
    { title: 'two\nlines' },
    { html: '' },
    { html: undefined, kind: 'pdf', data: Buffer.from('not a pdf').toString('base64') },
    { html: undefined, kind: 'movie', content: 'x' },
    { session: 'bad' },
    { note: 'x'.repeat(1001) },
  ])('rejects invalid input %j without creating a question', async (fields) => {
    const response = await call('/api/mockups', {
      project,
      title: 'Example',
      html: '<p>Preview</p>',
      ...fields,
    })
    expect(response.status).toBe(422)
    expect(tether.calls).toHaveLength(0)
  })

  const PNG = Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
    Buffer.from('rest of a tiny image'),
  ])
  const view = (mockup: Mockup) => fetch(`${server.base}${mockup.viewUrl}`)

  it('replaces a design added again with the same title, keeping its place, question and note', async () => {
    const first = (await add()).mockup
    const again = await add({ html: '<h1>Second try</h1>', note: '' })
    expect(again.mockup.id).toBe(first.id)
    expect(again.mockup.askId).toBe(first.askId)
    expect(again.mockup.note).toBe('Keep the short labels')
    expect(Date.parse(again.mockup.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt))
    expect((await list()).items).toHaveLength(1)
    expect(await (await view(first)).text()).toBe('<h1>Second try</h1>')
    expect(tether.calls.filter((call) => call.path === '/v1/asks')).toHaveLength(1)
  })

  it('shows every kind of design: wrapped text in its sandbox, images and PDFs as themselves', async () => {
    const svg = (await add({ title: 'Logo', kind: 'svg', html: undefined, content: '<svg/>' }))
      .mockup
    const sheet = await view(svg)
    expect(sheet.headers.get('content-security-policy')).toBe(WRAPPED_CSP)
    expect(await sheet.text()).toContain('data:image/svg+xml;base64,')
    const diagram = (
      await add({
        title: 'Flow',
        kind: 'mermaid',
        html: undefined,
        content: 'flowchart LR\n A-->B',
      })
    ).mockup
    const wrapped = await (await view(diagram)).text()
    expect(wrapped).toContain('/vendor/mermaid-')
    expect(wrapped).toContain('A--&gt;B')
    const notes = (
      await add({
        title: 'Notes',
        kind: 'markdown',
        html: undefined,
        content: '# <script>x</script>',
      })
    ).mockup
    const markdown = await (await view(notes)).text()
    expect(markdown).not.toContain('<script>x</script>')
    expect(markdown).toContain('&lt;script&gt;x&lt;/script&gt;')
    const image = (
      await add({ title: 'Shot', kind: 'image', html: undefined, data: PNG.toString('base64') })
    ).mockup
    const shot = await view(image)
    expect(shot.headers.get('content-type')).toBe('image/png')
    expect(shot.headers.get('content-security-policy')).toContain('sandbox')
    expect(Buffer.from(await shot.arrayBuffer()).equals(PNG)).toBe(true)
    const pdf = (
      await add({
        title: 'Spec',
        kind: 'pdf',
        html: undefined,
        data: Buffer.from('%PDF-1.4 tiny').toString('base64'),
      })
    ).mockup
    expect((await view(pdf)).headers.get('content-type')).toBe('application/pdf')
    expect((await list()).items.map((item) => item.kind)).toEqual([
      'svg',
      'mermaid',
      'markdown',
      'image',
      'pdf',
    ])
  })

  it('lists the designs of every project when no project is named, and removes one with its question', async () => {
    const mine = (await add()).mockup
    await add({ project: 'other', title: 'Elsewhere', session: 'abcd0123' })
    const all = (await (await fetch(`${server.base}/api/mockups`)).json()) as {
      items: (Mockup & { project: string })[]
      unreadable: number
    }
    expect(all.items.map((item) => item.project).sort()).toEqual([project, 'other'])
    expect(all.unreadable).toBe(0)
    const removed = await fetch(`${server.base}/api/mockups/${mine.id}${query}`, {
      method: 'DELETE',
    })
    expect(removed.status).toBe(200)
    expect((await list()).items).toEqual([])
    expect(tether.calls.some((call) => call.path === `/v1/asks/${mine.askId}/withdraw`)).toBe(true)
    expect((await view(mine)).status).toBe(404)
  })

  it('wraps Markdown and diagrams in pages that load only the vendored viewers that are shipped', () => {
    const shipped = join(__dirname, '../../web-frontend/public')
    for (const kind of ['markdown', 'mermaid'] as const) {
      const scripts = [...viewDocument(kind, 'x', 'T').matchAll(/<script src="(\/vendor\/[^"]+)"/g)]
      expect(scripts.length).toBeGreaterThan(0)
      for (const [, src] of scripts) expect(existsSync(join(shipped, src))).toBe(true)
    }
    expect(WRAPPED_CSP).toContain("script-src 'self' 'unsafe-inline'")
    expect(WRAPPED_CSP).not.toContain('allow-same-origin')
  })
})
