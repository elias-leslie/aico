// A session's folder through Tether: the browser's answers as they are, its
// refusals with their plain words, and nothing for a session without a folder.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpError, Router, sendError } from '../http'
import { registerFileRoutes } from './api'

let server: Server
let base: string
let top: string
let folders: Record<string, string | null>

async function get(path: string) {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  top = realpathSync(mkdtempSync(join(tmpdir(), 'tether-files-')))
  mkdirSync(join(top, 'src'))
  writeFileSync(join(top, 'README.md'), 'hello\n')
  writeFileSync(join(top, '.env'), 'SECRET=1')
  folders = { aaaa1111: top, bbbb2222: null, cccc3333: join(top, 'gone') }
  const router = new Router()
  registerFileRoutes(router, (id) => folders[id])
  server = createServer((req, res) => {
    router.dispatch(req, res).catch((error) => {
      if (error instanceof HttpError) sendError(res, error)
      else sendError(res, new HttpError(500, 'internal_error'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(top, { recursive: true, force: true })
})

describe('session file routes', () => {
  it("lists and reads the session's folder in the web browser's shape", async () => {
    expect(await get('/v1/sessions/aaaa1111/files/tree')).toEqual({
      status: 200,
      body: {
        entries: [
          { name: 'src', path: 'src', is_directory: true, children_count: 0 },
          { name: 'README.md', path: 'README.md', is_directory: false, size: 6, extension: '.md' },
        ],
        path: '',
        total: 2,
      },
    })
    const content = await get('/v1/sessions/aaaa1111/files/content?path=README.md')
    expect(content.status).toBe(200)
    expect(content.body).toMatchObject({ content: 'hello\n', language: 'markdown', lines: 1 })
  })

  it('refuses secrets, escapes and missing files with their words', async () => {
    expect(await get('/v1/sessions/aaaa1111/files/content?path=.env')).toEqual({
      status: 403,
      body: { error: 'access_denied', detail: 'Access denied: .env' },
    })
    expect(
      ((await get('/v1/sessions/aaaa1111/files/tree?path=../..')).body as { error?: string }).error,
    ).toBe('access_denied')
    expect(await get('/v1/sessions/aaaa1111/files/content?path=nope.txt')).toMatchObject({
      status: 404,
      body: { error: 'no_such_file' },
    })
    expect(await get('/v1/sessions/aaaa1111/files/content')).toEqual({
      status: 400,
      body: { error: 'invalid_query', field: 'path' },
    })
  })

  it('answers an unknown session 404 and one without a folder 409', async () => {
    expect(await get('/v1/sessions/dddd4444/files/tree')).toEqual({
      status: 404,
      body: { error: 'not_found' },
    })
    expect(await get('/v1/sessions/bbbb2222/files/tree')).toEqual({
      status: 409,
      body: { error: 'no_folder', detail: 'This session has no folder' },
    })
    expect(await get('/v1/sessions/cccc3333/files/tree')).toEqual({
      status: 409,
      body: { error: 'no_folder', detail: 'This session’s folder no longer exists' },
    })
  })
})
