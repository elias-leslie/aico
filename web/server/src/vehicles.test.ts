import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blobPath, putOriginal, putVariant } from './blobs'
import { CaptureRouter } from './capture-router'
import { buildTable } from './capture-types'
import { NotesStore } from './notes-db'
import { VehiclesOwner } from './owners/vehicles'

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 3)])
const PDF = Buffer.from('%PDF-1.4 invoice')

interface Posted {
  event: Record<string, unknown>
  files: { name: string; type: string; size: number }[]
  token: string | null
}

interface Car {
  type: 'odometer' | 'service_invoice' | 'vehicle_note' | 'note'
  kind?: 'image' | 'pdf' | 'audio' | 'text'
  mime?: string
  group?: string
  caption?: string
  text?: string
  reading?: Record<string, unknown>
  bytes?: Buffer
  status?: 'ready' | 'extracting'
}

describe('vehicles hand-off', () => {
  let dir: string
  let blobs: string
  let store: NotesStore
  let fake: Server
  let url: string
  let mode: 'ok' | number
  let health: boolean
  let posts: Posted[]
  let byCaptureId: Map<string, { body: string; id: string }>
  let n = 0

  const owner = () => new VehiclesOwner({ url, tokenFile: join(dir, 'token') })
  const router = () =>
    new CaptureRouter({
      store,
      blobsDir: blobs,
      table: buildTable(null),
      adapters: new Map([['vehicles', owner()]]),
      run: async () => {},
      log: () => {},
    })

  /** A capture as the extract worker leaves it. */
  async function car(r: CaptureRouter, spec: Car) {
    n += 1
    const kind = spec.kind ?? 'image'
    const mime =
      spec.mime ??
      { image: 'image/jpeg', pdf: 'application/pdf', audio: 'audio/mp4', text: 'text/plain' }[kind]
    const bytes =
      spec.bytes ?? Buffer.concat([kind === 'pdf' ? PDF : JPEG, Buffer.from(`car-${n}`)])
    const hash = await putOriginal(blobs, bytes)
    if (kind === 'image') await putVariant(blobs, hash, 'thumb', JPEG)
    const row = store.insertCapture({
      clientId: `client-${n}0000`,
      groupId: spec.group ?? `group-${n}`,
      kind,
      name: `file-${n}`,
      mime,
      size: bytes.length,
      hash,
      caption: spec.caption ?? '',
    }).capture
    store.claimForExtraction()
    if (spec.status === 'extracting') return store.getCapture(row.id)
    const done = store.finishExtraction(
      row.id,
      {
        type: spec.type,
        text: spec.text ?? '',
        json: JSON.stringify(spec.reading ?? {}),
        route: 'agy',
      },
      r.plan(spec.type),
    )
    await r.afterReady(done as never)
    return store.getCapture(row.id)
  }

  const odometer = { odometer: { odometer: 33396, trip: 44.6, unit: null } }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-vehicles-'))
    blobs = join(dir, 'blobs')
    writeFileSync(join(dir, 'token'), 'secret-token\n')
    store = new NotesStore(':memory:', { hostName: 'here' })
    mode = 'ok'
    health = true
    posts = []
    byCaptureId = new Map()
    fake = createServer((req, res) => {
      const parts: Buffer[] = []
      req.on('data', (chunk: Buffer) => parts.push(chunk))
      req.on('end', async () => {
        if (req.url === '/health') {
          res.statusCode = health ? 200 : 503
          return res.end('{}')
        }
        res.setHeader('content-type', 'application/json')
        if (mode !== 'ok') {
          res.statusCode = mode
          return res.end(JSON.stringify({ detail: 'nope' }))
        }
        const form = await new Request('http://x/', {
          method: 'POST',
          headers: { 'content-type': req.headers['content-type'] as string },
          body: Buffer.concat(parts),
        }).formData()
        const raw = String(form.get('event'))
        const event = JSON.parse(raw) as { capture_id: string }
        const files = (form.getAll('files') as File[]).map((f) => ({
          name: f.name,
          type: f.type,
          size: f.size,
        }))
        const body = JSON.stringify([raw, files])
        const earlier = byCaptureId.get(event.capture_id)
        if (earlier && earlier.body !== body) {
          res.statusCode = 409
          return res.end(JSON.stringify({ detail: 'different contents' }))
        }
        posts.push({
          event,
          files,
          token: (req.headers['x-portfolio-agent-token'] as string | undefined) ?? null,
        })
        const id = earlier?.id ?? `rev-${byCaptureId.size + 1}`
        byCaptureId.set(event.capture_id, { body, id })
        res.end(JSON.stringify({ id, duplicate: !!earlier, status: 'pending_review' }))
      })
    })
    return new Promise<void>((resolve) =>
      fake.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`
        resolve()
      }),
    )
  })
  afterEach(async () => {
    fake.closeAllConnections()
    await new Promise<void>((resolve) => fake.close(() => resolve()))
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a photo and a caption become one event with the photo; the copy is purged; a repeat is a duplicate', async () => {
    const r = router()
    const row = await car(r, {
      type: 'odometer',
      group: 'g1',
      caption: 'just changed the oil, rotated the tires',
      reading: { ...odometer, vehicle: { hint: '2019 Subaru Outback', date: null, services: [] } },
    })
    expect(row).toMatchObject({ owner: 'vehicles', route_state: 'suggested' })
    const before = store.getCapture(row?.id as string)
    const filed = await r.act(row?.id as string, 'send')
    expect(filed).toMatchObject({
      route_state: 'filed',
      owner_ref: 'rev-1',
      hash: null,
      extract_json: null,
      caption: 'just changed the oil, rotated the tires',
    })
    expect(posts).toHaveLength(1)
    expect(posts[0]?.token).toBe('secret-token')
    expect(posts[0]?.event).toMatchObject({
      vehicle_hint: '2019 Subaru Outback',
      odometer: { value: 33396, unit: 'mi' },
      services: [{ kind: 'just changed the oil, rotated the tires', note: '' }],
    })
    expect(posts[0]?.event.occurred_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(posts[0]?.files).toEqual([
      { name: 'vehicle-1.jpg', type: 'image/jpeg', size: JPEG.length + 5 },
    ])
    expect(existsSync(blobPath(blobs, row?.hash as string))).toBe(false)

    // Sending the same event again (the answer was lost) is a duplicate of the same review row.
    const again = await owner().send({
      capture: before as never,
      captureId: row?.id as string,
      bytes: new Uint8Array(0),
      mime: 'image/jpeg',
      kind: 'vehicle_event',
      storeName: '',
      note: '',
      group: [
        {
          capture: before as never,
          own: true,
          mime: 'image/jpeg',
          bytes: Buffer.concat([JPEG, Buffer.from('car-1')]),
        },
      ],
    })
    expect(again).toEqual({ state: 'filed', ref: 'rev-1' })
  })

  it('a photo and a transcribed voice note: one event, the audio is not sent, both are filed', async () => {
    const r = router()
    const photo = await car(r, { type: 'odometer', group: 'g2', reading: odometer })
    const voice = await car(r, {
      type: 'vehicle_note',
      kind: 'audio',
      group: 'g2',
      text: 'I just changed the oil and rotated the tires on the Outback',
      reading: {
        vehicle: {
          hint: 'Outback',
          date: '2026-11-01',
          services: [
            { kind: 'oil change', note: '' },
            { kind: 'tire rotation', note: '' },
          ],
        },
      },
    })
    await r.act(photo?.id as string, 'send')
    expect(posts).toHaveLength(1)
    expect(posts[0]?.event).toMatchObject({
      vehicle_hint: 'Outback',
      occurred_on: '2026-11-01',
      odometer: { value: 33396, unit: 'mi' },
      services: [
        { kind: 'oil change', note: '' },
        { kind: 'tire rotation', note: '' },
      ],
    })
    expect(posts[0]?.files).toHaveLength(1)
    for (const row of [photo, voice]) {
      expect(store.getCapture(row?.id as string)).toMatchObject({
        route_state: 'filed',
        owner_ref: 'rev-1',
        hash: null,
      })
      expect(existsSync(blobPath(blobs, row?.hash as string))).toBe(false)
    }
  })

  it('a voice note alone sends services with no files', async () => {
    const r = router()
    const voice = await car(r, {
      type: 'vehicle_note',
      kind: 'audio',
      group: 'g3',
      text: 'changed the oil',
    })
    await r.act(voice?.id as string, 'send')
    expect(posts[0]?.files).toEqual([])
    expect(posts[0]?.event).toMatchObject({
      odometer: null,
      vehicle_hint: null,
      services: [{ kind: 'changed the oil', note: '' }],
    })
  })

  it('an invoice PDF goes as the file with its own services, date and km', async () => {
    const r = router()
    const invoice = await car(r, {
      type: 'service_invoice',
      kind: 'pdf',
      group: 'g4',
      reading: {
        odometer: { odometer: 61000, trip: null, unit: 'km' },
        vehicle: {
          hint: 'VIN 5NPE24AF8GH334607',
          date: '2026-10-30',
          services: [{ kind: 'brake pads', note: 'front, Pep Boys, $189' }],
        },
      },
    })
    await r.act(invoice?.id as string, 'send')
    expect(posts[0]?.event).toEqual({
      capture_id: posts[0]?.event.capture_id,
      vehicle_hint: 'VIN 5NPE24AF8GH334607',
      occurred_on: '2026-10-30',
      odometer: { value: 61000, unit: 'km' },
      services: [{ kind: 'brake pads', note: 'front, Pep Boys, $189' }],
    })
    expect(posts[0]?.files[0]).toMatchObject({ name: 'vehicle-1.pdf', type: 'application/pdf' })
  })

  it('the same group is the same capture_id from either member', async () => {
    const r = router()
    const a = await car(r, { type: 'odometer', group: 'g5', reading: odometer })
    const b = await car(r, { type: 'service_invoice', kind: 'pdf', group: 'g5' })
    await r.act(b?.id as string, 'send')
    expect(store.getCapture(a?.id as string)?.route_state).toBe('filed')
    expect(posts[0]?.files).toHaveLength(2)
  })

  it('a 409 is a visible failure and the maintenance pass does not retry it', async () => {
    const r = router()
    const row = await car(r, { type: 'odometer', group: 'g6', reading: odometer })
    // portfolio-ai already holds this group with other contents.
    byCaptureId.set((await import('./owners/vehicles')).eventId(row as never), {
      body: 'something else',
      id: 'rev-x',
    })
    const failed = await r.act(row?.id as string, 'send')
    expect(failed).toMatchObject({ route_state: 'failed', owner_ref: null })
    expect(failed.route_note).toContain('different car event')
    expect(existsSync(blobPath(blobs, row?.hash as string))).toBe(true)
    const before = posts.length
    await r.tick()
    expect(posts).toHaveLength(before)
    expect(store.getCapture(row?.id as string)?.route_state).toBe('failed')
  })

  it('waits while VM 180 is off and the next maintenance pass sends it', async () => {
    const r = router()
    const row = await car(r, { type: 'odometer', group: 'g7', reading: odometer })
    mode = 503
    expect(await r.act(row?.id as string, 'send')).toMatchObject({ route_state: 'waiting' })
    health = false
    await r.tick()
    expect(store.getCapture(row?.id as string)?.route_state).toBe('waiting')
    health = true
    mode = 'ok'
    await r.tick()
    expect(store.getCapture(row?.id as string)).toMatchObject({
      route_state: 'filed',
      owner_ref: 'rev-1',
    })
  })

  it('waits while another file of the group is still being read', async () => {
    const r = router()
    const photo = await car(r, { type: 'odometer', group: 'g8', reading: odometer })
    await car(r, { type: 'vehicle_note', kind: 'audio', group: 'g8', status: 'extracting' })
    const waiting = await r.act(photo?.id as string, 'send')
    expect(waiting).toMatchObject({
      route_state: 'waiting',
      route_note: 'Still reading the other files in this group',
    })
    expect(posts).toHaveLength(0)
  })

  it('leaves out a file the owner said is not about a car', async () => {
    const r = router()
    const photo = await car(r, { type: 'odometer', group: 'g9', reading: odometer })
    const other = await car(r, { type: 'service_invoice', kind: 'pdf', group: 'g9' })
    await r.act(other?.id as string, 'not_this')
    await r.act(photo?.id as string, 'send')
    expect(posts[0]?.files).toHaveLength(1)
    expect(store.getCapture(other?.id as string)?.route_state).toBe('kept')
  })
})
