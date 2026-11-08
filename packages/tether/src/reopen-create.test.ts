// `resumeId` on POST /v1/sessions: reopen an ended conversation, validated before anything starts.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { insertWidget } from '@aico/session-engine/catalog'
import { resolvePaths, type TetherPaths } from '@aico/session-engine/paths'
import { holdResume, launchingResume, withRootPrompt } from '@aico/session-engine/root-launch'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callSocket } from './client'
import { type RunningDaemon, startDaemon } from './daemon'
import { conversationHolder } from './lifecycle-api'

// A valid create stops at linger_required: nothing is allocated, no tmux.
vi.mock('@aico/session-engine/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aico/session-engine/engine')>()),
  lingerEnabled: () => false,
}))
let dir: string
let paths: TetherPaths
let daemon: RunningDaemon

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-reopen-'))
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
const conversation = '0b9a8f7e-1234-4cde-8abc-0123456789ab'
const create = (extra: Record<string, unknown>) =>
  callSocket(paths.socket, 'POST', '/v1/sessions', { origin: 'cli', size, ...extra })

describe('POST /v1/sessions resumeId', () => {
  it('needs the tool, its own id form, a folder and this computer', async () => {
    const root = join(dir, 'proj')
    expect(await create({ resumeId: conversation, projectRoot: root })).toMatchObject({
      status: 400,
      body: { error: 'invalid_body', field: 'tool' },
    })
    expect(
      await create({ tool: 'claude-code', resumeId: 'nope', projectRoot: root }),
    ).toMatchObject({ status: 400, body: { error: 'invalid_body', field: 'resumeId' } })
    expect(await create({ tool: 'claude-code', resumeId: conversation })).toMatchObject({
      status: 400,
      body: { error: 'reopen_needs_project' },
    })
    expect(
      await create({
        tool: 'claude-code',
        resumeId: conversation,
        continueFrom: '0a1b2c3d',
        projectRoot: root,
      }),
    ).toMatchObject({ status: 400 })
    expect(
      await create({ tool: 'claude-code', resumeId: conversation, host: 'elsewhere' }),
    ).toMatchObject({ status: 400, body: { error: 'reopen_on_this_host_only' } })
  })

  it('refuses when it cannot see which sessions run what (no continuity here)', async () => {
    expect(
      await create({ tool: 'claude-code', resumeId: conversation, projectRoot: join(dir, 'proj') }),
    ).toMatchObject({ status: 503, body: { error: 'reopen_unavailable' } })
  })
})

describe('conversationHolder', () => {
  const free = '0b9a8f7e-1234-4cde-8abc-0123456789ac'
  const context = (over: {
    observed?: { row: { id: string }; resumeId: string | null }[]
    restoring?: string | null
    owner?: string | null
    fails?: boolean
  }) =>
    ({
      continuity: {
        restorePlanned: Promise.resolve(),
        observe: async () => {
          if (over.fails) throw new Error('tmux')
          return over.observed ?? []
        },
        isAwaitingRestore: (id: string) => id === over.restoring,
        resumeIdOf: (id: string) => (id === over.restoring ? free : null),
      },
      recovery: { resumeOwner: () => over.owner ?? null },
    }) as unknown as Parameters<typeof conversationHolder>[0]

  it('names a running, restoring or recovering holder, and refuses when it cannot look', async () => {
    expect(
      await conversationHolder(
        context({ observed: [{ row: { id: 'run00001' }, resumeId: free }] }),
        free,
      ),
    ).toBe('run00001')
    insertWidget('abcd0003', 'claude-code', 1_000, { origin: 'cli' })
    expect(await conversationHolder(context({ restoring: 'abcd0003' }), free)).toBe('abcd0003')
    expect(await conversationHolder(context({ owner: 'rec00001' }), free)).toBe('rec00001')
    expect(await conversationHolder(context({}), free)).toBeNull()
    await expect(conversationHolder(context({ fails: true }), free)).rejects.toMatchObject({
      status: 503,
    })
  })

  it('names a session launching on the conversation now', async () => {
    insertWidget('abcd0001', 'claude-code', 1_000, { origin: 'cli' })
    let release = () => {}
    const holding = withRootPrompt(
      'abcd0001',
      'x',
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
      free,
    )
    expect(await conversationHolder(context({}), free)).toBe('abcd0001')
    release()
    await holding
  })

  it('keeps a reopened conversation claimed after its launch until the hold ends', async () => {
    insertWidget('abcd0002', 'claude-code', 1_000, { origin: 'cli' })
    holdResume('abcd0002', free, 60_000)
    expect(await conversationHolder(context({}), free)).toBe('abcd0002')
    expect(launchingResume(free, 'abcd0002')).toBeNull()
    expect(launchingResume(free, '', Date.now() + 61_000)).toBeNull()
    expect(await conversationHolder(context({}), free)).toBeNull()
  })
})
