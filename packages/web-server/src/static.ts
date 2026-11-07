// The web app's page: packages/web-frontend's static export (`out/`), served at `/`.
//
// - A path names a file in the export (`/x` also tries `x.html`); anything
//   else without an extension is a page route and gets index.html (the app
//   reads its query in the browser). A missing asset is 404.
// - `/_next/static/*` names are content-hashed: cached for a year. HTML, the
//   manifest, the service worker and the rest revalidate every time (ETag).
// - Pages carry a CSP whose script-src lists the export's inline scripts by
//   hash (written by packages/web-frontend/scripts/csp-hashes.mjs at build time).
// - With `served` (AICO_WEB_FRONTEND, the deploy's `current` link to a release's export) the
//   page comes from wherever that link points now, so a frontend-only deploy swaps the link and
//   never restarts this server. Without it, or while it names no export, the bundled export
//   answers. A hashed asset the current build lacks is looked up in the `earlier-*` links beside
//   it (the builds the deploy keeps), so a tab opened before the swap still loads its chunks.

import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

/** The build step's file in `out/`: `{ "scriptHashes": ["sha256-…", …] }`. */
const CSP_HASHES_FILE = 'csp-hashes.json'

const IMMUTABLE_PREFIX = '/_next/static/'

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
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
}

/** All chat traffic and streams use the page's own origin. */
export function pageCsp(options: PageCspOptions): string {
  const scripts = ["'self'", ...options.scriptHashes.map((hash) => `'${hash}'`)]
  return [
    "default-src 'self'",
    `script-src ${scripts.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ')
}

/** The inline-script hashes the build wrote, or none (then inline scripts are refused). */
function readScriptHashes(root: string): string[] {
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

export interface StaticSiteOptions {
  /** The deploy's link to the build to serve (`…/web/current`); the bundled export answers while it names none. */
  served?: string | null
}

/** A link's target directory, or null when it resolves to nothing. */
function realDir(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

export function createStaticSite(root: string, options: StaticSiteOptions = {}): StaticSite {
  const bundled = resolve(root)
  const served = options.served ? resolve(options.served) : null
  if (
    !existsSync(join(served ?? bundled, 'index.html')) &&
    !existsSync(join(bundled, 'index.html'))
  )
    console.warn(
      `[aico-web] no web app at ${served ?? bundled} (build packages/web-frontend); only the API answers`,
    )
  // CSP hashes belong to one build: read again whenever the served link moves.
  let cached: { real: string; csp: PageCspOptions } | null = null

  /** The build answering now: the served link's target while it holds an export, else the bundled one. */
  function current(): { base: string; csp: PageCspOptions } {
    const real = served && fileAt(join(served, 'index.html')) ? realDir(served) : null
    const base = real ? (served as string) : bundled
    const key = real ?? bundled
    if (cached?.real !== key) cached = { real: key, csp: { scriptHashes: readScriptHashes(base) } }
    return { base, csp: cached.csp }
  }

  /** The kept earlier builds (`earlier-*` beside the served link), for hashed assets the current one lacks. */
  function earlier(): string[] {
    if (!served) return []
    try {
      const dir = dirname(served)
      return readdirSync(dir)
        .filter((name) => name.startsWith('earlier-') && name !== basename(served))
        .map((name) => join(dir, name))
    } catch {
      return []
    }
  }

  /** The file for a URL path under one build, or null. */
  function inside(base: string, decoded: string): string | null {
    const target = resolve(base, `.${decoded}`)
    if (target !== base && !target.startsWith(base + sep)) return null
    const candidates = decoded.endsWith('/')
      ? [join(target, 'index.html')]
      : [target, `${target}.html`, join(target, 'index.html')]
    for (const candidate of candidates) if (fileAt(candidate)) return candidate
    return null
  }

  /** The export's file for a URL path, the SPA fallback, or null. */
  function resolveFile(base: string, pathname: string): string | null {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }
    if (decoded.includes('\0')) return null
    // No dotfiles or dot-directories (`..` included).
    if (decoded.split('/').some((part) => part.startsWith('.'))) return null
    const found = inside(base, decoded)
    if (found) return found
    if (decoded.startsWith(IMMUTABLE_PREFIX)) {
      for (const dir of earlier()) {
        const kept = inside(dir, decoded)
        if (kept) return kept
      }
      return null
    }
    if (extname(decoded)) return null
    const index = join(base, 'index.html')
    return fileAt(index) ? index : null
  }

  return {
    handle(req, res, url) {
      const method = req.method ?? 'GET'
      if (method !== 'GET' && method !== 'HEAD') return false
      const { base, csp } = current()
      const path = resolveFile(base, url.pathname)
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
        res.setHeader('Content-Security-Policy', pageCsp(csp))
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
