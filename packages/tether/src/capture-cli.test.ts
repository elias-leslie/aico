import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { blobPathHere, formatCapture, runCapture } from './capture-cli'

const BYTES = Buffer.from('%PDF-1.7\nhello capture\n')
const HASH = createHash('sha256').update(BYTES).digest('hex')

function item(fields: Record<string, unknown> = {}) {
  return {
    id: '0123456789ab',
    clientId: 'client-0001',
    groupId: null,
    askId: null,
    kind: 'pdf',
    name: 'invoice.pdf',
    mime: 'application/pdf',
    size: BYTES.length,
    hash: HASH,
    caption: 'oil change',
    status: 'ready',
    type: null,
    text: 'Total 42.00',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    origin: 'gem',
    hasThumb: false,
    previewState: 'unavailable',
    ...fields,
  }
}

function capture() {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) }, out, err }
}

describe('tether capture', () => {
  let server: Server
  let url: string
  let requests: string[]
  let download: Buffer
  let dir: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}${req.headers.origin ? ' (origin)' : ''}`)
      const reply = (status: number, body: unknown, type = 'application/json') => {
        res.statusCode = status
        res.setHeader('Content-Type', type)
        res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
      }
      const path = new URL(req.url ?? '/', 'http://x').pathname
      if (path === '/api/captures')
        return reply(200, {
          captures: [item(), item({ id: 'ba9876543210', caption: '' })],
          total: 3,
        })
      if (path === '/api/captures/0123456789ab') return reply(200, item())
      if (path === '/api/captures/cccccccccccc')
        return reply(
          200,
          item({
            id: 'cccccccccccc',
            type: 'grocery_list',
            needsCheck: true,
            extractRoute: 'ollama',
            extract: {
              title: 'Shopping',
              summary: 'A list.',
              items: [{ as_written: 'see weeds', item: 'seaweed', quantity: '2', struck: false }],
            },
          }),
        )
      if (path === '/api/captures/dddddddddddd')
        return reply(200, item({ id: 'dddddddddddd', status: 'failed', extractError: 'no reader' }))
      if (path === '/api/captures/0123456789ab/file') return reply(200, download, 'application/pdf')
      if (path === '/api/captures/aaaaaaaaaaaa')
        return reply(200, item({ id: 'aaaaaaaaaaaa', hash: null, status: 'filed' }))
      if (path === '/api/captures/bbbbbbbbbbbb')
        return reply(200, item({ id: 'bbbbbbbbbbbb', hash: HASH.replace(/^./, '0') }))
      reply(404, { detail: 'That capture is gone' })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  beforeEach(() => {
    requests = []
    download = BYTES
    dir = mkdtempSync(join(tmpdir(), 'tether-capture-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const env = () => ({ AICO_WEB_URL: url, AICO_DATA_DIR: join(dir, 'data'), HOME: dir })

  it('lists captures, newest first, with a note when there are more', async () => {
    const run = capture()
    expect(
      await runCapture(
        run.io,
        false,
        ['list', '--status', 'ready', '--ask', 'abc', '--limit', '2'],
        env(),
      ),
    ).toBe(0)
    expect(requests).toEqual(['GET /api/captures?status=ready&ask=abc&limit=2'])
    expect(run.out[0]).toMatch(
      /^0123456789ab {2}ready\s+pdf\s+\d+ KB {2}invoice\.pdf {2}"oil change"$/,
    )
    expect(run.out[1]).toMatch(/^ba9876543210 /)
    expect(run.out.at(-1)).toBe('(2 of 3; use --limit N for more)')
  })

  it('prints the raw JSON with --json, from the global flag or its own', async () => {
    for (const [global, args] of [
      [true, ['list']],
      [false, ['list', '--json']],
    ] as const) {
      const run = capture()
      expect(await runCapture(run.io, global, [...args], env())).toBe(0)
      expect(JSON.parse(run.out.join('\n')).total).toBe(3)
    }
  })

  it('shows one capture with its caption and extracted text', async () => {
    const run = capture()
    expect(await runCapture(run.io, false, ['get', '0123456789ab'], env())).toBe(0)
    const text = run.out.join('\n')
    expect(text).toContain('0123456789ab  invoice.pdf')
    expect(text).toContain('ready · pdf (application/pdf)')
    expect(text).toContain('caption | oil change')
    expect(text).toContain('text | Total 42.00')
    expect(text).toContain('tether capture file 0123456789ab')
  })

  it('shows the route and owner of a capture that was suggested, waiting or filed', () => {
    const route = (fields: Record<string, unknown>) => ({
      state: 'suggested',
      owner: 'portfolio-ai',
      ownerLabel: 'Portfolio AI',
      ownerRef: null,
      note: null,
      url: null,
      ...fields,
    })
    expect(formatCapture(item({ route: route({}) }) as never)).toContain(
      'route: suggested -> portfolio-ai',
    )
    expect(
      formatCapture(
        item({
          route: route({ state: 'waiting', note: 'Portfolio AI had an error (503)' }),
        }) as never,
      ),
    ).toContain('route: waiting -> portfolio-ai: Portfolio AI had an error (503)')
    expect(
      formatCapture(item({ route: route({ state: 'filed', ownerRef: 'pf-9' }) }) as never),
    ).toContain('route: filed -> portfolio-ai (their id pf-9)')
    expect(formatCapture(item() as never)).not.toContain('route:')
  })

  it('shows what was read with result, and says plainly when there is none yet', async () => {
    const run = capture()
    expect(await runCapture(run.io, false, ['result', 'cccccccccccc'], env())).toBe(0)
    const text = run.out.join('\n')
    expect(text).toContain('grocery_list  Shopping')
    expect(text).toContain('check it')
    expect(text).toContain('item | seaweed x 2 (written: see weeds)')
    const json = capture()
    expect(await runCapture(json.io, false, ['result', 'cccccccccccc', '--json'], env())).toBe(0)
    expect(JSON.parse(json.out.join('\n'))).toMatchObject({
      type: 'grocery_list',
      route: 'ollama',
      needsCheck: true,
    })
    const failed = capture()
    expect(await runCapture(failed.io, false, ['result', 'dddddddddddd'], env())).toBe(1)
    expect(failed.err[0]).toContain('could not be read: no reader')
  })

  it('sends no Origin, so the guard lets it through', async () => {
    await runCapture(capture().io, false, ['get', '0123456789ab'], env())
    expect(requests.every((request) => !request.includes('(origin)'))).toBe(true)
  })

  it('prints the blob path on this host', async () => {
    const path = blobPathHere(HASH, env())
    expect(path).toBe(join(dir, 'data', 'blobs', HASH.slice(0, 2), HASH))
    mkdirSync(join(dir, 'data', 'blobs', HASH.slice(0, 2)), { recursive: true })
    writeFileSync(path, BYTES)
    const run = capture()
    expect(await runCapture(run.io, false, ['file', '0123456789ab'], env())).toBe(0)
    expect(run.out).toEqual([path])
    expect(requests).toEqual(['GET /api/captures/0123456789ab'])
  })

  it('says the file is elsewhere when it is not on this host', async () => {
    const run = capture()
    expect(await runCapture(run.io, false, ['file', '0123456789ab'], env())).toBe(1)
    expect(run.err[0]).toContain('not stored on this host')
    expect(run.err[0]).toContain('--out DIR')
  })

  it('downloads into --out, named by id, after checking the hash', async () => {
    const run = capture()
    const out = join(dir, 'got')
    expect(await runCapture(run.io, false, ['file', '0123456789ab', '--out', out], env())).toBe(0)
    const target = join(out, '0123456789ab-invoice.pdf')
    expect(run.out).toEqual([target])
    expect(readFileSync(target).equals(BYTES)).toBe(true)
    expect(statSync(target).mode & 0o777).toBe(0o600)
  })

  it('saves nothing when the download does not match the hash', async () => {
    download = Buffer.from('tampered')
    const run = capture()
    const out = join(dir, 'got')
    expect(await runCapture(run.io, false, ['file', '0123456789ab', '--out', out], env())).toBe(1)
    expect(run.err[0]).toContain('does not match its hash')
    expect(() => statSync(out)).toThrow()
  })

  it('says so when the file was handed off', async () => {
    const run = capture()
    expect(await runCapture(run.io, false, ['file', 'aaaaaaaaaaaa'], env())).toBe(1)
    expect(run.err[0]).toContain('handed off')
  })

  it("reports the server's plain-words error and exits 1", async () => {
    const run = capture()
    expect(await runCapture(run.io, false, ['get', 'ffffffffffff'], env())).toBe(1)
    expect(run.err).toEqual(['tether capture: That capture is gone'])
  })

  it('says Aico is not reachable (exit 2) when nothing answers', async () => {
    const run = capture()
    expect(await runCapture(run.io, false, ['list'], { AICO_WEB_URL: 'http://127.0.0.1:1' })).toBe(
      2,
    )
    expect(run.err[0]).toContain('Aico is not reachable at http://127.0.0.1:1')
  })

  it('rejects bad arguments with the usage', async () => {
    for (const args of [
      [],
      ['bogus'],
      ['get'],
      ['get', 'a', 'b'],
      ['list', 'extra'],
      ['list', '--status', 'weird'],
      ['list', '--nope', '1'],
      ['list', '--status'],
    ]) {
      const run = capture()
      expect(await runCapture(run.io, false, args, env()), args.join(' ')).toBe(2)
      expect(run.err.length).toBeGreaterThan(0)
    }
    expect(requests).toEqual([])
  })
})
