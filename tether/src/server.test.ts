import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callSocket } from './client'
import { resolvePaths, type TetherPaths } from './config'
import { type RunningDaemon, startDaemon } from './daemon'
import type { TetherEvent } from './events'

let dir: string
let paths: TetherPaths
let daemon: RunningDaemon

// Never observe, adopt or stop real tmux servers from a unit test.
const TEST_ENV = {
  TETHER_SUMMITFLOW_URL: 'off',
  TETHER_RECONCILE: 'off',
  TETHER_ATERM_LEGACY_SOCKET: '/nonexistent/tether-test/default',
  HOME: '/nonexistent',
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-srv-'))
  paths = resolvePaths({
    instance: 'test',
    env: {
      HOME: dir,
      TETHER_STATE_DIR: join(dir, 'state'),
      TETHER_RUNTIME_DIR: join(dir, 'run'),
      XDG_CONFIG_HOME: join(dir, 'config'),
    },
  })
  daemon = await startDaemon(paths, TEST_ENV)
  await daemon.ready
})

afterEach(async () => {
  await daemon.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (method: string, path: string, body?: unknown) =>
  callSocket(paths.socket, method, path, body)

describe('control socket', () => {
  it('is a 0600 socket in a 0700 directory and refuses a second daemon', async () => {
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600)
    expect(statSync(paths.socketDir).mode & 0o777).toBe(0o700)
    expect(statSync(paths.stateDir).mode & 0o777).toBe(0o700)
    await expect(startDaemon(paths, TEST_ENV)).rejects.toThrow(/already listening/)
  })

  it('answers health and version with the API version', async () => {
    const health = await call('GET', '/v1/health')
    expect(health.status).toBe(200)
    expect(health.body).toMatchObject({
      status: 'ok',
      instance: 'test',
      apiVersion: 1,
      schemaVersion: 2,
      lifecycle: 'disabled',
      gui: { connected: false },
    })
    const version = await call('GET', '/v1/version')
    expect(version.body).toMatchObject({ name: 'tether', apiVersion: 1, minApiVersion: 1 })
  })

  it('returns 404 and 405 with stable error codes', async () => {
    expect((await call('GET', '/nope')).body).toEqual({ error: 'not_found' })
    expect((await call('DELETE', '/v1/health')).status).toBe(405)
  })

  it('serves the local project list when SummitFlow is off', async () => {
    const projects = await call('GET', '/v1/projects')
    expect(projects.body).toMatchObject({ source: 'local', projects: [] })
  })
})

describe('lifecycle API (no tmux started)', () => {
  it('validates session requests before touching tmux', async () => {
    expect(await call('GET', '/v1/sessions')).toMatchObject({ status: 200, body: { items: [] } })
    const size = { cols: 80, rows: 24 }
    expect(
      (await call('POST', '/v1/sessions', { origin: 'cli', size, tool: 'nope' })).body,
    ).toEqual({ error: 'unknown_tool' })
    expect((await call('POST', '/v1/sessions', { origin: 'root', size })).status).toBe(400)
    expect((await call('POST', '/v1/sessions', { origin: 'cli' })).status).toBe(400)
    expect(
      (await call('POST', '/v1/sessions', { origin: 'cli', size, projectId: 'missing' })).body,
    ).toEqual({ error: 'unknown_project' })
    expect(
      (await call('POST', '/v1/sessions', { origin: 'cli', size, aTermSessionId: 'x' })).status,
    ).toBe(400)
    expect((await call('POST', '/v1/sessions', { origin: 'cli', size, extra: 1 })).status).toBe(400)
    expect((await call('GET', '/v1/sessions/ffffffff')).status).toBe(404)
    expect((await call('POST', '/v1/sessions/ffffffff/end', { generation: 'x' })).body).toEqual({
      error: 'invalid_generation',
    })
    expect(
      (await call('POST', '/v1/sessions/ffffffff/end', { generation: 'a'.repeat(64) })).status,
    ).toBe(404)
  })

  it('serves roots, widgets, the GUI channel and A-Term legacy sessions', async () => {
    expect((await call('GET', '/v1/roots')).body).toMatchObject({ owner: 'aico', roots: [] })
    expect((await call('GET', '/v1/roots/r1')).status).toBe(404)
    expect((await call('POST', '/v1/roots/r1/show', {})).status).toBe(404)
    expect((await call('GET', '/v1/widgets/ffffffff')).status).toBe(404)
    expect((await call('POST', '/v1/roots', { requestId: 'r1' })).body).toEqual({
      error: 'invalid_body',
    })
    expect((await call('GET', '/v1/gui/channel')).body).toEqual({ error: 'invalid_client' })
    expect((await call('POST', '/v1/gui/results/x', { applied: true })).status).toBe(404)
    expect(await call('GET', '/v1/legacy-sessions')).toMatchObject({
      status: 200,
      body: { items: [] },
    })
    expect((await call('POST', '/v1/legacy-sessions/summitflow-x/end', {})).status).toBe(404)
  })
})

describe('agent tools API', () => {
  it('lists, creates from an A-Term command string, patches and deletes', async () => {
    const list = await call('GET', '/v1/tools')
    expect(list.body).toMatchObject({ defaultSlug: 'codex' })
    expect((list.body as { items: unknown[] }).items.length).toBe(5)

    expect((await call('GET', '/v1/tools/claude')).body).toMatchObject({ slug: 'claude-code' })

    const created = await call('POST', '/v1/tools', {
      slug: 'aider',
      name: 'Aider',
      command: 'aider --yes',
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ argv: ['aider', '--yes'], processName: 'aider' })

    expect(
      (await call('POST', '/v1/tools', { slug: 'x', name: 'X', command: 'a; b' })).body,
    ).toEqual({
      error: 'invalid_command',
    })
    expect((await call('PATCH', '/v1/tools/aider', { slug: 'y' })).body).toEqual({
      error: 'slug_immutable',
    })
    expect((await call('PATCH', '/v1/tools/aider', { bogus: 1 })).status).toBe(400)

    const patched = await call('PATCH', '/v1/tools/aider', { isDefault: true })
    expect(patched.body).toMatchObject({ isDefault: true })
    expect((await call('DELETE', '/v1/tools/aider')).body).toEqual({ error: 'default_tool' })
    await call('PATCH', '/v1/tools/codex', { isDefault: true })
    expect((await call('DELETE', '/v1/tools/aider')).body).toEqual({ deleted: true })
    expect((await call('GET', '/v1/tools/aider')).status).toBe(404)
  })

  it('requires a JSON content type', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          socketPath: paths.socket,
          method: 'POST',
          path: '/v1/tools',
          headers: { 'content-type': 'text/plain' },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(415)
  })
})

