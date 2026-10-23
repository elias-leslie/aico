// A small JSON router: method + path pattern (`:name` segments) to a handler.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { API_CSP } from './guard'
import { HttpError } from './tether'

export interface RequestContext {
  req: IncomingMessage
  res: ServerResponse
  params: Record<string, string>
  query: URLSearchParams
  /** The parsed JSON body (undefined when none was sent). */
  body(): Promise<unknown>
}

/** A handler answers JSON (status 200) or writes `res` itself and returns `RAW`. */
export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown

export const RAW = Symbol('raw response')

const MAX_BODY_BYTES = 1 << 20

interface Route {
  method: string
  pattern: RegExp
  names: string[]
  handler: Handler
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Content-Length', Buffer.byteLength(body))
  res.setHeader('Content-Security-Policy', API_CSP)
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'))
        req.destroy()
        return
      }
      parts.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8')
      if (!text) return resolve(undefined)
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'))
      }
    })
  })
}

export class Router {
  private readonly routes: Route[] = []

  on(method: string, path: string, handler: Handler): this {
    const names: string[] = []
    const source = path
      .split('/')
      .map((segment) => {
        if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        names.push(segment.slice(1))
        return '([^/]+)'
      })
      .join('/')
    this.routes.push({ method, pattern: new RegExp(`^${source}$`), names, handler })
    return this
  }

  /** Answers the request; false when no route has its path. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? 'GET'
    let pathMatched = false
    for (const route of this.routes) {
      const match = route.pattern.exec(url.pathname)
      if (!match) continue
      pathMatched = true
      if (route.method !== method) continue
      const params: Record<string, string> = {}
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1])
      })
      let body: Promise<unknown> | undefined
      try {
        const result = await route.handler({
          req,
          res,
          params,
          query: url.searchParams,
          body: () => {
            body ??= readBody(req)
            return body
          },
        })
        if (result !== RAW) sendJson(res, 200, result ?? null)
      } catch (error) {
        if (error instanceof HttpError) sendJson(res, error.status, { detail: error.detail })
        else {
          console.error(`[aico-web] ${method} ${url.pathname} failed:`, error)
          sendJson(res, 500, { detail: 'Unexpected error' })
        }
      }
      return true
    }
    if (pathMatched) {
      sendJson(res, 405, { detail: 'Method Not Allowed' })
      return true
    }
    return false
  }
}

// -- Body checks -------------------------------------------------------------

export function objectBody(value: unknown): Record<string, unknown> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(422, 'Request body must be a JSON object')
  return value as Record<string, unknown>
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  check?: { max?: number; pattern?: RegExp },
): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new HttpError(422, `${key} must be a string`)
  if (check?.max !== undefined && value.length > check.max)
    throw new HttpError(422, `${key} is too long`)
  if (check?.pattern && !check.pattern.test(value)) throw new HttpError(422, `${key} is invalid`)
  return value
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
  check?: { max?: number; pattern?: RegExp },
): string {
  const value = optionalString(body, key, check)
  if (value === undefined) throw new HttpError(422, `${key} is required`)
  return value
}

export function optionalInt(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new HttpError(422, `${key} must be an integer`)
  return value
}
