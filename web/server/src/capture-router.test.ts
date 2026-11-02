import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blobPath, putOriginal, putVariant } from './blobs'
import { CaptureRouter, routeKey } from './capture-router'
import { buildTable, loadCaptureTypes } from './capture-types'
import { NotesStore } from './notes-db'
import type { Notice } from './notice'
import { PortfolioAiOwner, uuidV5 } from './owners/portfolio-ai'
import type { OwnerAdapter } from './owners/types'

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)])

interface Seen {
  clientId: string
  kind: string
  storeName: string
  note: string
  memberScope: string
  token: string | null
  bytes: number
}

describe('capture router and the portfolio-ai owner', () => {
  let dir: string
  let blobs: string
  let store: NotesStore
  let fake: Server
  let url: string
  let mode: 'ok' | number
  let seen: Seen[]
  let byClient: Map<string, string>
  let health: boolean
  let sent: { argv: string[]; notice?: Notice }[]
  let n = 0

  const tokenFile = () => join(dir, 'token')
  const owner = (override = url) => new PortfolioAiOwner({ url: override, tokenFile: tokenFile() })
  const router = (adapters = new Map<string, OwnerAdapter>([['portfolio-ai', owner()]])) =>
    new CaptureRouter({
      store,
      blobsDir: blobs,
      table: buildTable(null),
      adapters,
      ownerUrls: { 'portfolio-ai': 'https://portfolio.example/capture' },
      publicHost: 'aico.example',
      run: async (argv, _ms, input) => {
        sent.push({ argv, notice: input ? (JSON.parse(input) as Notice) : undefined })
      },
      log: () => {},
    })

  /** A read capture, as the extract worker leaves it: ready, typed, with its route planned. */
  async function ready(r: CaptureRouter, type: string, bytes = 'receipt-photo') {
    n += 1
    const hash = await putOriginal(blobs, Buffer.concat([JPEG, Buffer.from(bytes)]))
    await putVariant(blobs, hash, 'thumb', JPEG)
    const row = store.insertCapture({
      clientId: `client-${n}0000`,
      kind: 'image',
      name: 'r.jpg',
      mime: 'image/jpeg',
      size: 10,
      hash,
      caption: 'Costco',
    }).capture
    store.claimForExtraction()
    const done = store.finishExtraction(
      row.id,
      {
        type,
        text: 'TOTAL 1.00',
        json: JSON.stringify({ receipt: { store: 'Costco' } }),
        route: 'agy',
      },
      r.plan(type),
    )
    await r.afterReady(done as never)
    return store.getCapture(row.id)
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aico-router-'))
    blobs = join(dir, 'blobs')
    writeFileSync(tokenFile(), 'secret-token\n')
    store = new NotesStore(':memory:', { hostName: 'here' })
    mode = 'ok'
    seen = []
    byClient = new Map()
    health = true
    sent = []
    fake = createServer((req, res) => {
      const parts: Buffer[] = []
      req.on('data', (chunk: Buffer) => parts.push(chunk))
      req.on('end', async () => {
        if (req.url === '/health') {
          res.statusCode = health ? 200 : 503
          return res.end('{}')
        }
        if (mode !== 'ok') {
          res.statusCode = mode
          return res.end(
            JSON.stringify({ detail: 'Use a JPEG, PNG or WebP photo, or a PDF receipt.' }),
          )
        }
        const form = await new Request('http://x/', {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] as string },
          body: Buffer.concat(parts),
        }).formData()
        const clientId = String(form.get('client_id'))
        if (!byClient.has(clientId)) byClient.set(clientId, `pf-${byClient.size + 1}`)
        seen.push({
          clientId,
          kind: String(form.get('kind')),
          storeName: String(form.get('store_name')),
          note: String(form.get('note')),
          memberScope: String(form.get('member_scope')),
          token: (req.headers['x-portfolio-agent-token'] as string | undefined) ?? null,
          bytes: (form.get('file') as File).size,
        })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ id: byClient.get(clientId) }))
      })
    })
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    fake.closeAllConnections()
    await new Promise<void>((resolve) => fake.close(() => resolve()))
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('suggests a receipt with one tray todo; Send files it and purges Aico copy; a repeat is the same row', async () => {
    const r = router()
    const row = await ready(r, 'receipt')
    expect(row).toMatchObject({ status: 'ready', owner: 'portfolio-ai', route_state: 'suggested' })
    expect(r.describe(row as never)).toMatchObject({
      question: 'Send to Portfolio AI as a receipt?',
      notLabel: 'Not a receipt',
      canSend: true,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.notice).toMatchObject({
      kind: 'todo',
      push: 'tray',
      key: routeKey(row?.id as string),
      open: `https://aico.example/captures?id=${row?.id}`,
    })
    expect(JSON.stringify(sent[0]?.notice)).not.toContain('Costco')

    const filed = await r.act(row?.id as string, 'send')
    expect(filed).toMatchObject({
      status: 'filed',
      route_state: 'filed',
      owner_ref: 'pf-1',
      hash: null,
      text: null,
      extract_json: null,
      type: 'receipt',
      caption: 'Costco',
    })
    expect(seen[0]).toMatchObject({
      clientId: uuidV5(row?.id as string),
      kind: 'receipt',
      storeName: 'Costco',
      note: 'Costco',
      memberScope: 'local',
      token: 'secret-token',
    })
    expect(existsSync(blobPath(blobs, row?.hash as string))).toBe(false)
    expect(existsSync(blobPath(blobs, row?.hash as string, 'thumb'))).toBe(false)
    expect(sent[1]?.argv).toEqual([
      'nightshift',
      'resolve',
      routeKey(row?.id as string),
      '--text',
      'Sent from Aico.',
    ])
    expect(r.describe(filed)?.url).toBe('https://portfolio.example/capture')

    // The same capture sent again (a retry) answers with the same Portfolio AI row.
    const again = await owner().send({
      captureId: row?.id as string,
      bytes: JPEG,
      mime: 'image/jpeg',
      kind: 'receipt',
      storeName: '',
      note: '',
    })
    expect(again).toEqual({ state: 'filed', ref: 'pf-1' })
    expect(byClient.size).toBe(1)
  })

  it('waits when Portfolio AI errors or is not there, and the next tick sends it', async () => {
    const r = router()
    const row = await ready(r, 'receipt')
    mode = 503
    const waiting = await r.act(row?.id as string, 'send')
    expect(waiting).toMatchObject({ route_state: 'waiting', status: 'ready' })
    expect(waiting.route_note).toContain('503')
    expect(existsSync(blobPath(blobs, row?.hash as string))).toBe(true)

    health = false
    await r.tick()
    expect(store.getCapture(row?.id as string)?.route_state).toBe('waiting')
    health = true
    mode = 'ok'
    await r.tick()
    expect(store.getCapture(row?.id as string)).toMatchObject({
      route_state: 'filed',
      owner_ref: 'pf-1',
    })

    // Connection refused (the forwarder is down) waits too.
    const dead = createServer()
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    const offline = router(new Map([['portfolio-ai', owner(deadUrl)]]))
    const second = await ready(offline, 'receipt', 'second')
    const result = await offline.act(second?.id as string, 'send')
    expect(result).toMatchObject({
      route_state: 'waiting',
      route_note: "Portfolio AI isn't answering right now",
    })
    await offline.tick() // not reachable: nothing changes
    expect(store.getCapture(second?.id as string)?.route_state).toBe('waiting')
  })

  it('fails with a plain reason on a 4xx, and Send tries again', async () => {
    const r = router()
    const row = await ready(r, 'receipt')
    mode = 415
    const failed = await r.act(row?.id as string, 'send')
    expect(failed).toMatchObject({ route_state: 'failed', status: 'ready' })
    expect(failed.route_note).toBe(
      'Portfolio AI said no (415): Use a JPEG, PNG or WebP photo, or a PDF receipt.',
    )
    mode = 'ok'
    expect((await r.act(row?.id as string, 'send')).route_state).toBe('filed')
  })

  it('keeps the file for another capture with the same bytes', async () => {
    const r = router()
    const first = await ready(r, 'receipt', 'same')
    const second = await ready(r, 'receipt', 'same')
    expect(first?.hash).toBe(second?.hash)
    await r.act(first?.id as string, 'send')
    expect(existsSync(blobPath(blobs, second?.hash as string))).toBe(true)
  })

  it('leaves notes and vehicle types ready with a suggestion that says why, and no todo', async () => {
    const r = router()
    const grocery = await ready(r, 'grocery_list')
    const car = await ready(r, 'odometer')
    expect(grocery).toMatchObject({ route_state: 'suggested', owner: 'notes' })
    expect(r.describe(grocery as never)).toMatchObject({ canSend: false })
    expect(grocery?.route_note).toContain('Notes')
    expect(car?.route_note).toContain('Vehicles come later')
    expect(sent).toHaveLength(0)
    await expect(r.act(car?.id as string, 'send')).rejects.toThrow("isn't set up")
    // A type nobody takes gets no route at all.
    expect((await ready(r, 'other'))?.route_state).toBeNull()
  })

  it('Not a receipt retypes it and clears the todo; Keep here keeps the type', async () => {
    const r = router()
    const a = await ready(r, 'receipt', 'a')
    const b = await ready(r, 'receipt', 'b')
    expect(await r.act(a?.id as string, 'not_this')).toMatchObject({
      type: 'other',
      route_state: 'kept',
    })
    expect(await r.act(b?.id as string, 'keep')).toMatchObject({
      type: 'receipt',
      route_state: 'kept',
    })
    expect(sent.filter((s) => s.argv[1] === 'resolve')).toHaveLength(2)
    await expect(r.act(b?.id as string, 'keep')).rejects.toThrow('nothing to decide')
  })

  it('the type table drives this: a new row is a new type with no code', async () => {
    const file = join(dir, 'capture-types.json')
    writeFileSync(
      file,
      JSON.stringify({
        types: [
          {
            id: 'warranty',
            label: 'Warranty',
            owner: 'portfolio-ai',
            owner_kind: 'receipt',
            confirm: true,
            keep_copy: true,
            question: 'Send the warranty to Portfolio AI?',
          },
          { id: 'receipt', label: 'Receipt', owner: null },
          { id: 'broken' },
        ],
      }),
    )
    const problems: string[] = []
    const table = loadCaptureTypes(file, (m) => problems.push(m))
    expect(problems).toHaveLength(1)
    const custom = new CaptureRouter({
      store,
      blobsDir: blobs,
      table,
      adapters: new Map([['portfolio-ai', owner()]]),
      run: async () => {},
      log: () => {},
    })
    expect(custom.plan('warranty')).toEqual({
      owner: 'portfolio-ai',
      state: 'suggested',
      note: null,
    })
    expect(custom.plan('receipt')).toBeNull() // the owner's file replaced the default row
    const row = await ready(custom, 'warranty')
    const filed = await custom.act(row?.id as string, 'send')
    // keep_copy: true, so the file and text stay.
    expect(filed).toMatchObject({ route_state: 'filed', text: 'TOTAL 1.00' })
    expect(filed.hash).not.toBeNull()
    expect(loadCaptureTypes(join(dir, 'missing.json'), () => {}).type('receipt')?.owner).toBe(
      'portfolio-ai',
    )
  })
})
