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
import { controlSocketPath, RemoteUploadError, type uploadToHost } from 'tether/term'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeTether, serveRoutes } from './testing'
import { HttpError } from './tether'
import {
  cleanupOldUploads,
  detectMimeType,
  RateLimiter,
  registerUploadRoutes,
  shellPath,
  uploadTargets,
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
      registerUploadRoutes(router, {
        dir,
        remoteDir: '~/.cache/aico/uploads',
        maxBytes: 1024,
        maxAgeMs: 60_000,
      }),
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

describe('upload for a session on another host', () => {
  let dir: string
  let server: Awaited<ReturnType<typeof serveRoutes>>
  let tether: FakeTether
  let sessions: Record<
    string,
    { host: string | null; peer: { state: string; since: number } | null }
  >
  let send: ReturnType<typeof vi.fn>

  function upload(sessionId?: string) {
    const form = new FormData()
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'shot.png')
    const query = sessionId ? `?session_id=${sessionId}` : ''
    return fetch(`${server.base}/api/files${query}`, { method: 'POST', body: form })
  }

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    dir = join(mkdtempSync(join(tmpdir(), 'aico-uploads-')), 'uploads')
    tether = new FakeTether()
    ;(tether.hostRows as unknown[]).push({
      name: 'agent-work',
      state: 'connected',
      ssh: 'agent-work-vm',
      control: controlSocketPath('agent-work'),
      sessions: 1,
    })
    sessions = {
      here: { host: null, peer: null },
      there: { host: 'agent-work', peer: null },
      away: { host: 'agent-work', peer: { state: 'offline', since: 1 } },
      lost: { host: 'elsewhere', peer: null },
    }
    send = vi.fn(
      async (_remote, _content, name: string) => `/home/agent/.cache/aico/uploads/${name}`,
    )
    const life = {
      getSession: async (id: string) => {
        if (!sessions[id]) throw new HttpError(404, `Session ${id} not found`)
        return sessions[id]
      },
    }
    server = await serveRoutes((router) =>
      registerUploadRoutes(
        router,
        { dir, remoteDir: '~/.cache/aico/uploads', maxBytes: 1024, maxAgeMs: 60_000 },
        {
          ...uploadTargets(life as never, tether as never),
          send: send as unknown as typeof uploadToHost,
        },
      ),
    )
  })

  afterEach(async () => {
    await server.close()
    rmSync(dirname(dir), { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('sends the file to the session’s host and answers the path there, keeping no local copy', async () => {
    const response = await upload('there')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { path: string; filename: string; host: string }
    expect(body.path).toBe(`/home/agent/.cache/aico/uploads/${body.filename}`)
    expect(body.host).toBe('agent-work')
    expect(send).toHaveBeenCalledOnce()
    const [remote, content, name, options] = send.mock.calls[0]
    expect(remote).toMatchObject({
      host: 'agent-work',
      alias: 'agent-work-vm',
      control: controlSocketPath('agent-work'),
    })
    expect(Buffer.from(content).equals(PNG)).toBe(true)
    expect(name).toBe(body.filename)
    expect(options).toEqual({ dir: '~/.cache/aico/uploads', maxAgeMs: 60_000 })
    expect(() => readdirSync(dir)).toThrow()
  })

  it('stores a local session’s file here, as before', async () => {
    const response = await upload('here')
    const body = (await response.json()) as { path: string; filename: string }
    expect(body.path).toBe(join(dir, body.filename))
    expect(send).not.toHaveBeenCalled()
    expect((await upload()).status).toBe(200)
    expect(send).not.toHaveBeenCalled()
  })

  it('says the host is offline, and sends nothing, when the link is down', async () => {
    const response = await upload('away')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      detail: 'agent-work is offline, so the file wasn’t sent.',
    })
    tether.hostRows[0].state = 'offline'
    sessions.away.peer = null
    expect((await upload('there')).status).toBe(502)
    expect(send).not.toHaveBeenCalled()
  })

  it('says so when ssh fails or the host refuses the file', async () => {
    send.mockRejectedValueOnce(new RemoteUploadError('offline', 'agent-work', 'Connection closed'))
    const offline = await upload('there')
    expect(await offline.json()).toEqual({
      detail: 'agent-work is offline, so the file wasn’t sent.',
    })
    send.mockRejectedValueOnce(new RemoteUploadError('failed', 'agent-work', 'exit 1'))
    const failed = await upload('there')
    expect(failed.status).toBe(502)
    expect(await failed.json()).toEqual({
      detail: 'agent-work didn’t accept the file, so it wasn’t sent.',
    })
  })

  it('does not fall back to this computer for an unknown session or host', async () => {
    expect((await upload('nope')).status).toBe(404)
    const lost = await upload('lost')
    expect(lost.status).toBe(502)
    expect(await lost.json()).toEqual({
      detail: 'elsewhere isn’t linked, so the file wasn’t sent.',
    })
    expect(() => readdirSync(dir)).toThrow()
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
    const stats = await cleanupOldUploads({
      dir,
      remoteDir: '~/.cache/aico/uploads',
      maxBytes: 1,
      maxAgeMs: 300_000,
    })
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
      remoteDir: '~/.cache/aico/uploads',
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
