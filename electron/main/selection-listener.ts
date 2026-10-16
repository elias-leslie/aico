// The loopback listener: Aico's own small HTTP server on 127.0.0.1:8005 (the
// port, `/health` identity and env names the old Python sidecar used, so
// SummitFlow's health check, the browser extension and `st selection send` keep
// working). Two routes:
//   GET  /health          -> {status:"ok", service:"aico-sidecar", version}
//   POST /selection/send  -> deliver the captures to the selection target, and
//                            reply {records, count, delivered, reason}
// Nothing is stored. The listener has no authentication, so it keeps the three
// guards the sidecar had: a loopback Host header (DNS rebinding), a trusted
// Origin for writes (only native clients and the pinned extension), and a 1 MiB
// body cap.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { BlockList, isIP } from 'node:net'
import type { SelectionRecord } from './selection'

/** Stable ID of the bundled MV3 extension, derived from the public `key` in
 * extension/manifest.json. `AICO_EXTENSION_IDS` (comma-separated) replaces it,
 * e.g. for a fork that ships its own key. */
export const DEFAULT_EXTENSION_ID = 'oejadbpdecaenbbihglcnchnkmlilmjf'

/** Whole-request body cap: a full 50-item batch fits with room to spare. */
export const MAX_BODY_BYTES = 1024 * 1024
/** Items per send (the old selection ring size, which the extension mirrors). */
export const MAX_ITEMS = 50
const SNIPPET_CAP = 2000
const META_CAP = 4000
const LABEL_CAP = 200
const KINDS = new Set(['dom', 'a11y', 'region'])

/** One validated capture, as echoed back in the reply. */
export interface CaptureRecord extends SelectionRecord {
  kind: string
  snippet: string
  captured_at: string
  widget: string | null
  project: string | null
  meta: Record<string, unknown>
}

/** What became of a send: typed at a session prompt, or why not. */
export type Delivery = { delivered: true; reason: null } | { delivered: false; reason: string }

export interface SelectionListenerOptions {
  host: string
  port: number
  /** Raw `AICO_EXTENSION_IDS`; unset or blank trusts only the bundled extension. */
  extensionIds: string | undefined
  version: string
  deliver(records: CaptureRecord[]): Promise<Delivery>
  log?: (line: string) => void
}

/** The trusted extension IDs, or an error naming the malformed one. A bad ID
 * refuses the listener rather than silently widening or emptying the set. */
export function trustedExtensionIds(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set([DEFAULT_EXTENSION_ID])
  const ids = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  for (const id of ids) {
    if (!/^[a-p]{32}$/.test(id)) {
      throw new Error(`invalid extension id ${JSON.stringify(id)} in AICO_EXTENSION_IDS`)
    }
  }
  return new Set(ids)
}

const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')

function isLoopbackName(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true
  const family = isIP(host)
  return family !== 0 && loopback.check(host, family === 4 ? 'ipv4' : 'ipv6')
}

/** Refuse a bind the listener should never make: it is unauthenticated, so a
 * non-loopback host would open selection injection to the network. */
export function bindError(host: string, port: number): string | null {
  if (!isLoopbackName(host)) {
    return `refusing non-loopback bind host ${JSON.stringify(host)}: the listener is unauthenticated`
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return `invalid AICO_SIDECAR_PORT ${JSON.stringify(String(port))}: expected 1-65535`
  }
  return null
}

/** True if a Host header names this listener: localhost or a loopback IP
 * literal, bare or with the listening port. An IP literal needs no DNS, so it
 * cannot be rebound; a rebinding page still sends its own name. */
export function isAllowedHost(header: string | undefined, port: number): boolean {
  if (!header) return false
  const match = /^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9.-]+))(?::(\d{1,5}))?$/.exec(header)
  if (!match) return false
  const host = match[1] ?? match[2]
  if (match[1] !== undefined && isIP(host) !== 6) return false
  if (!isLoopbackName(host)) return false
  return match[3] === undefined || Number(match[3]) === port
}

/** Writes are accepted only from native clients (no Origin: Electron, `st`,
 * curl) or a pinned extension. A web page, local ones included, always carries
 * its own Origin and cannot suppress it. */
export function isTrustedOrigin(origin: string | undefined, ids: Set<string>): boolean {
  if (origin === undefined) return true
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)
  return match !== null && ids.has(match[1])
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalLabel(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || value.length > LABEL_CAP) {
    throw new HttpError(422, `${field} must be a string of at most ${LABEL_CAP} characters`)
  }
  return value
}

