import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { formatNote, runNote } from './note-cli'

describe('tether note', () => {
  let server: Server
  let url: string
  let requests: string[]

  beforeAll(async () => {
    requests = []
    server = createServer((req, res) => {
      const parts: Buffer[] = []
      req.on('data', (chunk: Buffer) => parts.push(chunk))
      req.on('end', () => {
        const text = Buffer.concat(parts).toString()
        requests.push(
          `${req.method} ${req.url}${text ? ` ${text}` : ''}${req.headers.origin ? ' (origin)' : ''}`,
        )
        const reply = (status: number, body: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(body))
        }
        if (req.method === 'POST' && req.url === '/api/notes/groceries/items') {
          const added = JSON.parse(text) as { text: string }
          return reply(201, {
            id: `i${requests.length}`,
            text: added.text,
            checked: false,
            hint: null,
          })
        }
        if (req.url === '/api/notes/groceries')
          return reply(200, {
            id: '0123456789ab',
            kind: 'list',
            title: 'Groceries',
            pinned: false,
            archived: false,
            editedAt: 1_700_000_000_000,
            labels: [],
            items: [
              { id: 'a1', text: 'milk', checked: true, hint: null },
              { id: 'a2', text: 'sea salt', checked: false, hint: 'struck' },
            ],
            attachments: [{ name: 'list.jpg', mime: 'image/jpeg' }],
          })
        if (req.url === '/api/notes' || req.url?.startsWith('/api/notes?'))
          return reply(200, {
            notes: [
              {
                id: '0123456789ab',
                kind: 'list',
                title: 'Groceries',
                pinned: true,
                archived: false,
                labels: ['home'],
                unchecked: 1,
                checked: 1,
              },
            ],
            total: 1,
          })
        reply(404, { detail: 'That note is gone' })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const capture = () => {
    const out: string[] = []
    const err: string[] = []
    return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err }
  }
  const env = () => ({ AICO_WEB_URL: url })

  it('adds to and shows the Groceries list, and lists notes', async () => {
    const add = capture()
    expect(
      await runNote(add.io, false, ['groceries', 'add', 'apples (3 bags)', 'eggs'], env()),
    ).toBe(0)
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([
      'POST /api/notes/groceries/items {"text":"apples (3 bags)"}',
      'POST /api/notes/groceries/items {"text":"eggs"}',
    ])
    expect(add.out.join('\n')).toMatch(/apples \(3 bags\)\n.+eggs/)

    const show = capture()
    expect(await runNote(show.io, false, ['groceries', 'show'], env())).toBe(0)
    const lines = show.out.join('\n').split('\n')
    expect(lines.findIndex((l) => l.includes('sea salt'))).toBeLessThan(
      lines.findIndex((l) => l.includes('milk')),
    ) // open items come first
    expect(show.out.join('\n')).toContain('[ ] a2  sea salt  (struck)')

    const list = capture()
    expect(await runNote(list.io, false, ['list', '--q', 'milk', '--json'], env())).toBe(0)
    expect(requests.at(-1)).toBe('GET /api/notes?q=milk')
    expect(JSON.parse(list.out.join('\n')).total).toBe(1)
    const plain = capture()
    await runNote(plain.io, false, ['list'], env())
    expect(plain.out.join('\n')).toBe('0123456789ab  list   *  Groceries  [1 open, 1 done]  #home')

    const gone = capture()
    expect(await runNote(gone.io, false, ['get', 'ffffffffffff'], env())).toBe(1)
    expect(gone.err[0]).toBe('tether note: That note is gone')
    expect(
      formatNote({
        id: 'x',
        kind: 'note',
        title: '',
        pinned: false,
        archived: false,
        editedAt: 0,
        labels: [],
      }),
    ).toContain('(untitled)')
  })
})
