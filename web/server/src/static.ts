// The web app's page: web/frontend's static export (`out/`), served at `/`.
//
// - A path names a file in the export (`/x` also tries `x.html`); anything
//   else without an extension is a page route and gets index.html (the app
//   reads its query in the browser). A missing asset is 404.
// - `/_next/static/*` names are content-hashed: cached for a year. HTML, the
//   manifest, the service worker and the rest revalidate every time (ETag).
// - Pages carry a CSP whose script-src lists the export's inline scripts by
//   hash (written by web/frontend/scripts/csp-hashes.mjs at build time).

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

/** The build step's file in `out/`: `{ "scriptHashes": ["sha256-…", …] }`. */
export const CSP_HASHES_FILE = 'csp-hashes.json'

const IMMUTABLE_PREFIX = '/_next/static/'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
}

export interface StaticSite {
  /** Answers GET/HEAD for the page and its assets; false when it isn't one. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean
}

export interface PageCspOptions {
  scriptHashes: readonly string[]
  /** Agent Hub's base URL, when configured: the voice WebSocket connects there. */
  agentHubUrl: string | null
  /** Agent Hub's port on the page's own host, the voice fallback without a URL. */
  agentHubPort: number
}

/** The page's CSP for a request to `host` over `secure` (the voice socket's origin depends on it). */
export function pageCsp(
  options: PageCspOptions,
  host: string | undefined,
  secure: boolean,
): string {
  const connect = new Set(["'self'"])
  const hostname = (host ?? '').replace(/:[0-9]+$/, '')
  if (hostname) connect.add(`${secure ? 'wss' : 'ws'}://${hostname}:${options.agentHubPort}`)
  if (options.agentHubUrl) {
    try {
      const hub = new URL(options.agentHubUrl)
      connect.add(hub.origin)
      connect.add(`${hub.protocol === 'https:' ? 'wss' : 'ws'}://${hub.host}`)
    } catch {
      // Not a URL: the fallback above stays.
    }
  }
  const scripts = ["'self'", ...options.scriptHashes.map((hash) => `'${hash}'`)]
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    `connect-src ${[...connect].join(' ')}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ')
}

/** The inline-script hashes the build wrote, or none (then inline scripts are refused). */
export function readScriptHashes(root: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, CSP_HASHES_FILE), 'utf8')) as {
      scriptHashes?: unknown
    }
    const hashes = Array.isArray(parsed.scriptHashes) ? parsed.scriptHashes : []
    return hashes.filter(
      (hash): hash is string => typeof hash === 'string' && /^sha256-[A-Za-z0-9+/=]+$/.test(hash),
    )
  } catch {
    return []
  }
}

function fileAt(path: string): { path: string; size: number; mtimeMs: number } | null {
  try {
    const stat = statSync(path)
    return stat.isFile() ? { path, size: stat.size, mtimeMs: stat.mtimeMs } : null
  } catch {
    return null
  }
}

export function createStaticSite(
  root: string,
  csp: Omit<PageCspOptions, 'scriptHashes'>,
): StaticSite {
  const base = resolve(root)
  if (!existsSync(join(base, 'index.html')))
    console.warn(`[aico-web] no web app at ${base} (build web/frontend); only the API answers`)
  const options: PageCspOptions = { ...csp, scriptHashes: readScriptHashes(base) }

  /** The export's file for a URL path, the SPA fallback, or null. */
  function resolveFile(pathname: string): string | null {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    if (decoded.includes('\0')) return null
    // No dotfiles or dot-directories (`..` included).
    if (decoded.split('/').some((part) => part.startsWith('.'))) return null
    const target = resolve(base, `.${decoded}`)
    if (target !== base && !target.startsWith(base + sep)) return null
    const candidates = decoded.endsWith('/')
      ? [join(target, 'index.html')]
      : [target, `${target}.html`, join(target, 'index.html')]
    for (const candidate of candidates) if (fileAt(candidate)) return candidate
    if (extname(decoded) || decoded.startsWith(IMMUTABLE_PREFIX)) return null
    const index = join(base, 'index.html')
    return fileAt(index) ? index : null
  }

  return {
    handle(req, res, url) {
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') return false
      const path = resolveFile(url.pathname)
      const file = path ? fileAt(path) : null
      if (!path || !file) return false
      const ext = extname(path).toLowerCase()
      const etag = `W/"${file.size.toString(16)}-${Math.trunc(file.mtimeMs).toString(16)}"`
      res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream')
      res.setHeader(
        'Cache-Control',
        url.pathname.startsWith(IMMUTABLE_PREFIX)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
      )
      res.setHeader('ETag', etag)
      if (ext === '.html') {
        const secure = req.headers['x-forwarded-proto'] === 'https'
        res.setHeader('Content-Security-Policy', pageCsp(options, req.headers.host, secure))
      }
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304
        res.end()
        return true
      }
      res.statusCode = 200
      res.setHeader('Content-Length', file.size)
      if (method === 'HEAD') {
        res.end()
        return true
      }
      const stream = createReadStream(path)
      stream.on('error', () => res.destroy())
      stream.pipe(res)
      return true
    },
  }
}
