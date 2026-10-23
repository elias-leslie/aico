// One HTTP server for the web app: the guard and headers on every request,
// the JSON API, and the terminal WebSocket upgrade.

import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { applySecurityHeaders, checkRequest, checkUpgrade, type GuardConfig } from './guard'
import { type Router, sendJson } from './http'
import { TERMINAL_PATH, type TerminalHub } from './terminal'

/** Answer an upgrade we will not accept, then drop the socket. */
function refuseUpgrade(socket: Duplex, status: number, reason: string, error: string): void {
  const body = JSON.stringify({ error })
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  )
}

export function createWebServer(
  guard: GuardConfig,
  router: Router,
  terminals: TerminalHub,
): Server {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 })
  const server = createServer((req, res) => {
    applySecurityHeaders(res)
    const refused = checkRequest(req.method ?? 'GET', req.headers, guard)
    if (refused) return sendJson(res, 403, { error: refused })
    const url = new URL(req.url ?? '/', 'http://localhost')
    router
      .handle(req, res, url)
      .then((handled) => {
        if (!handled) sendJson(res, 404, { detail: 'Not Found' })
      })
      .catch((error) => {
        console.error('[aico-web] request failed:', error)
        if (!res.headersSent) sendJson(res, 500, { detail: 'Unexpected error' })
        else res.destroy()
      })
  })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    const refused = checkUpgrade(req.headers, guard)
    if (refused) return refuseUpgrade(socket, 403, 'Forbidden', refused)
    const match = TERMINAL_PATH.exec(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (!match) return refuseUpgrade(socket, 404, 'Not Found', 'not_found')
    let sessionId: string
    try {
      sessionId = decodeURIComponent(match[1])
    } catch {
      return refuseUpgrade(socket, 400, 'Bad Request', 'invalid_session')
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      terminals.serve(ws, req, sessionId).catch((error) => {
        console.error(`[aico-web] terminal ${sessionId} failed:`, error)
        ws.close(1011, 'internal error')
      })
    })
  })
  return server
}
