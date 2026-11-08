// `continueFrom` on POST /v1/sessions: validated before anything starts (the recap itself: continue-from.test.ts).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertWidget, setWidgetProject } from '@aico/session-engine/catalog'
import { resolvePaths, type TetherPaths } from '@aico/session-engine/paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callSocket } from './client'
import { type RunningDaemon, startDaemon } from './daemon'

// A valid create stops at linger_required: nothing is allocated, no tmux.
vi.mock('@aico/session-engine/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aico/session-engine/engine')>()),
  lingerEnabled: () => false,
}))

let dir: string
let paths: TetherPaths
let daemon: RunningDaemon

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-continue-'))
  mkdirSync(join(dir, 'proj'))
  paths = resolvePaths({
    instance: 'test',
    env: {
      HOME: dir,
      TETHER_STATE_DIR: join(dir, 'state'),
      TETHER_RUNTIME_DIR: join(dir, 'run'),
      XDG_CONFIG_HOME: join(dir, 'config'),
    },
  })
  daemon = await startDaemon(paths, {
    AICO_TASKS_DB: '/nonexistent/aico/tasks.db',
    TETHER_RECONCILE: 'off',
    HOME: '/nonexistent',
  })
  await daemon.ready
})

afterEach(async () => {
  await daemon.close()
  rmSync(dir, { recursive: true, force: true })
})

const size = { cols: 80, rows: 24 }
const create = (extra: Record<string, unknown>) =>
  callSocket(paths.socket, 'POST', '/v1/sessions', { origin: 'cli', size, ...extra })

describe('POST /v1/sessions initialPrompt', () => {
  it('is a real message, for an agent, and not on top of a recap or a reopen', async () => {
    for (const initialPrompt of ['   ', 7, 'a\0b'])
      expect(await create({ tool: 'codex', initialPrompt })).toMatchObject({
        status: 400,
        body: { error: 'invalid_body', field: 'initialPrompt' },
      })
    expect(
      await create({ tool: 'codex', initialPrompt: 'hi', continueFrom: '0a1b2c3d' }),
    ).toMatchObject({ status: 400, body: { field: 'initialPrompt' } })
    expect(await create({ tool: 'shell', initialPrompt: 'hi' })).toMatchObject({
      status: 400,
      body: { error: 'unsupported_tool' },
    })
    expect(await create({ tool: 'codex', initialPrompt: 'x'.repeat(14 * 1024 + 1) })).toMatchObject(
      {
        status: 400,
        body: { error: 'prompt_too_long', limit: 14 * 1024 },
      },
    )
  })

  it('a valid one gets as far as the launch', async () => {
    expect(await create({ tool: 'codex', initialPrompt: 'say hi' })).toMatchObject({
      status: 503,
      body: { error: 'linger_required' },
    })
  })
})

describe('POST /v1/sessions continueFrom', () => {
  it('needs a session id, a tool and an existing session', async () => {
    expect(await create({ tool: 'codex', continueFrom: 'nope' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_body', field: 'continueFrom' },
    })
    expect(await create({ continueFrom: '0a1b2c3d' })).toMatchObject({
      status: 400,
      body: { error: 'invalid_body', field: 'tool' },
    })
    expect(await create({ tool: 'codex', continueFrom: '0a1b2c3d' })).toMatchObject({
      status: 404,
      body: { error: 'unknown_session' },
    })
  })

  it('refuses a session with no checkout, a Blank Slate and another host', async () => {
    insertWidget('0a1b2c3d', 'claude-code', 1_000, { origin: 'cli' })
    expect(await create({ tool: 'codex', continueFrom: '0a1b2c3d' })).toMatchObject({
      status: 400,
      body: { error: 'continue_needs_project' },
    })
    expect(
      await create({ tool: 'codex', continueFrom: '0a1b2c3d', blankSlate: true }),
    ).toMatchObject({
      status: 400,
      body: { error: 'invalid_body', field: 'blankSlate' },
    })
    expect(
      await create({ tool: 'codex', continueFrom: '0a1b2c3d', host: 'elsewhere' }),
    ).toMatchObject({
      status: 400,
      body: { error: 'continue_on_this_host_only' },
    })
  })

  it('takes the old session as valid when it has a checkout (the launch stops at linger_required)', async () => {
    insertWidget('0a1b2c3d', 'claude-code', 1_000, { origin: 'cli' })
    setWidgetProject('0a1b2c3d', null, join(dir, 'proj'))
    expect(await create({ tool: 'codex', continueFrom: '0a1b2c3d' })).toMatchObject({
      status: 503,
      body: { error: 'linger_required' },
    })
  })
})
