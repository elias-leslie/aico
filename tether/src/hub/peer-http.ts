// HTTP over a peer's forwarded control socket: one JSON exchange, an NDJSON
// stream, and verbatim forwarding of a client's request. The daemon keeps its
// own small copy rather than importing the apps' client library (bundle.test.ts).

import { type IncomingMessage, request, type ServerResponse } from 'node:http'

export class PeerUnavailable extends Error {}

export interface PeerAnswer {
  status: number
  body: unknown
}

/** One JSON request. Rejects with PeerUnavailable when the socket or the
 * exchange failed; any HTTP status is an answer. */
export function peerRequest(
  socketPath: string,
  method: string,
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<PeerAnswer> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        socketPath,
        method,
        path,
        timeout: timeoutMs,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (chunk: Buffer) => parts.push(chunk))
        res.on('error', (error) => reject(new PeerUnavailable(error.message)))
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8')
          try {
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null })
          } catch {
            reject(new PeerUnavailable(`peer answered ${res.statusCode} with a non-JSON body`))
          }
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error(`timed out after ${timeoutMs} ms`)))
    req.on('error', (error) => reject(new PeerUnavailable(error.message)))
    if (payload) req.write(payload)
    req.end()
  })
}

/** Follow an NDJSON stream until it ends, fails, is aborted, or stays silent
 * for `idleMs` (three missed 15 s heartbeats by default). */
export function peerStream(
  socketPath: string,
  path: string,
  onLine: (value: unknown) => void,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  idleMs = 45_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve()
      return
    }
    let idle: NodeJS.Timeout | null = null
    const req = request({ socketPath, method: 'GET', path, headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new PeerUnavailable(`peer answered ${res.statusCode} on ${path}`))
        return
      }
      let buffer = ''
      const touch = () => {
        if (idle) clearTimeout(idle)
        idle = setTimeout(() => req.destroy(new Error('peer stream went silent')), idleMs)
      }
      touch()
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        touch()
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (line) {
            try {
              onLine(JSON.parse(line))
            } catch {
              // A malformed line is skipped; the stream itself is still good.
            }
          }
          newline = buffer.indexOf('\n')
        }
      })
      res.on('end', () => resolve())
      res.on('error', (error) => reject(new PeerUnavailable(error.message)))
    })
    const abort = () => req.destroy()
    signal.addEventListener('abort', abort, { once: true })
    req.on('error', (error) =>
      signal.aborted ? resolve() : reject(new PeerUnavailable(error.message)),
    )
    req.on('close', () => {
      if (idle) clearTimeout(idle)
      signal.removeEventListener('abort', abort)
      resolve()
    })
    req.end()
  })
}

/** JSON answers larger than this are passed through untouched. */
const MAX_TAGGED_BYTES = 16 * 1024 * 1024

const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'host'])

/**
 * Forward one client request verbatim (method, path, headers, body) and pipe
 * the answer back. A JSON answer is rewritten by `rewrite` (the hub adds
 * `host`); streams and other bodies pass through. Resolves false when the peer
 * could not be reached before anything was sent back.
 */
export function forwardRequest(
  socketPath: string,
  req: IncomingMessage,
  res: ServerResponse,
  rewrite: (status: number, body: unknown) => unknown,
): Promise<boolean> {
  return new Promise((resolve) => {
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([key]) => !HOP_HEADERS.has(key)),
    )
    const upstream = request(
      { socketPath, method: req.method, path: req.url, headers },
      (answer) => {
        const status = answer.statusCode ?? 502
        const type = String(answer.headers['content-type'] ?? '')
        const length = Number(answer.headers['content-length'] ?? Number.NaN)
        if (
          !type.startsWith('application/json') ||
          !Number.isSafeInteger(length) ||
          length > MAX_TAGGED_BYTES
        ) {
          const passed = Object.fromEntries(
            Object.entries(answer.headers).filter(([key]) => !HOP_HEADERS.has(key)),
          )
          res.writeHead(status, passed)
          answer.pipe(res)
          res.once('close', () => answer.destroy())
          // The host went away mid-stream: end ours too, never hang "live".
          answer.once('close', () => {
            if (!answer.complete) res.destroy()
          })
          resolve(true)
          return
        }
        const parts: Buffer[] = []
        answer.on('data', (chunk: Buffer) => parts.push(chunk))
        answer.on('error', () => {
          res.destroy()
          resolve(true)
        })
        answer.on('end', () => {
          let body: unknown
          try {
            body = JSON.parse(Buffer.concat(parts).toString('utf8'))
          } catch {
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'peer_invalid_answer' }))
            resolve(true)
            return
          }
          const text = JSON.stringify(rewrite(status, body))
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(text),
            'cache-control': 'no-store',
          })
          res.end(text)
          resolve(true)
        })
      },
    )
    upstream.on('error', () => {
      if (res.headersSent) res.destroy()
      resolve(res.headersSent)
    })
    // A client that goes away mid-stream ends the peer side too.
    res.once('close', () => upstream.destroy())
    req.pipe(upstream)
  })
}
