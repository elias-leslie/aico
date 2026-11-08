// The apps on the Proxmox host (Portfolio, Jobinator, the OmniNull hub, the canary) talk to one
// address that is always up: the standby's LAN listeners. While the workstation's own listener on
// that port answers, a request is simply passed to it, so nothing about an app's calls changes with
// the workstation on (its GPU model, its Status, its notices). When the workstation doesn't answer,
// the same request is handled here. A primary that started answering keeps the request.

import {
  request as httpRequest,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from 'node:http'
import { Readable } from 'node:stream'

export interface PrimaryOptions {
  /** How long the workstation gets to accept the connection. A machine that is off never does. */
  connectMs?: number
  /** After a refused or silent connection, requests stay here for this long without trying again. */
  downMs?: number
  maxBodyBytes: number
  now?: () => number
  /** A request the primary took, with its body: what this machine should remember of it anyway. */
  taken?: (req: IncomingMessage, body: Buffer) => void
  /** The primary's answer is not the last word: the answer it gave means "try here". */
  askHere?: (req: IncomingMessage, status: number) => boolean
}

const CONNECT_MS = 2000
const DOWN_MS = 30_000
/** Connection-scoped headers a proxy never passes on (RFC 9110, 7.6.1). */
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'trailer'])

function readAll(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= max) parts.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(size > max ? null : Buffer.concat(parts)))
  })
}

/** The request again, for the local router, which reads its body from the stream. */
function replay(req: IncomingMessage, body: Buffer): IncomingMessage {
  const copy = Readable.from(body.length ? [body] : []) as unknown as IncomingMessage
  return Object.assign(copy, {
    method: req.method,
    url: req.url,
    headers: req.headers,
    socket: req.socket,
  })
}

class ServicePrimary {
  private readonly target: URL
  private downUntil = 0

  constructor(
    url: string,
    private readonly options: PrimaryOptions,
  ) {
    this.target = new URL(url)
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  /** Passes the request on, or hands it to `local` when the primary didn't take it. */
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    local: (req: IncomingMessage) => void,
  ): Promise<void> {
    if (this.now() < this.downUntil) return local(req)
    const body = await readAll(req, this.options.maxBodyBytes)
    // Too big for anyone: the local router gives the answer.
    if (body === null) return local(replay(req, Buffer.alloc(0)))
    const taken = await this.forward(req, res, body)
    if (taken === 'here') return local(replay(req, body))
    if (taken === 'down') {
      this.downUntil = this.now() + (this.options.downMs ?? DOWN_MS)
      return local(replay(req, body))
    }
    this.options.taken?.(req, body)
  }

  private forward(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
  ): Promise<'taken' | 'here' | 'down'> {
    return new Promise((resolve) => {
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(([name]) => !HOP.has(name)),
      )
      const out = httpRequest({
        host: this.target.hostname,
        port: this.target.port,
        method: req.method,
        path: req.url,
        headers: { ...headers, host: this.target.host, 'content-length': body.length },
      })
      const connecting = setTimeout(
        () => out.destroy(new Error('no answer')),
        this.options.connectMs ?? CONNECT_MS,
      )
      out.on('socket', (socket) => {
        if (socket.connecting) socket.once('connect', () => clearTimeout(connecting))
        else clearTimeout(connecting)
      })
      out.on('response', (answer) => {
        clearTimeout(connecting)
        if (this.options.askHere?.(req, answer.statusCode ?? 0)) {
          answer.resume()
          return resolve('here')
        }
        const kept = Object.fromEntries(
          Object.entries(answer.headers).filter(([name]) => !HOP.has(name)),
        )
        res.writeHead(answer.statusCode ?? 502, kept as Record<string, string | string[]>)
        answer.pipe(res)
        // Past this point the workstation has the request: a drop ends the app's call, it isn't replayed.
        answer.on('error', () => res.destroy())
        resolve('taken')
      })
      out.on('error', () => {
        clearTimeout(connecting)
        // The workstation went away holding the request and hadn't answered: this machine answers.
        resolve('down')
      })
      out.end(body)
    })
  }
}

/** `AICO_PRIMARY_HOST` (only the standby sets it) and the port of the listener being fronted. */
export function primaryUrl(env: NodeJS.ProcessEnv, port: number | string): string | null {
  const host = env.AICO_PRIMARY_HOST?.trim()
  return host ? `http://${host}:${port}` : null
}

/** A listener that hands each request to the primary first; without one, it is just `local`. */
export function frontedBy(
  url: string | null,
  local: RequestListener,
  options: Omit<PrimaryOptions, 'maxBodyBytes'> & { maxBodyBytes?: number } = {},
): RequestListener {
  if (!url) return local
  const primary = new ServicePrimary(url, { maxBodyBytes: 8 * 1024 * 1024, ...options })
  return (req, res) => {
    primary
      .handle(req, res, (request) => local(request, res))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end()
      })
  }
}