describe('event stream', () => {
  it('streams NDJSON events, replays since a sequence and reports gaps', async () => {
    const lines: TetherEvent[] = []
    const req = request({ socketPath: paths.socket, method: 'GET', path: '/v1/events?since=0' })
    const ready = new Promise<void>((resolve) => {
      req.on('response', (res) => {
        expect(res.headers['content-type']).toMatch(/application\/x-ndjson/)
        let buffer = ''
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8')
          let index = buffer.indexOf('\n')
          while (index >= 0) {
            lines.push(JSON.parse(buffer.slice(0, index)))
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf('\n')
          }
          if (lines.length === 1) resolve()
        })
      })
    })
    req.end()
    await ready
    await call('PATCH', '/v1/tools/pi', { enabled: false })
    await new Promise((resolve) => setTimeout(resolve, 50))
    req.destroy()
    expect(lines[0]).toMatchObject({ type: 'hello', data: { apiVersion: 1, instance: 'test' } })
    expect(lines[1]).toMatchObject({ type: 'tools.changed', seq: 1, data: { slug: 'pi' } })

    const gap = await new Promise<string>((resolve) => {
      const r = request(
        { socketPath: paths.socket, method: 'GET', path: '/v1/events?since=0&bootId=other' },
        (res) => {
          let text = ''
          res.on('data', (chunk: Buffer) => {
            text += chunk.toString('utf8')
            if (text.split('\n').length > 2) {
              resolve(text)
              r.destroy()
            }
          })
        },
      )
      r.end()
    })
    const [hello, gapEvent] = gap
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(hello.type).toBe('hello')
    expect(gapEvent).toMatchObject({ type: 'gap', data: { since: 0 } })
  })
})
