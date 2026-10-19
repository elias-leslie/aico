import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'

export const MAX_BODY_BYTES = 128 * 1024

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code)
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

export function sendError(response: ServerResponse, error: HttpError): void {
  sendJson(response, error.status, { error: error.code, ...error.extra })
}

/** Strict JSON body: `application/json`, bounded, an object. */
export async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (request.headers['content-type'] ?? '').split(';')[0]?.trim()
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type')
  const parts: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const chunk = part as Buffer
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large')
    parts.push(chunk)
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.concat(parts).toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_body')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_body')
  }
  return value as Record<string, unknown>
}

export type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  params: Record<string, string>,
  query: URLSearchParams,
) => Promise<void> | void

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
}

/** Minimal method + path router. `:name` segments match one non-empty segment. */
export class Router {
  private readonly routes: Route[] = []

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = []
    const source = path
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1))
          return '([^/]+)'
        }
        if (segment === '*') {
          keys.push('rest')
          return '(.*)'
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      })
      .join('/')
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), keys, handler })
    return this
  }

  async dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://tether.invalid')
    let pathMatched = false
    for (const route of this.routes) {
      const match = route.pattern.exec(url.pathname)
      if (!match) continue
      pathMatched = true
      if (route.method !== request.method) continue
      const params: Record<string, string> = {}
      route.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1] ?? '')
      })
      await route.handler(request, response, params, url.searchParams)
      return
    }
    throw pathMatched ? new HttpError(405, 'method_not_allowed') : new HttpError(404, 'not_found')
  }
}

async function isLiveSocket(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = createConnection(path)
    client.once('connect', () => {
      client.destroy()
      resolve(true)
    })
    client.once('error', () => resolve(false))
  })
}

/**
 * Bind an HTTP server to a private Unix socket: parent directory 0700 and owned
 * by this user, socket 0600. A live socket (another daemon) or a non-socket at
 * the path is refused; a stale socket is replaced. This is also the
 * single-writer guard for the instance database.
 *
 * Shared mode (src/pane-policy.ts) opens it to the directory's group only:
 * directory 2750 (setgid, group from the root-made parent), socket 0660. The
 * directory must still be owned by this user.
 */
export async function listenPrivateSocket(
  server: Server,
  path: string,
  options: { shared?: boolean } = {},
): Promise<void> {
  const directory = dirname(path)
  const dirMode = options.shared ? 0o2750 : 0o700
  mkdirSync(directory, { recursive: true, mode: dirMode })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) {
    throw new Error(`socket directory ${directory} is not a directory owned by this user`)
  }
  chmodSync(directory, dirMode)
  if (existsSync(path)) {
    const existing = lstatSync(path)
    if (!existing.isSocket() || existing.uid !== process.getuid?.()) {
      throw new Error(`refusing to replace non-socket or foreign file at ${path}`)
    }
    if (await isLiveSocket(path)) {
      throw new Error(`another daemon is already listening on ${path}`)
    }
    unlinkSync(path)
  }
  const previousUmask = process.umask(0o077)
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(path, options.shared ? 0o660 : 0o600)
  } finally {
    process.umask(previousUmask)
  }
}
