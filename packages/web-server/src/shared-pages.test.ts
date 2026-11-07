import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSharedPageRoutes, SHARED_PAGE_CSP, sharedBy } from './shared-pages'
import type { Share } from './shows'
import { serveRoutes } from './testing'

let top: string
let shares: Share[]
let server: Awaited<ReturnType<typeof serveRoutes>>

const share = (paths: string[], host?: string): Share => ({
  id: 'abcdef123456',
  session: null,
  title: null,
  createdAt: new Date(0).toISOString(),
  kind: 'files',
  paths,
  ...(host ? { host } : {}),
})
const page = (path: string) =>
  fetch(`${server.base}/api/files/page${path.split('/').map(encodeURIComponent).join('/')}`)

beforeEach(async () => {
  top = realpathSync(mkdtempSync(join(tmpdir(), 'aico-pages-')))
  mkdirSync(join(top, 'mockup', 'img'), { recursive: true })
  writeFileSync(join(top, 'mockup', 'index.html'), '<link rel="stylesheet" href="style.css">Hi')
  writeFileSync(join(top, 'mockup', 'style.css'), 'body{}')
  writeFileSync(join(top, 'mockup', 'img', 'dot.png'), 'png')
  writeFileSync(join(top, 'mockup', 'face.woff2'), 'font')
  writeFileSync(join(top, 'mockup', '.env'), 'SECRET=1')
  writeFileSync(join(top, 'private.txt'), 'not shared')
  symlinkSync(join(top, 'private.txt'), join(top, 'mockup', 'leak.txt'))
  shares = [share([join(top, 'mockup', 'index.html')])]
  server = await serveRoutes((router) =>
    registerSharedPageRoutes(router, { shares: async () => shares }),
  )
})

afterEach(async () => {
  await server.close()
  rmSync(top, { recursive: true, force: true })
})

describe('shared pages', () => {
  it('serves a shared HTML file as a sandboxed page', async () => {
    const res = await page(join(top, 'mockup', 'index.html'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(SHARED_PAGE_CSP)
    expect(SHARED_PAGE_CSP).toBe('sandbox allow-scripts allow-popups')
    expect(await res.text()).toContain('style.css')
  })

  it('answers HEAD with the same headers', async () => {
    const res = await fetch(`${server.base}/api/files/page${join(top, 'mockup', 'index.html')}`, {
      method: 'HEAD',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBe(SHARED_PAGE_CSP)
  })

  it('serves the files beside it and under its folder, also sandboxed', async () => {
    const css = await page(join(top, 'mockup', 'style.css'))
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(css.headers.get('content-security-policy')).toBe(SHARED_PAGE_CSP)
    const img = await page(join(top, 'mockup', 'img', 'dot.png'))
    expect(img.headers.get('content-type')).toBe('image/png')
    const font = await page(join(top, 'mockup', 'face.woff2'))
    expect(font.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('refuses a file that is not shared, with a page that says so', async () => {
    const res = await page(join(top, 'private.txt'))
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(res.headers.get('content-security-policy')).toBe(SHARED_PAGE_CSP)
    expect(await res.text()).toContain('Not shared')
  })

  it('refuses a link out of the shared folder, secrets, and dot segments', async () => {
    expect((await page(join(top, 'mockup', 'leak.txt'))).status).toBe(403)
    expect((await page(join(top, 'mockup', '.env'))).status).toBe(403)
    const traversal = await fetch(
      `${server.base}/api/files/page${join(top, 'mockup')}/%2e%2e/private.txt`,
    )
    expect(traversal.status).not.toBe(200)
    const encodedSlash = await fetch(
      `${server.base}/api/files/page${join(top, 'mockup')}/..%2fprivate.txt`,
    )
    expect(encodedSlash.status).toBe(400)
  })

  it('lists no folders and says when a shared file is gone', async () => {
    const folder = await page(join(top, 'mockup', 'img'))
    expect(folder.status).toBe(404)
    rmSync(join(top, 'mockup', 'index.html'))
    const gone = await page(join(top, 'mockup', 'index.html'))
    expect(gone.status).toBe(404)
    expect(await gone.text()).toContain('File moved or deleted')
  })

  it('opens anything under a shared folder, but not a linked host’s files', async () => {
    shares = [share([`${join(top, 'mockup')}/`])]
    expect((await page(join(top, 'mockup', 'img', 'dot.png'))).status).toBe(200)
    shares = [share([join(top, 'mockup', 'index.html')], 'other-host')]
    expect((await page(join(top, 'mockup', 'index.html'))).status).toBe(403)
  })

  it('lends nothing else for a file shared at the top of the disk', () => {
    expect(sharedBy('/etc/hosts', [share(['/notes.html'])])).toBe(false)
    expect(sharedBy('/notes.html', [share(['/notes.html'])])).toBe(true)
  })
})
