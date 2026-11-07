// Shared HTML pages, rendered: `GET /api/files/page/<absolute path>` serves a file an agent shared
// (`tether share`, or attached to a question) so a mockup or report opens as a page in its own tab,
// with the files beside it (its css, scripts, images) at the relative URLs it names.
//
// - Only shared files: the shared file itself and anything under its own folder, or anything
//   under a shared folder. This host's shares only; a linked host's files are not here.
// - Every answer is sandboxed (`sandbox allow-scripts allow-popups`, no allow-same-origin): the
//   page runs in an opaque origin, so it cannot read Aico's API, and the guard refuses its
//   writes and sockets (Origin: null).
// - No folder listings, no dot segments, no secrets (the same names the file viewer refuses);
//   the real path (links followed) must still be shared.
// - A missing or unshared file answers a short page saying so, not a blank tab.

import { constants } from 'node:fs'
import { type FileHandle, open, realpath } from 'node:fs/promises'
import { basename, dirname, extname } from 'node:path'
import { isDenied } from '@aico/tether-client/files'
import { RAW, type RequestContext, type Router } from './http'
import type { Share } from './shows'
import { CONTENT_TYPES } from './static'

/** No same-origin: the page cannot use the owner's Aico session or read its API. */
export const SHARED_PAGE_CSP = 'sandbox allow-scripts allow-popups'

const SHARED_PAGE_PREFIX = '/api/files/page'

const MAX_BYTES = 25 * 1024 * 1024
const TYPES: Readonly<Record<string, string>> = { ...CONTENT_TYPES, '.htm': CONTENT_TYPES['.html'] }
const FONTS = new Set(['.woff', '.woff2', '.ttf', '.otf'])

class Refused extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
  ) {
    super(title)
  }
}

/** The absolute path a request names, or a refusal (dot segments, NUL, secrets). */
function requestedPath(raw: string): string {
  const path = `/${raw}`
  const parts = path.split('/').slice(1)
  if (path.includes('\0') || parts.some((part) => part === '.' || part === '..' || part === ''))
    throw new Refused(400, 'Not a file path', 'This link does not name a file.')
  if (parts.some((part) => isDenied(part)))
    throw new Refused(403, 'Not shared', 'This file is not shared with Aico.')
  return path
}

/** Whether a share lets this file be served: the shared file, a file under its folder, or under a shared folder. */
export function sharedBy(path: string, shares: readonly Share[]): boolean {
  return shares.some(
    (share) =>
      share.kind === 'files' &&
      share.host === undefined &&
      share.paths.some((shared) => {
        if (path === shared) return true
        const folder = shared.endsWith('/') ? shared : `${dirname(shared)}/`
        // A file shared at the top of the disk lends nothing else.
        return folder !== '/' && folder !== '//' && path.startsWith(folder)
      }),
  )
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

/** A plain dark page for a file that cannot open. */
function refusalPage(ctx: RequestContext, refused: Refused, path: string | null): typeof RAW {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(refused.title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d11;color:#e7e2d6;font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}main{max-width:32rem}h1{font-size:18px;margin:0 0 6px}p{margin:0;color:#a8a294}code{font:12.5px ui-monospace,monospace;word-break:break-all;color:#e7e2d6}</style></head><body><main><h1>${escapeHtml(refused.title)}</h1><p>${escapeHtml(refused.detail)}</p>${path ? `<p style="margin-top:10px"><code>${escapeHtml(path)}</code></p>` : ''}</main></body></html>`
  const { res } = ctx
  res.statusCode = refused.status
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Security-Policy', SHARED_PAGE_CSP)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
  return RAW
}

async function send(ctx: RequestContext, target: string): Promise<typeof RAW> {
  let file: FileHandle
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch {
    throw new Refused(404, 'File moved or deleted', 'This file is no longer where it was shared.')
  }
  try {
    const info = await file.stat()
    if (!info.isFile())
      throw new Refused(404, 'Not a file', 'This link names a folder; open a file in it.')
    if (info.size > MAX_BYTES) throw new Refused(413, 'File too big', 'This file is over 25 MB.')
    const data = Buffer.alloc(info.size)
    const { bytesRead } = await file.read(data, 0, info.size, 0)
    const ext = extname(target).toLowerCase()
    const type = TYPES[ext]
    const { res } = ctx
    const name = basename(target).replace(/[^\x20-\x7e]|["\\]/g, '_')
    res.statusCode = 200
    res.setHeader('Content-Type', type ?? 'application/octet-stream')
    res.setHeader('Content-Disposition', `${type ? 'inline' : 'attachment'}; filename="${name}"`)
    res.setHeader('Content-Security-Policy', SHARED_PAGE_CSP)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Referrer-Policy', 'no-referrer')
    // The sandboxed page's origin is opaque, so its font loads are cross-origin.
    if (FONTS.has(ext)) res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Content-Length', bytesRead)
    res.end(data.subarray(0, bytesRead))
    return RAW
  } finally {
    await file.close()
  }
}

export function registerSharedPageRoutes(
  router: Router,
  options: { shares: () => Promise<Share[]> },
): void {
  router.on('GET', `${SHARED_PAGE_PREFIX}/*path`, async (ctx) => {
    let path: string | null = null
    try {
      path = requestedPath(ctx.params.path)
      const shares = await options.shares()
      if (!sharedBy(path, shares))
        throw new Refused(403, 'Not shared', 'This file is not shared with Aico.')
      let real: string
      try {
        real = await realpath(path)
      } catch {
        throw new Refused(
          404,
          'File moved or deleted',
          'This file is no longer where it was shared.',
        )
      }
      if (real.split('/').some((part) => part && isDenied(part)) || !sharedBy(real, shares))
        throw new Refused(403, 'Not shared', 'This file is not shared with Aico.')
      return await send(ctx, real)
    } catch (error) {
      if (error instanceof Refused) return refusalPage(ctx, error, path)
      throw error
    }
  })
}
