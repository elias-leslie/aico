import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { type IncomingMessage, request, type Server } from 'node:http'
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
    { allowedHostnames: ['127.0.0.1'], allowedOrigins: [], hostName: 'gem' },
    router,
    new TerminalHub({ tether: tether.client, historyLines: 10, touched: () => {} }),
    createStaticSite(root),
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
  it('names the answering host on every response, refusals and misses included', async () => {
    for (const path of ['/', '/health', '/api/nope', '/missing.png'])
      expect((await fetch(`${base}${path}`)).headers.get('x-aico-host'), path).toBe('gem')
    const refused = await new Promise<IncomingMessage>((resolve, reject) =>
      request(`${base}/health`, { headers: { host: 'evil.example' } }, resolve)
        .on('error', reject)
        .end(),
    )
    expect(refused.statusCode).toBe(403)
    expect(refused.headers['x-aico-host']).toBe('gem')
  })

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
    expect(csp).toContain("connect-src 'self'")
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

describe('a build served from the deploy link', () => {
  /** A build with one page, one hashed chunk and its CSP hash. */
  const build = (dir: string, page: string, chunk: string, hash: string) => {
    mkdirSync(join(dir, '_next', 'static', 'chunks'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), page)
    writeFileSync(join(dir, '_next', 'static', 'chunks', `${chunk}.js`), chunk)
    writeFileSync(join(dir, 'csp-hashes.json'), JSON.stringify({ scriptHashes: [hash] }))
  }
  const relink = (link: string, target: string) => {
    symlinkSync(target, `${link}.tmp`)
    renameSync(`${link}.tmp`, link)
  }

  it('follows the link without a restart, keeps earlier chunks, and falls back to its own build', async () => {
    const top = join(root, 'deploy')
    const web = join(top, 'web')
    mkdirSync(web, { recursive: true })
    build(join(top, 'bundled'), 'bundled', 'b0', 'sha256-b0=')
    build(join(top, 'one'), 'one', 'c1', 'sha256-c1=')
    build(join(top, 'two'), 'two', 'c2', 'sha256-c2=')
    const site = createStaticSite(join(top, 'bundled'), { served: join(web, 'current') })
    const linked = createWebServer(
      { allowedHostnames: ['127.0.0.1'], allowedOrigins: [], hostName: 'gem' },
      new Router(),
      new TerminalHub({ tether: new FakeTether().client, historyLines: 10, touched: () => {} }),
      site,
    )
    await new Promise<void>((resolve) => linked.listen(0, '127.0.0.1', resolve))
    const at = `http://127.0.0.1:${(linked.address() as AddressInfo).port}`
    const page = async () => {
      const response = await fetch(`${at}/`)
      return [await response.text(), response.headers.get('content-security-policy') ?? '']
    }
    try {
      // No link yet: the server's own build.
      expect((await page())[0]).toBe('bundled')
      relink(join(web, 'current'), join(top, 'one'))
      const [first, firstCsp] = await page()
      expect(first).toBe('one')
      expect(firstCsp).toContain("'sha256-c1='")
      // The deploy swaps the link and keeps the build before as earlier-*.
      relink(join(web, 'current'), join(top, 'two'))
      relink(join(web, 'earlier-one'), join(top, 'one'))
      const [second, secondCsp] = await page()
      expect(second).toBe('two')
      expect(secondCsp).toContain("'sha256-c2='")
      expect(secondCsp).not.toContain('c1')
      expect(await (await fetch(`${at}/_next/static/chunks/c1.js`)).text()).toBe('c1')
      expect(await (await fetch(`${at}/_next/static/chunks/c2.js`)).text()).toBe('c2')
      expect((await fetch(`${at}/_next/static/chunks/b0.js`)).status).toBe(404)
      // An earlier build answers only for hashed assets, never for pages.
      expect((await fetch(`${at}/one.html`)).status).toBe(404)
    } finally {
      linked.closeAllConnections()
      await new Promise((resolve) => linked.close(resolve))
    }
  })
})

describe('pageCsp', () => {
  it('connects only to the same origin', () => {
    const csp = pageCsp({ scriptHashes: [] })
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain('hub.example')
    expect(csp).toContain("frame-ancestors 'none'")
  })
})
