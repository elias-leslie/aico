import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import type { ShowConfig } from './config'
import type { EventBus } from './events'
import { HttpError, type Router, readJsonObject, sendJson } from './http'

type ShowRequest = {
  session: string | null
  title: string | null
} & ({ kind: 'url'; url: string } | { kind: 'file'; path: string })

const CONTROLS = /[\p{Cc}\p{Cf}\u2028\u2029]/u

function parseShow(body: Record<string, unknown>): ShowRequest {
  const unknown = Object.keys(body).filter(
    (key) => !['session', 'title', 'url', 'path'].includes(key),
  )
  if (unknown.length) throw new HttpError(400, 'invalid_body', { fields: unknown })
  for (const key of ['session', 'title', 'url', 'path']) {
    if (body[key] !== undefined && typeof body[key] !== 'string') {
      throw new HttpError(400, 'invalid_body', { field: key })
    }
  }
  const session = (body.session as string | undefined) ?? null
  if (session !== null && !/^[0-9a-f]{8}$/.test(session)) {
    throw new HttpError(400, 'invalid_body', { field: 'session' })
  }
  const title = (body.title as string | undefined) ?? null
  if (title !== null && (Array.from(title).length > 120 || CONTROLS.test(title))) {
    throw new HttpError(400, 'invalid_body', { field: 'title' })
  }
  if ((body.url === undefined) === (body.path === undefined)) {
    throw new HttpError(400, 'invalid_body', { detail: 'provide exactly one of url or path' })
  }
  if (typeof body.url === 'string') {
    const url = body.url
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new HttpError(400, 'invalid_body', { field: 'url' })
    }
    if (
      Array.from(url).length > 2000 ||
      CONTROLS.test(url) ||
      url.trim() !== url ||
      !/^https?:\/\//i.test(url) ||
      !['http:', 'https:'].includes(parsed.protocol)
    ) {
      throw new HttpError(400, 'invalid_body', { field: 'url' })
    }
    return { session, title, kind: 'url', url }
  }
  const path = body.path as string
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new HttpError(400, 'invalid_body', { field: 'path' })
  }
  return { session, title, kind: 'file', path }
}

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

async function exchangeDirectory(root: string, session: string | null): Promise<string> {
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new HttpError(503, 'exchange_unavailable', {
      detail: `Exchange root ${root} must already exist as a directory; install it before showing files`,
    })
  }
  let directory = root
  for (const part of ['agent', session ?? 'none', 'out']) {
    directory = join(directory, part)
    try {
      await mkdir(directory, { mode: 0o755 })
      // The daemon's umask may be private; owner apps still need to traverse these.
      await chmod(directory, 0o755)
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error
    }
    if (!(await lstat(directory)).isDirectory()) {
      throw new HttpError(503, 'exchange_unavailable', {
        detail: 'Exchange handoff directories must be directories, not symlinks',
      })
    }
  }
  return directory
}

async function copyFile(config: ShowConfig, request: ShowRequest & { kind: 'file' }, id: string) {
  // O_NONBLOCK prevents a FIFO from hanging open before fstat can refuse it.
  const source = await open(
    request.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error: unknown) => {
    throw new HttpError(400, 'invalid_file', {
      detail: `Cannot open a regular file without following symlinks (${errno(error) ?? 'unknown'})`,
    })
  })
  try {
    const stat = await source.stat()
    if (!stat.isFile())
      throw new HttpError(400, 'invalid_file', { detail: 'A regular file is required' })
    if (stat.size > config.maxBytes)
      throw new HttpError(413, 'file_too_large', { maxBytes: config.maxBytes })
    const directory = await exchangeDirectory(config.exchangeRoot, request.session)
    const safeName = basename(request.path)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 80)
    const filename = `${id}-${safeName}`
    const targetPath = join(directory, filename)
    const target = await open(
      targetPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    )
    let complete = false
    try {
      const buffer = Buffer.alloc(64 * 1024)
      let total = 0
      for (;;) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          Math.min(buffer.length, config.maxBytes - total + 1),
          null,
        )
        if (!bytesRead) break
        total += bytesRead
        if (total > config.maxBytes)
          throw new HttpError(413, 'file_too_large', { maxBytes: config.maxBytes })
        let written = 0
        while (written < bytesRead) {
          const result = await target.write(buffer, written, bytesRead - written, null)
          written += result.bytesWritten
        }
      }
      await target.chmod(0o644)
      complete = true
    } finally {
      await target.close()
      if (!complete) await unlink(targetPath)
    }
    return `${request.session ?? 'none'}/out/${filename}`
  } finally {
    await source.close()
  }
}

export function registerShowRoute(router: Router, events: EventBus, config: ShowConfig): void {
  router.add('POST', '/v1/show', async (req, res) => {
    const request = parseShow(await readJsonObject(req))
    const id = randomBytes(6).toString('hex')
    const name = request.kind === 'file' ? await copyFile(config, request, id) : request.url
    const data = {
      id,
      session: request.session,
      kind: request.kind,
      title: request.title,
      name,
      ...(request.kind === 'url' ? { url: request.url } : {}),
    }
    events.publish('show.requested', data)
    sendJson(res, 201, data)
  })
}
