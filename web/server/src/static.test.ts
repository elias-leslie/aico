import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Router } from './http'
import { createWebServer } from './server'
import { createStaticSite, pageCsp } from './static'
import { TerminalHub } from './terminal'
import { FakeTether } from './testing'

let root: string
let server: Server
let base: string

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'aico-static-'))
  mkdirSync(join(root, '_next', 'static', 'chunks'), { recursive: true })
  mkdirSync(join(root, 'icons'))
  writeFileSync(join(root, 'index.html'), '<html>app</html>')
  writeFileSync(join(root, '404.html'), '<html>missing</html>')
  writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"Aico"}')
  writeFileSync(join(root, 'sw.js'), 'self')
  writeFileSync(join(root, 'icons', 'icon-192.png'), 'png')
  writeFileSync(join(root, '_next', 'static', 'chunks', 'a1b2.js'), 'chunk')
  writeFileSync(join(root, '.secret'), 'hidden')
  writeFileSync(
    join(root, 'csp-hashes.json'),
    JSON.stringify({ scriptHashes: ['sha256-abc=', "bad' 'unsafe-inline"] }),
  )
  const router = new Router().on('GET', '/health', () => ({ status: 'healthy' }))
  const tether = new FakeTether()
  server = createWebServer(
    { allowedHostnames: ['127.0.0.1'], allowedOrigins: [] },
    router,
    new TerminalHub({ tether: tether.client, historyLines: 10, touched: () => {} }),
    createStaticSite(root, { agentHubUrl: null, agentHubPort: 8003 }),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
})

describe('static site', () => {
  it('serves the page at / with a hashed-script CSP and no caching', async () => {
    const response = await fetch(`${base}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<html>app</html>')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("script-src 'self' 'sha256-abc='")
    expect(csp).not.toContain('unsafe-inline\'"')
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:8003")
  })

  it('falls back to the page for app routes but not for missing assets', async () => {
    const route = await fetch(`${base}/sessions/abc?project=x`)
    expect(route.status).toBe(200)
    expect(await route.text()).toBe('<html>app</html>')
    expect((await fetch(`${base}/missing.png`)).status).toBe(404)
    expect((await fetch(`${base}/_next/static/chunks/gone`)).status).toBe(404)
    expect((await fetch(`${base}/api/nope`)).status).toBe(404)
    expect((await fetch(`${base}/404`)).status).toBe(200)
  })

  it('caches hashed assets for good and revalidates the rest', async () => {
    const chunk = await fetch(`${base}/_next/static/chunks/a1b2.js`)
    expect(await chunk.text()).toBe('chunk')
    expect(chunk.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(chunk.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(chunk.headers.get('content-security-policy')).toBeNull()

    const manifest = await fetch(`${base}/manifest.webmanifest`)
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json')
    expect(manifest.headers.get('cache-control')).toBe('no-cache')
    const worker = await fetch(`${base}/sw.js`)
    expect(worker.headers.get('cache-control')).toBe('no-cache')

    const etag = worker.headers.get('etag') ?? ''
    const again = await fetch(`${base}/sw.js`, { headers: { 'If-None-Match': etag } })
    expect(again.status).toBe(304)
  })

  it('refuses dotfiles, traversal and other methods', async () => {
    expect((await fetch(`${base}/.secret`)).status).toBe(404)
    expect((await fetch(`${base}/icons/%2e%2e/.secret`)).status).toBe(404)
    expect((await fetch(`${base}/%00`)).status).toBe(404)
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(404)
    const head = await fetch(`${base}/icons/icon-192.png`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('3')
  })

  it('keeps the API and health ahead of the page', async () => {
    const health = await fetch(`${base}/health`)
    expect(await health.json()).toEqual({ status: 'healthy' })
  })

  it('refuses a foreign host before serving anything', async () => {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/`, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(403)
  })
})

describe('pageCsp', () => {
  it('lets the voice socket reach Agent Hub on the page host or its configured URL', () => {
    const csp = pageCsp(
      { scriptHashes: [], agentHubUrl: 'https://hub.example', agentHubPort: 8003 },
      'aico.example:443',
      true,
    )
    expect(csp).toContain(
      "connect-src 'self' wss://aico.example:8003 https://hub.example wss://hub.example",
    )
    expect(csp).toContain("frame-ancestors 'none'")
  })
})
