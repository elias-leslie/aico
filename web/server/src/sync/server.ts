// The sync listener: `/sync/*` on a unix socket and nowhere else (never the
// TCP port, so the Host/Origin guard does not apply). A peer reaches it through
// the ssh forward of its tether-link, and that key is the authentication. The
// socket is 0600 in a 0700 directory.

import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { dirname } from 'node:path'
import { type BlobVariant, blobPath, isBlobHash } from '../blobs'
import { RAW, Router, sendJson } from '../http'
import { HttpError } from '../tether'
import { type SyncHandle, serveChanges, serveHello } from './engine'

export interface SyncServerDeps {
  hostName: string
  handles: readonly SyncHandle[]
  blobsDir: string
  now(): number
  /** The peer wrote something: pull soon. */
  nudged(): void
}

const VARIANTS: Record<string, BlobVariant> = { thumb: 'thumb', preview: 'preview' }

export function createSyncServer(deps: SyncServerDeps): Server {
  const router = new Router()
  const handleOf = (set: string | null): SyncHandle => {
    const handle = deps.handles.find((candidate) => candidate.set === set)
    if (!handle) throw new HttpError(400, 'Unknown set')
    return handle
  }
  router.on('GET', '/sync/hello', () => serveHello(deps.handles, deps.hostName, deps.now()))
  router.on('GET', '/sync/changes', (ctx) =>
    serveChanges(handleOf(ctx.query.get('set')), {
      since: Number(ctx.query.get('since')),
      limit: Number(ctx.query.get('limit')),
      peer: ctx.query.get('peer') ?? '',
    }),
  )
  router.on('GET', '/sync/blob/:hash', async (ctx) => {
    const hash = ctx.params.hash
    const v = ctx.query.get('v')
    if (!isBlobHash(hash) || (v !== null && !VARIANTS[v])) throw new HttpError(400, 'Bad blob')
    let bytes: Buffer
    try {
      bytes = await readFile(blobPath(deps.blobsDir, hash, v ? VARIANTS[v] : 'original'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'No blob')
      throw error
    }
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', 'application/octet-stream')
    ctx.res.setHeader('Content-Length', bytes.length)
    ctx.res.end(bytes)
    return RAW
  })
  router.on('POST', '/sync/nudge', () => {
    deps.nudged()
    return { ok: true }
  })
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://sync')
    router
      .handle(req, res, url)
      .then((handled) => {
        if (!handled) sendJson(res, 404, { detail: 'Not Found' })
      })
      .catch((error) => {
        console.error('[aico-web] sync request failed:', error)
        if (!res.headersSent) sendJson(res, 500, { detail: 'Unexpected error' })
        else res.destroy()
      })
  })
}

/** Listens on `path` (0600, in a 0700 directory), replacing a stale socket file left by a crash. */
export async function listenUnix(server: Server, path: string): Promise<void> {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error(`refusing to replace non-socket ${path}`)
    unlinkSync(path)
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      chmodSync(path, 0o600)
      resolve()
    })
  })
}