/** Validate a whole batch before anything is delivered; a bad item refuses it all. */
export function parseBatch(body: unknown, now = new Date()): CaptureRecord[] {
  if (!isPlainObject(body) || !Array.isArray(body.items)) {
    throw new HttpError(422, 'expected {"items": [...]}')
  }
  const { items } = body
  if (items.length < 1 || items.length > MAX_ITEMS) {
    throw new HttpError(422, `items must hold 1-${MAX_ITEMS} captures`)
  }
  const capturedAt = now.toISOString()
  return items.map((item): CaptureRecord => {
    if (!isPlainObject(item)) throw new HttpError(422, 'each item must be an object')
    if (typeof item.kind !== 'string' || !KINDS.has(item.kind)) {
      throw new HttpError(422, `invalid kind: expected one of ${[...KINDS].join(', ')}`)
    }
    const snippet = item.snippet ?? ''
    if (typeof snippet !== 'string') throw new HttpError(422, 'snippet must be a string')
    const meta = item.meta ?? {}
    if (!isPlainObject(meta)) throw new HttpError(422, 'meta must be an object')
    const metaLength = JSON.stringify(meta).length
    if (metaLength > META_CAP) {
      throw new HttpError(422, `meta too large: ${metaLength} bytes (cap ${META_CAP})`)
    }
    return {
      kind: item.kind,
      snippet: snippet.trim().slice(0, SNIPPET_CAP),
      captured_at: capturedAt,
      widget: optionalLabel(item.widget, 'widget'),
      project: optionalLabel(item.project, 'project'),
      meta,
    }
  })
}

/** Read the body, refusing anything over the cap: up front from
 * Content-Length, and while streaming for chunked bodies. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > MAX_BODY_BYTES) return Promise.reject(new HttpError(413, 'request body too large'))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (chunk: Buffer): void => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.off('data', onData)
        reject(new HttpError(413, 'request body too large'))
        return
      }
      chunks.push(chunk)
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createSelectionListener(opts: SelectionListenerOptions) {
  const log = opts.log ?? ((line: string) => console.log(line))
  let server: Server | null = null
  let ids = new Set<string>()
  let boundPort = opts.port

  function reply(
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload)),
      ...headers,
    })
    res.end(payload)
  }

  /** CORS answers only a pinned extension, so no web page can read a reply. */
  function cors(req: IncomingMessage): Record<string, string> {
    const { origin } = req.headers
    return origin !== undefined && isTrustedOrigin(origin, ids)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {}
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The rebinding guard runs before anything else, CORS included.
    if (!isAllowedHost(req.headers.host, boundPort)) {
      reply(res, 403, { detail: 'host not allowed' })
      return
    }
    const headers = cors(req)
    const path = (req.url ?? '/').split('?')[0]
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      if (!headers['Access-Control-Allow-Origin']) {
        reply(res, 400, { detail: 'Disallowed CORS origin' })
        return
      }
      reply(res, 200, 'OK', {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
        'Access-Control-Max-Age': '600',
      })
      return
    }
    if (path === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        reply(res, 405, { detail: 'Method Not Allowed' }, { ...headers, Allow: 'GET' })
        return
      }
      reply(res, 200, { status: 'ok', service: 'aico-sidecar', version: opts.version }, headers)
      return
    }
    if (path === '/selection/send') {
      if (req.method !== 'POST') {
        reply(res, 405, { detail: 'Method Not Allowed' }, { ...headers, Allow: 'POST' })
        return
      }
      if (!isTrustedOrigin(req.headers.origin, ids)) {
        reply(res, 403, { detail: 'origin not allowed' })
        return
      }
      const raw = await readBody(req)
      let body: unknown
      try {
        body = JSON.parse(raw.toString('utf8'))
      } catch {
        throw new HttpError(422, 'body is not valid JSON')
      }
      const records = parseBatch(body)
      const delivery = await opts.deliver(records)
      reply(res, 200, { records, count: records.length, ...delivery }, headers)
      return
    }
    reply(res, 404, { detail: 'Not Found' }, headers)
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (error instanceof HttpError) {
        // An over-cap body is not drained: answer, then drop the connection.
        const tooLarge = error.status === 413
        if (tooLarge) res.on('finish', () => req.socket.destroy())
        reply(
          res,
          error.status,
          { detail: error.detail },
          {
            ...cors(req),
            ...(tooLarge ? { Connection: 'close' } : {}),
          },
        )
        return
      }
      log(`[aico] selection listener error: ${error instanceof Error ? error.message : error}`)
      reply(res, 500, { detail: 'internal error' })
    })
  }

  return {
    /** Listen; resolves the bound port, or null when the listener could not
     * start (bad config, port taken). Capture is optional, so Aico runs on. */
    start: (): Promise<number | null> => {
      const refused = bindError(opts.host, opts.port)
      try {
        if (refused) throw new Error(refused)
        ids = trustedExtensionIds(opts.extensionIds)
      } catch (error) {
        log(`[aico] selection listener not started: ${(error as Error).message}`)
        return Promise.resolve(null)
      }
      const listening = createServer(onRequest)
      listening.requestTimeout = 15_000
      listening.headersTimeout = 10_000
      return new Promise((resolve) => {
        listening.once('error', (error) => {
          log(`[aico] selection listener not started: ${error.message}`)
          resolve(null)
        })
        listening.listen(opts.port, opts.host, () => {
          const address = listening.address()
          boundPort = typeof address === 'object' && address ? address.port : opts.port
          server = listening
          log(`[aico] selection listener ready: http://${opts.host}:${boundPort}/health`)
          resolve(boundPort)
        })
      })
    },
    /** Quit. Safe if never started. */
    stop: (): void => {
      server?.close()
      server?.closeAllConnections()
      server = null
    },
  }
}
