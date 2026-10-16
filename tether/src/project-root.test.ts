// `projectRoot` on POST /v1/sessions and switch-project follows the same path
// rule as POST /v1/roots (absolute, normalized, no NUL), then must exist.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callSocket } from './client'
import { resolvePaths, type TetherPaths } from './config'
import { type RunningDaemon, startDaemon } from './daemon'
import { insertWidget } from './lifecycle/catalog'

// A valid create stops at linger_required: nothing is allocated, no tmux.
vi.mock('./lifecycle/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lifecycle/engine')>()),
  lingerEnabled: () => false,
}))

const TEST_ENV = {
  TETHER_SUMMITFLOW_URL: 'off',
  TETHER_RECONCILE: 'off',
  TETHER_ATERM_LEGACY_SOCKET: '/nonexistent/tether-test/default',
  HOME: '/nonexistent',
}

let dir: string
let paths: TetherPaths
let daemon: RunningDaemon
let project: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-root-'))
  project = join(dir, 'proj')
  mkdirSync(project)
  mkdirSync(join(dir, 'other'))
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

const invalid = { error: 'invalid_body', field: 'projectRoot' }

// Each refused spelling names an existing directory, so only the path rule
// can refuse it.
const refused = (): [string, string][] => [
  ['a .. segment', join(dir, 'other') + '/../proj'],
  ['a . segment', `${dir}/./proj`],
  ['a double slash', `${dir}//proj`],
  ['a NUL byte', `${project}\0`],
  ['a relative path', 'proj'],
]

describe('POST /v1/sessions projectRoot', () => {
  const create = (projectRoot: string) =>
    call('POST', '/v1/sessions', { origin: 'cli', size: { cols: 80, rows: 24 }, projectRoot })

  it('refuses paths the /v1/roots rule refuses', async () => {
    for (const [label, path] of refused()) {
      const response = await create(path)
      expect({ label, status: response.status, body: response.body }).toEqual({
        label,
        status: 400,
        body: invalid,
      })
    }
  })

  it('refuses a missing directory and accepts an existing normalized one', async () => {
    expect(await create(join(dir, 'absent'))).toMatchObject({
      status: 400,
      body: { error: 'unknown_project' },
    })
    expect(await create(project)).toMatchObject({
      status: 503,
      body: { error: 'linger_required' },
    })
    expect((await call('GET', '/v1/sessions')).body).toEqual({ items: [] })
  })
})

describe('POST /v1/sessions/:id/switch-project projectRoot', () => {
  const generation = 'a'.repeat(64)
  const switchTo = (projectRoot: string) =>
    call('POST', '/v1/sessions/ffffffff/switch-project', { generation, projectRoot })

  it('refuses paths the /v1/roots rule refuses', async () => {
    for (const [label, path] of refused()) {
      const response = await switchTo(path)
      expect({ label, status: response.status, body: response.body }).toEqual({
        label,
        status: 400,
        body: invalid,
      })
    }
  })

  it('checks existence only after the session lookup', async () => {
    // A well-formed root, present or not, reaches the session lookup, so an
    // unknown session stays 404 as before.
    for (const path of [project, join(dir, 'absent')])
      expect(await switchTo(path)).toMatchObject({ status: 404, body: { error: 'not_found' } })
  })

  it('refuses a missing directory on a real session after the generation check', async () => {
    insertWidget('0a1b2c3d', 'codex', 1_000, { origin: 'cli' })
    const listed = (await call('GET', '/v1/sessions')).body as { items: { generation: string }[] }
    const current = listed.items[0]?.generation
    const absent = join(dir, 'absent')
    const send = (body: Record<string, unknown>) =>
      call('POST', '/v1/sessions/0a1b2c3d/switch-project', body)
    expect((await send({ generation, projectRoot: absent })).status).toBe(409)
    expect(await send({ generation: current, projectRoot: absent })).toMatchObject({
      status: 400,
      body: { error: 'unknown_project' },
    })
    expect(await send({ generation: current, projectRoot: `${project}/..` })).toMatchObject({
      status: 400,
      body: invalid,
    })
  })
})
