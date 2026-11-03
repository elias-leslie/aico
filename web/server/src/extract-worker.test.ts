import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blobPath, putOriginal } from './blobs'
import { type Extractor, ExtractWorker } from './extract-worker'
import { PreviewJobs } from './heic'
import { NotesStore } from './notes-db'
import { ExtractError } from './vision-extract'

const GOOD = {
  type: 'grocery_list',
  title: 'List',
  text: 'milk\neggs',
  summary: 's',
  lines: [],
  items: [],
  receipt: null,
  odometer: null,
  vehicle: null,
}

describe('extract worker', () => {
  let dir: string
  let store: NotesStore
  let calls: { file: string; hint?: string }[]
  let extractor: Extractor
  let route: 'agy' | 'ollama'
  let failWith: Error | null
  let previews: PreviewJobs
  let converts: boolean
  let n = 0

  const worker = () =>
    new ExtractWorker({
      store,
      blobsDir: join(dir, 'blobs'),
      previews,
      extract: extractor,
      concurrency: 2,
      workDir: dir,
      log: () => {},
    })

  async function add(
    kind: 'image' | 'text' | 'doc' | 'audio',
    mime: string,
    bytes: string,
    caption = '',
  ) {
    n += 1
    const hash = await putOriginal(join(dir, 'blobs'), Buffer.from(bytes))
    return store.insertCapture({
      clientId: `client-${n}0000`,
      kind,
      name: `f${n}`,
      mime,
      size: bytes.length,
      hash,
      caption,
    }).capture
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-worker-'))
    store = new NotesStore(':memory:', { hostName: 'here' })
    calls = []
    route = 'agy'
    failWith = null
    converts = true
    previews = new PreviewJobs(join(dir, 'blobs'), async (argv) => {
      if (!converts) return 1
      writeFileSync(argv.at(-1) as string, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]))
      return 0
    })
    extractor = async (request) => {
      calls.push({ file: readlinkSync(request.file), hint: request.hint })
      if (failWith) throw failWith
      return { json: GOOD, raw: '', route, ms: 5 }
    }
  })
  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a new image into ready with text, type and JSON; the stamp moves each step', async () => {
    const row = await add('image', 'image/jpeg', 'jpeg-bytes', 'groceries')
    const w = worker()
    w.kick()
    expect(store.getCapture(row.id)?.status).toBe('extracting')
    await w.idle()
    const done = store.getCapture(row.id)
    expect(done).toMatchObject({
      status: 'ready',
      type: 'grocery_list',
      text: 'milk\neggs',
      extract_route: 'agy',
      extract_error: null,
    })
    expect(JSON.parse(done?.extract_json as string).title).toBe('List')
    expect(done?.seq).toBeGreaterThan(row.seq + 1)
    expect(calls).toEqual([
      { file: blobPath(join(dir, 'blobs'), row.hash as string), hint: 'groceries' },
    ])
  })

  it('plans the route in the same write that makes it ready, then tells the router', async () => {
    const row = await add('image', 'image/jpeg', 'receipt-bytes')
    const told: string[] = []
    const w = new ExtractWorker({
      store,
      blobsDir: join(dir, 'blobs'),
      previews,
      extract: extractor,
      concurrency: 1,
      workDir: dir,
      log: () => {},
      router: {
        plan: (type) =>
          type === 'grocery_list' ? { owner: 'notes', state: 'suggested', note: 'soon' } : null,
        afterReady: async (ready) => {
          told.push(`${ready.id}:${ready.route_state}`)
        },
      },
    })
    w.kick()
    await w.idle()
    expect(store.getCapture(row.id)).toMatchObject({
      status: 'ready',
      owner: 'notes',
      route_state: 'suggested',
      route_note: 'soon',
    })
    expect(told).toEqual([`${row.id}:suggested`])
  })

  it('plans no route for a capture the owner already attached to a note', async () => {
    const row = await add('image', 'image/jpeg', 'note-photo')
    const note = store.notes.create({ kind: 'note', title: 'Odometer' })
    store.notes.attach(note.id, {
      captureId: row.id,
      hash: row.hash as string,
      name: row.name,
      mime: row.mime,
      size: row.size,
    })
    const told: string[] = []
    const w = new ExtractWorker({
      store,
      blobsDir: join(dir, 'blobs'),
      previews,
      extract: extractor,
      concurrency: 1,
      workDir: dir,
      log: () => {},
      router: {
        plan: () => ({ owner: 'notes', state: 'suggested', note: null }),
        afterReady: async (ready) => {
          told.push(ready.id)
        },
      },
    })
    w.kick()
    await w.idle()
    expect(store.getCapture(row.id)).toMatchObject({
      status: 'ready',
      owner: null,
      route_state: null,
    })
    expect(told).toEqual([row.id])
  })

  it('fails with a plain reason, and Retry reads it again', async () => {
    const row = await add('image', 'image/png', 'png-bytes')
    failWith = new ExtractError("the main reader isn't available", ['agy failed to run'])
    const w = worker()
    w.kick()
    await w.idle()
    expect(store.getCapture(row.id)).toMatchObject({
      status: 'failed',
      extract_error: "the main reader isn't available",
    })
    failWith = null
    expect(store.retryExtraction(row.id)?.status).toBe('new')
    expect(store.retryExtraction(row.id)).toBeNull()
    w.kick()
    await w.idle()
    expect(store.getCapture(row.id)?.status).toBe('ready')
  })

  it('reads a HEIC through its preview, and fails plainly when there is none', async () => {
    const row = await add('image', 'image/heic', 'heic-bytes')
    const w = worker()
    w.kick()
    await w.idle()
    expect(calls[0]?.file).toBe(blobPath(join(dir, 'blobs'), row.hash as string, 'preview'))
    converts = false
    const second = await add('image', 'image/heic', 'other-heic')
    w.kick()
    await w.idle()
    expect(store.getCapture(second.id)).toMatchObject({ status: 'failed' })
  })

  it('needs no call for text, marks other kinds ready with no text, and requeues after a restart', async () => {
    const text = await add('text', 'text/plain', 'buy milk')
    const doc = await add('doc', 'application/vnd.oasis.opendocument.text', 'zip')
    const stuck = await add('image', 'image/jpeg', 'stuck')
    store.claimForExtraction() // text
    store.claimForExtraction() // doc
    store.claimForExtraction() // stuck, then the server restarts
    const w = worker()
    w.start()
    await w.idle()
    expect(store.getCapture(text.id)).toMatchObject({
      status: 'ready',
      type: 'note',
      text: 'buy milk',
    })
    expect(store.getCapture(doc.id)).toMatchObject({ status: 'ready', text: null })
    expect(store.getCapture(stuck.id)?.status).toBe('ready')
    expect(calls).toHaveLength(1)
  })
})
