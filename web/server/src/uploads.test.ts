import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serveRoutes } from './testing'
import {
  cleanupOldUploads,
  detectMimeType,
  RateLimiter,
  registerUploadRoutes,
  shellPath,
} from './uploads'

const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(100)])

describe('detectMimeType', () => {
  it('proves binaries by magic bytes and takes text types at their word', () => {
    expect(detectMimeType(PNG, 'image/png')).toBe('image/png')
    expect(detectMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg')).toBe(
      'image/jpeg',
    )
    expect(detectMimeType(Buffer.from('RIFFabcdWEBP'), 'image/webp')).toBe('image/webp')
    expect(detectMimeType(Buffer.from('RIFFabcdWAVE'), 'image/webp')).toBeNull()
    expect(detectMimeType(Buffer.from('hello world'), 'text/plain')).toBe('text/plain')
    expect(detectMimeType(Buffer.from('# Heading'), 'text/markdown')).toBe('text/markdown')
    expect(detectMimeType(Buffer.from('{"a":1}'), 'application/json')).toBe('application/json')
    expect(detectMimeType(Buffer.from([0, 1, 2, 3]), 'image/png')).toBeNull()
  })

  it('shows paths under home as ~/…', () => {
    expect(shellPath('/home/me/aico-uploads/x.png', '/home/me')).toBe('~/aico-uploads/x.png')
    expect(shellPath('/srv/uploads/x.png', '/home/me')).toBe('/srv/uploads/x.png')
  })

  it('allows 10 calls a minute per caller', () => {
    let now = 0
    const limiter = new RateLimiter(10, 60_000, () => now)
    for (let index = 0; index < 10; index += 1) expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
    expect(limiter.allow('b')).toBe(true)
    now = 60_000
    expect(limiter.allow('a')).toBe(true)
  })
})

describe('upload routes', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof serveRoutes>>

  function upload(content: Buffer | string, filename: string, type: string) {
    const form = new FormData()
    form.append('file', new Blob([content], { type }), filename)
    return fetch(`${server.base}/api/files`, { method: 'POST', body: form })
  }

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    dir = join(mkdtempSync(join(tmpdir(), 'aico-uploads-')), 'uploads')
    server = await serveRoutes((router) =>
      registerUploadRoutes(router, { dir, maxBytes: 1024, maxAgeMs: 60_000 }),
    )
  })

  afterEach(async () => {
    await server.close()
    rmSync(dirname(dir), { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('serves the size limit from the config', async () => {
    const response = await fetch(`${server.base}/api/files/limits`)
    expect(await response.json()).toEqual({ max_bytes: 1024 })
  })

  it.each([
    ['hello world', 'notes.txt', 'text/plain', '.txt'],
    ['{"a":1}', 'data.json', 'application/json', '.json'],
    [PNG, 'image.png', 'image/png', '.png'],
  ])('stores %#: a private file with a UUID name', async (content, filename, type, extension) => {
    const response = await upload(content, filename, type)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { filename: string; path: string }
    expect(body).toMatchObject({ size: content.length, mime_type: type })
    expect(body.filename).toMatch(new RegExp(`^[0-9a-f-]{36}\\${extension}$`))
    expect(body.path).toBe(join(dir, body.filename))
    expect(readdirSync(dir)).toEqual([body.filename])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(body.path).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['<html></html>', 'page.html', 'text/html', 400, /not allowed/],
    ['', 'empty.txt', 'text/plain', 400, /Empty file/],
    ['plain text', 'fake.png', 'image/png', 400, /does not match/],
    ['x'.repeat(1025), 'big.txt', 'text/plain', 413, /File too large/],
  ])('refuses %#', async (content, filename, type, status, detail) => {
    const response = await upload(content, filename, type)
    expect(response.status).toBe(status)
    expect(((await response.json()) as { detail: string }).detail).toMatch(detail)
    expect(() => readdirSync(dir)).toThrow()
  })

  it('wants a file part', async () => {
    const form = new FormData()
    form.append('other', 'x')
    const response = await fetch(`${server.base}/api/files`, { method: 'POST', body: form })
    expect(response.status).toBe(422)
  })

  it('limits a caller to 10 uploads a minute', async () => {
    for (let index = 0; index < 10; index += 1)
      expect((await upload('hi', 'a.txt', 'text/plain')).status).toBe(200)
    const limited = await upload('hi', 'a.txt', 'text/plain')
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ detail: 'Rate limit exceeded: 10 per 1 minute' })
  })
})

describe('cleanupOldUploads', () => {
  let dir: string

  function write(relative: string, ageSeconds: number): string {
    const path = join(dir, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'data')
    const time = Date.now() / 1000 - ageSeconds
    utimesSync(path, time, time)
    return path
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-cleanup-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('deletes old files at any depth and prunes emptied directories, never the root', async () => {
    write('nested/deeper/old.txt', 3600)
    write('fresh.txt', 10)
    const stats = await cleanupOldUploads({ dir, maxBytes: 1, maxAgeMs: 300_000 })
    expect(stats).toEqual({
      scanned_files: 2,
      deleted_files: 1,
      pruned_directories: 2,
      errors: 0,
      max_age_seconds: 300,
    })
    expect(readdirSync(dir)).toEqual(['fresh.txt'])
  })

  it('reports nothing for a missing upload dir', async () => {
    const stats = await cleanupOldUploads({
      dir: join(dir, 'missing'),
      maxBytes: 1,
      maxAgeMs: 60_000,
    })
    expect(stats).toEqual({
      scanned_files: 0,
      deleted_files: 0,
      pruned_directories: 0,
      errors: 0,
      max_age_seconds: 60,
    })
  })
})
