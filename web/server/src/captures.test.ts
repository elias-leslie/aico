import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ask } from './asks'
import { blobPath, sha256 } from './blobs'
import { CaptureRouter } from './capture-router'
import { buildTable } from './capture-types'
import { type CaptureJson, registerCaptureRoutes } from './captures'
import { PreviewJobs, type Runner } from './heic'
import { NotesStore } from './notes-db'
import { serveRoutes } from './testing'
import { HttpError } from './tether'

const MAX_BYTES = 1024 * 1024
const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(64, 7)])
const PDF = Buffer.from('%PDF-1.7\nfake body\n')
const HEIC = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from('ftypheic', 'latin1'),
  Buffer.alloc(32, 1),
])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)])
const PREVIEW_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.alloc(16, 5)])

describe('capture routes', () => {
  let dir: string
  let blobs: string
  let store: NotesStore
  let server: Awaited<ReturnType<typeof serveRoutes>>
  let previews: PreviewJobs
  let runnerCalls: string[][]
  let converterWorks: boolean
  let counter: number
  let kicks: number

  const runner: Runner = async (argv) => {
    runnerCalls.push(argv)
    if (!converterWorks) return 1
    writeFileSync(argv.at(-1) as string, PREVIEW_JPEG)
    return 0
  }

  function upload(
    content: Buffer | string,
    name: string,
    type: string,
    fields: Record<string, string> = {},
  ) {
    counter += 1
    const form = new FormData()
    form.append('file', new Blob([content], { type }), name)
    form.append('client_id', fields.client_id ?? `client-${String(counter).padStart(4, '0')}`)
    for (const [key, value] of Object.entries(fields))
      if (key !== 'client_id') form.append(key, value)
    return fetch(`${server.base}/api/captures`, { method: 'POST', body: form })
  }

  const created = async (response: Response) => (await response.json()) as CaptureJson

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aico-captures-'))
    blobs = join(dir, 'blobs')
    store = new NotesStore(':memory:', { hostName: 'test-host' })
    runnerCalls = []
    converterWorks = true
    counter = 0
    kicks = 0
    previews = new PreviewJobs(blobs, runner)
    server = await serveRoutes((router) =>
      registerCaptureRoutes(router, {
        store,
        blobsDir: blobs,
        limits: { maxBytes: MAX_BYTES, maxFiles: 3 },
        previews,
        reader: { kick: () => (kicks += 1) },
      }),
    )
  })

  afterEach(async () => {
    await server.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('sending a capture on to its owner', () => {
    const adapter = {
      reachable: async () => true,
      send: async () => ({ state: 'filed' as const, ref: 'pf-9' }),
    }

    beforeEach(async () => {
      await server.close()
      const routing = new CaptureRouter({
        store,
        blobsDir: blobs,
        table: buildTable(null),
        adapters: new Map([['portfolio-ai', adapter]]),
        run: async () => {},
        log: () => {},
      })
      server = await serveRoutes((router) =>
        registerCaptureRoutes(router, {
          store,
          blobsDir: blobs,
          limits: { maxBytes: MAX_BYTES, maxFiles: 3 },
          previews,
          router: routing,
        }),
      )
    })

    it('shows the route, sends on a tap, refuses an unknown action, and purges the file', async () => {
      const made = await created(await upload(PNG, 'r.png', 'image/png'))
      expect(made.route).toBeNull()
      store.claimForExtraction()
      store.finishExtraction(
        made.id,
        { type: 'receipt', text: 't', json: null, route: 'agy' },
        { owner: 'portfolio-ai', state: 'suggested', note: null },
      )
      const one = (await (
        await fetch(`${server.base}/api/captures/${made.id}`)
      ).json()) as CaptureJson
      expect(one.route).toMatchObject({
        state: 'suggested',
        canSend: true,
        notLabel: 'Not a receipt',
      })

      const post = (action: string) =>
        fetch(`${server.base}/api/captures/${made.id}/route`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action }),
        })
      expect((await post('explode')).status).toBe(422)
      const sent = (await (await post('send')).json()) as CaptureJson
      expect(sent).toMatchObject({ status: 'filed', hasFile: false, hash: null, text: null })
      expect(sent.route).toMatchObject({ state: 'filed', ownerRef: 'pf-9' })
      expect((await fetch(`${server.base}/api/captures/${made.id}/file`)).status).toBe(404)
      expect((await post('send')).status).toBe(409)
    })
  })

  describe('uploads for an ask', () => {
    const ASK_ID = 'abcdefabcdef'
    let ask: Partial<Ask> | 'gone'
    let looked: string[]

    beforeEach(async () => {
      ask = { id: ASK_ID, state: 'open', wantsFiles: { min: 1, max: 2, hint: null } }
      looked = []
      await server.close()
      server = await serveRoutes((router) =>
        registerCaptureRoutes(router, {
          store,
          blobsDir: blobs,
          limits: { maxBytes: MAX_BYTES, maxFiles: 10 },
          previews,
          asks: {
            get: async (id) => {
              looked.push(id)
              if (ask === 'gone') throw new HttpError(404, 'That question is gone')
              return ask as Ask
            },
          },
        }),
      )
    })

    const detail = async (response: Response) =>
      ((await response.json()) as { detail: string }).detail

    it('tags the capture with the ask', async () => {
      const response = await upload(PNG, 'a.png', 'image/png', { ask_id: ASK_ID })
      expect(response.status).toBe(201)
      expect((await created(response)).askId).toBe(ASK_ID)
      expect(looked).toEqual([ASK_ID])
      expect(store.capturesForAsk(ASK_ID)).toHaveLength(1)
    })

    it('takes files for an answered ask too, and a retry of a saved file without asking again', async () => {
      ask = { ...(ask as Ask), state: 'answered' }
      const first = await upload(PNG, 'a.png', 'image/png', {
        ask_id: ASK_ID,
        client_id: 'retry-0001',
      })
      expect(first.status).toBe(201)
      const again = await upload(PNG, 'a.png', 'image/png', {
        ask_id: ASK_ID,
        client_id: 'retry-0001',
      })
      expect(again.status).toBe(200)
      expect(looked).toHaveLength(1)
    })

    it('refuses a closed or gone ask, an ask that wants no files, and one that is full', async () => {
      for (const state of ['done', 'withdrawn'] as const) {
        ask = { ...(ask as Ask), state }
        const refused = await upload(PNG, 'a.png', 'image/png', { ask_id: ASK_ID })
        expect(refused.status).toBe(409)
        expect(await detail(refused)).toBe('This question was closed')
      }
      ask = 'gone'
      expect((await upload(PNG, 'a.png', 'image/png', { ask_id: ASK_ID })).status).toBe(409)
      ask = { id: ASK_ID, state: 'open', wantsFiles: null }
      const none = await upload(PNG, 'a.png', 'image/png', { ask_id: ASK_ID })
      expect(none.status).toBe(409)
      expect(await detail(none)).toBe('This question does not take files')

      ask = { id: ASK_ID, state: 'open', wantsFiles: { min: 1, max: 2, hint: null } }
      expect((await upload(PNG, 'a.png', 'image/png', { ask_id: ASK_ID })).status).toBe(201)
      expect((await upload(PDF, 'b.pdf', 'application/pdf', { ask_id: ASK_ID })).status).toBe(201)
      const full = await upload(JPEG, 'c.jpg', 'image/jpeg', { ask_id: ASK_ID })
      expect(full.status).toBe(409)
      expect(await detail(full)).toBe('This question takes at most 2 files')
      // Nothing was saved for the refused ones.
      expect(store.capturesForAsk(ASK_ID)).toHaveLength(2)
      // Removing one makes room.
      store.tombstoneCapture(store.capturesForAsk(ASK_ID)[0]?.id as string)
      expect((await upload(JPEG, 'c.jpg', 'image/jpeg', { ask_id: ASK_ID })).status).toBe(201)
    })
  })

  it('hands the page its limits and the accepted types', async () => {
    const limits = (await (await fetch(`${server.base}/api/captures/limits`)).json()) as {
      max_bytes: number
      max_files: number
      types: { ext: string; mime: string; kind: string }[]
      accept: string
    }
    expect(limits.max_bytes).toBe(MAX_BYTES)
    expect(limits.max_files).toBe(3)
    expect(limits.types).toContainEqual({ ext: 'heic', mime: 'image/heic', kind: 'image' })
    expect(limits.accept).toContain('.heic')
    expect(limits.accept).toContain('application/pdf')
  })

  it('stores a capture: 201, the JSON shape, and the exact bytes at blobs/ab/<hash>', async () => {
    const response = await upload(PNG, 'receipt.png', 'image/png', {
      caption: 'milk receipt',
      group_id: 'group-0001',
    })
    expect(response.status).toBe(201)
    const body = await created(response)
    expect(body).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      clientId: 'client-0001',
      groupId: 'group-0001',
      askId: null,
      kind: 'image',
      name: 'receipt.png',
      mime: 'image/png',
      size: PNG.length,
      hash: sha256(PNG),
      caption: 'milk receipt',
      status: 'new',
      type: null,
      text: null,
      origin: 'test-host',
      hasThumb: false,
      previewState: 'ready',
    })
    expect(Object.keys(body).sort()).toEqual(
      [
        'id',
        'clientId',
        'groupId',
        'askId',
        'kind',
        'name',
        'mime',
        'size',
        'hash',
        'caption',
        'status',
        'type',
        'text',
        'createdAt',
        'updatedAt',
        'origin',
        'hasThumb',
        'previewState',
        'extractError',
        'extractRoute',
        'needsCheck',
        'hasFile',
        'route',
      ].sort(),
    )
    const hash = body.hash as string
    const path = join(blobs, hash.slice(0, 2), hash)
    expect(path).toBe(blobPath(blobs, hash))
    expect(readFileSync(path).equals(PNG)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(blobs, hash.slice(0, 2))).mode & 0o777).toBe(0o700)
  })

  it('answers a repeated client_id with the same row and 200', async () => {
    const first = await created(
      await upload(PNG, 'a.png', 'image/png', { client_id: 'same-client-1' }),
    )
    const again = await upload(PNG, 'a.png', 'image/png', { client_id: 'same-client-1' })
    expect(again.status).toBe(200)
    expect((await created(again)).id).toBe(first.id)
    expect(store.listCaptures().total).toBe(1)
  })

  it('refuses a file that was removed and then retried', async () => {
    const first = await created(
      await upload(PNG, 'a.png', 'image/png', { client_id: 'removed-one' }),
    )
    await fetch(`${server.base}/api/captures/${first.id}`, { method: 'DELETE' })
    const again = await upload(PNG, 'a.png', 'image/png', { client_id: 'removed-one' })
    expect(again.status).toBe(409)
  })

  it.each([
    [
      'too big',
      Buffer.alloc(MAX_BYTES + 1, 65),
      'big.txt',
      'text/plain',
      413,
      'That file is over 1 MB',
    ],
    [
      'a program',
      Buffer.from('MZ\x90\x00'),
      'setup.exe',
      'application/octet-stream',
      415,
      "Aico can't store this kind of file yet",
    ],
    [
      'a PDF named .jpg',
      PDF,
      'photo.jpg',
      'image/jpeg',
      415,
      "Aico can't store this kind of file yet",
    ],
    ['empty', Buffer.alloc(0), 'empty.txt', 'text/plain', 400, 'That file is empty'],
  ])('refuses %s in plain words', async (_label, content, name, type, status, detail) => {
    const response = await upload(content, name, type)
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ detail })
    expect(store.listCaptures().total).toBe(0)
  })

  it('wants a client_id and a file', async () => {
    const noId = new FormData()
    noId.append('file', new Blob([PNG], { type: 'image/png' }), 'a.png')
    expect(
      (await fetch(`${server.base}/api/captures`, { method: 'POST', body: noId })).status,
    ).toBe(422)
    const noFile = new FormData()
    noFile.append('client_id', 'client-xxxx')
    expect(
      (await fetch(`${server.base}/api/captures`, { method: 'POST', body: noFile })).status,
    ).toBe(422)
    expect((await upload(PNG, 'a.png', 'image/png', { client_id: 'bad id!' })).status).toBe(422)
    expect((await upload(PNG, 'a.png', 'image/png', { ask_id: 'nothex' })).status).toBe(422)
  })

  it('keeps a batch to the limit of files', async () => {
    for (let index = 0; index < 3; index += 1)
      expect((await upload(PNG, 'a.png', 'image/png', { group_id: 'group-full' })).status).toBe(201)
    const over = await upload(PNG, 'a.png', 'image/png', { group_id: 'group-full' })
    expect(over.status).toBe(409)
    expect(((await over.json()) as { detail: string }).detail).toBe(
      'That batch already has 3 files',
    )
    // A retry of one already stored is not a new file.
    expect(
      (
        await upload(PNG, 'a.png', 'image/png', {
          group_id: 'group-full',
          client_id: 'client-0001',
        })
      ).status,
    ).toBe(200)
  })

  it('limits uploads to 60 a minute', async () => {
    for (let index = 0; index < 60; index += 1)
      expect((await upload('hi', 'a.txt', 'text/plain')).status).toBe(201)
    const limited = await upload('hi', 'a.txt', 'text/plain')
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as { detail: string }).detail).toMatch(/Too many files/)
  })

  it('lists newest first with a total, filters and paging; hides tombstones', async () => {
    const ids: string[] = []
    for (let index = 0; index < 5; index += 1)
      ids.push(
        (
          await created(
            await upload(
              'note',
              'n.txt',
              'text/plain',
              index < 2 ? { ask_id: 'a1b2c3d4e5f6' } : {},
            ),
          )
        ).id,
      )
    const list = async (query: string) =>
      (await (await fetch(`${server.base}/api/captures${query}`)).json()) as {
        captures: CaptureJson[]
        total: number
      }
    const first = await list('?limit=2')
    expect(first.total).toBe(5)
    expect(first.captures).toHaveLength(2)
    const second = await list(`?limit=2&before=${first.captures[1]?.id}`)
    const third = await list(`?limit=2&before=${second.captures[1]?.id}`)
    expect(
      [...first.captures, ...second.captures, ...third.captures].map((c) => c.id).sort(),
    ).toEqual([...ids].sort())
    expect((await list('?ask=a1b2c3d4e5f6')).total).toBe(2)
    expect((await list('?status=ready')).total).toBe(0)
    expect((await fetch(`${server.base}/api/captures?status=bogus`)).status).toBe(422)
    expect((await fetch(`${server.base}/api/captures?limit=0`)).status).toBe(422)
    await fetch(`${server.base}/api/captures/${ids[0]}`, { method: 'DELETE' })
    expect((await list('')).total).toBe(4)
  })

  it('gets one capture, 404 for a missing or malformed id', async () => {
    const row = await created(await upload(PNG, 'a.png', 'image/png'))
    const got = await fetch(`${server.base}/api/captures/${row.id}`)
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({ ...row, extract: null })
    for (const id of ['0123456789ab', 'not-an-id'])
      expect(await (await fetch(`${server.base}/api/captures/${id}`)).json()).toEqual({
        detail: 'That capture is gone',
      })
  })

  it('changes the caption only, and deletes as a tombstone', async () => {
    const row = await created(await upload(PNG, 'a.png', 'image/png'))
    const patch = (body: unknown) =>
      fetch(`${server.base}/api/captures/${row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const changed = await patch({ caption: 'new words' })
    expect(changed.status).toBe(200)
    const body = await created(changed)
    expect(body.caption).toBe('new words')
    expect(body.updatedAt).toBeGreaterThan(row.updatedAt)
    expect((await patch({ caption: 'x', status: 'ready' })).status).toBe(422)
    expect((await patch({ name: 'x' })).status).toBe(422)
    expect((await patch({ caption: 5 })).status).toBe(422)

    const removed = await fetch(`${server.base}/api/captures/${row.id}`, { method: 'DELETE' })
    expect(await removed.json()).toEqual({ deleted: true, id: row.id })
    expect((await fetch(`${server.base}/api/captures/${row.id}`)).status).toBe(404)
    expect((await patch({ caption: 'again' })).status).toBe(404)
    // The row and the blob stay (tombstone), for the sync-aware cleanup.
    expect(store.getCapture(row.id, true)?.deleted).toBe(1)
    expect(readFileSync(blobPath(blobs, row.hash as string)).equals(PNG)).toBe(true)
  })

  it('wakes the reader for a new capture; shows what was read on one capture; retries only a failed one', async () => {
    const row = await created(await upload(PNG, 'a.png', 'image/png'))
    expect(kicks).toBe(1)
    await upload(PNG, 'a.png', 'image/png', { client_id: 'client-0001' })
    expect(kicks).toBe(1) // a repeated upload is not new work
    expect(row).toMatchObject({ status: 'new', extractError: null, needsCheck: false })

    expect(
      (await fetch(`${server.base}/api/captures/${row.id}/retry`, { method: 'POST' })).status,
    ).toBe(409)

    store.claimForExtraction()
    store.failExtraction(row.id, "the main reader isn't available")
    const failed = await created(await fetch(`${server.base}/api/captures/${row.id}`))
    expect(failed).toMatchObject({
      status: 'failed',
      extractError: "the main reader isn't available",
      extract: null,
    })

    const retried = await fetch(`${server.base}/api/captures/${row.id}/retry`, { method: 'POST' })
    expect(retried.status).toBe(200)
    expect((await created(retried)).status).toBe('new')
    expect(kicks).toBe(2)

    store.claimForExtraction()
    store.finishExtraction(row.id, {
      type: 'note',
      text: 'hi',
      json: '{"title":"T"}',
      route: 'ollama',
    })
    const detail = await created(await fetch(`${server.base}/api/captures/${row.id}`))
    expect(detail).toMatchObject({
      status: 'ready',
      text: 'hi',
      needsCheck: true,
      extractRoute: 'ollama',
      extract: { title: 'T' },
    })
    await upload(PNG, 'b.png', 'image/png')
    const list = (await (await fetch(`${server.base}/api/captures`)).json()) as {
      captures: CaptureJson[]
    }
    expect(list.captures).toHaveLength(2)
    for (const entry of list.captures) expect(entry).not.toHaveProperty('extract')
  })

  it('serves an image inline with the immutable cache and sandbox headers', async () => {
    const row = await created(await upload(PNG, 'a.png', 'image/png'))
    const response = await fetch(`${server.base}/api/captures/${row.id}/file`)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")
    expect(response.headers.get('content-disposition')).toBe('inline')
    // A JPEG or PNG is its own preview.
    const preview = await fetch(`${server.base}/api/captures/${row.id}/preview`)
    expect(preview.headers.get('content-disposition')).toBe('inline')
    expect(Buffer.from(await preview.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('serves a PDF as an attachment with a safe file name and no preview', async () => {
    const row = await created(await upload(PDF, 'Invoice "May" é.pdf', 'application/pdf'))
    expect(row).toMatchObject({ kind: 'pdf', previewState: 'unavailable' })
    const response = await fetch(`${server.base}/api/captures/${row.id}/file`)
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="Invoice _May_ _.pdf"; filename*=UTF-8''Invoice%20%22May%22%20%C3%A9.pdf`,
    )
    expect(response.headers.get('content-type')).toBe('application/pdf')
    expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(Buffer.from(await response.arrayBuffer()).equals(PDF)).toBe(true)
    expect((await fetch(`${server.base}/api/captures/${row.id}/preview`)).status).toBe(404)
    expect((await fetch(`${server.base}/api/captures/${row.id}/thumb`)).status).toBe(404)
  })

  it('strips a path from the name', async () => {
    const row = await created(await upload('x', '../../etc/passwd.txt', 'text/plain'))
    expect(row.name).toBe('passwd.txt')
  })

  describe('thumbnails', () => {
    const put = (id: string, body: Buffer) =>
      fetch(`${server.base}/api/captures/${id}/thumb`, {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
        body,
      })

    it('takes a JPEG up to 256 KB and serves it back', async () => {
      const row = await created(await upload(PNG, 'a.png', 'image/png'))
      const thumb = Buffer.concat([JPEG, Buffer.alloc(256 * 1024 - JPEG.length)])
      const stored = await put(row.id, thumb)
      expect(stored.status).toBe(200)
      expect((await created(stored)).hasThumb).toBe(true)
      expect(blobPath(blobs, row.hash as string, 'thumb')).toMatch(/\.thumb\.jpg$/)
      const response = await fetch(`${server.base}/api/captures/${row.id}/thumb`)
      expect(response.headers.get('content-type')).toBe('image/jpeg')
      expect(response.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
      expect(response.headers.get('content-disposition')).toBe('inline')
      expect(Buffer.from(await response.arrayBuffer()).equals(thumb)).toBe(true)
      expect((await created(await fetch(`${server.base}/api/captures/${row.id}`))).hasThumb).toBe(
        true,
      )
    })

    it('refuses a thumbnail over 256 KB, one that is not a JPEG, and an unknown capture', async () => {
      const row = await created(await upload(PNG, 'a.png', 'image/png'))
      const big = await put(row.id, Buffer.concat([JPEG, Buffer.alloc(256 * 1024)]))
      expect(big.status).toBe(413)
      expect(((await big.json()) as { detail: string }).detail).toBe(
        'That thumbnail is over 256 KB',
      )
      expect((await put(row.id, PNG)).status).toBe(415)
      expect((await put(row.id, Buffer.alloc(0))).status).toBe(415)
      expect((await put('0123456789ab', JPEG)).status).toBe(404)
      expect((await created(await fetch(`${server.base}/api/captures/${row.id}`))).hasThumb).toBe(
        false,
      )
    })
  })

  describe('HEIC', () => {
    it('stores the original as sent and makes a JPEG preview in the background', async () => {
      const response = await upload(HEIC, 'IMG_0001.HEIC', '')
      expect(response.status).toBe(201)
      const row = await created(response)
      expect(row).toMatchObject({ kind: 'image', mime: 'image/heic', previewState: 'pending' })
      await previews.idle()

      expect(runnerCalls).toHaveLength(1)
      const original = blobPath(blobs, row.hash as string)
      expect(runnerCalls[0]?.slice(0, 4)).toEqual(['heif-convert', '-q', '85', original])
      expect(runnerCalls[0]?.[4]).toMatch(/\.jpg$/)
      expect(readFileSync(original).equals(HEIC)).toBe(true)

      const after = await created(await fetch(`${server.base}/api/captures/${row.id}`))
      expect(after.previewState).toBe('ready')
      const preview = await fetch(`${server.base}/api/captures/${row.id}/preview`)
      expect(preview.headers.get('content-type')).toBe('image/jpeg')
      expect(preview.headers.get('content-disposition')).toBe('inline')
      expect(Buffer.from(await preview.arrayBuffer()).equals(PREVIEW_JPEG)).toBe(true)
      // The original downloads untouched.
      const file = await fetch(`${server.base}/api/captures/${row.id}/file`)
      expect(file.headers.get('content-disposition')).toMatch(
        /^attachment; filename="IMG_0001.HEIC"/,
      )
      expect(Buffer.from(await file.arrayBuffer()).equals(HEIC)).toBe(true)
    })

    it('keeps the capture, with the preview unavailable, when the converter fails', async () => {
      converterWorks = false
      const row = await created(await upload(HEIC, 'IMG_0002.heic', 'image/heic'))
      await previews.idle()
      const after = await created(await fetch(`${server.base}/api/captures/${row.id}`))
      expect(after.previewState).toBe('unavailable')
      expect((await fetch(`${server.base}/api/captures/${row.id}/preview`)).status).toBe(404)
      expect((await fetch(`${server.base}/api/captures/${row.id}/file`)).status).toBe(200)
      expect(runnerCalls).toHaveLength(1)
    })

    it('is unavailable, not an error, when heif-convert cannot start', async () => {
      const missing = new PreviewJobs(blobs, async () => {
        throw Object.assign(new Error('spawn heif-convert ENOENT'), { code: 'ENOENT' })
      })
      const other = await serveRoutes((router) =>
        registerCaptureRoutes(router, {
          store,
          blobsDir: blobs,
          limits: { maxBytes: MAX_BYTES, maxFiles: 3 },
          previews: missing,
        }),
      )
      try {
        const form = new FormData()
        form.append('file', new Blob([HEIC]), 'IMG_0003.heic')
        form.append('client_id', 'client-heic-3')
        const row = (await (
          await fetch(`${other.base}/api/captures`, { method: 'POST', body: form })
        ).json()) as CaptureJson
        await missing.idle()
        const after = (await (
          await fetch(`${other.base}/api/captures/${row.id}`)
        ).json()) as CaptureJson
        expect(after.previewState).toBe('unavailable')
      } finally {
        await other.close()
      }
    })

    it('tries again for a HEIC with no preview that this server has not seen (after a restart)', async () => {
      converterWorks = false
      const row = await created(await upload(HEIC, 'IMG_0004.heic', 'image/heic'))
      await previews.idle()
      const restarted = new PreviewJobs(blobs, runner)
      converterWorks = true
      expect(restarted.state(row.hash as string)).toBe('pending')
      await restarted.idle()
      expect(restarted.state(row.hash as string)).toBe('ready')
    })
  })
})
