import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TetherError } from 'tether/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebStore } from './db'
import { createLifecycle } from './lifecycle'
import { registerPaneFileRoutes } from './pane-files'
import { FakeTether, serveRoutes } from './testing'

let tether: FakeTether
let store: WebStore
let base: string
let close: () => Promise<void>
let shellDir: string
let agentDir: string

/** A project tab with a shell and a codex session, each in its own folder (or none). */
function pane(shellRoot: string | null, agentRoot: string | null) {
  const created = store.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'codex' })
  const shell = tether.add({ tool: 'shell', projectId: 'aico', projectRoot: shellRoot })
  const agent = tether.add({ tool: 'codex', projectId: 'aico', projectRoot: agentRoot })
  store.link(shell.id, created.id, 'shell')
  store.link(agent.id, created.id, 'codex')
  return created.id
}

async function get(path: string) {
  const response = await fetch(`${base}${path}`)
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  tether = new FakeTether()
  store = new WebStore(':memory:')
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'aico-pane-files-')))
  shellDir = join(top, 'shell')
  agentDir = join(top, 'agent')
  mkdirSync(shellDir)
  mkdirSync(agentDir)
  writeFileSync(join(shellDir, 'README.md'), 'hello')
  writeFileSync(join(agentDir, 'other.txt'), 'x')
  const life = createLifecycle({ tether: tether.client, store })
  ;({ base, close } = await serveRoutes((router) =>
    registerPaneFileRoutes(router, life, tether.client),
  ))
})

afterEach(async () => {
  await close()
  store.close()
  chmodSync(shellDir, 0o755)
  rmSync(join(shellDir, '..'), { recursive: true, force: true })
})

describe('pane file routes', () => {
  it("browses the shell's working directory, never naming the root", async () => {
    const id = pane(shellDir, agentDir)
    const tree = await get(`/api/panes/${id}/files/tree`)
    expect(tree).toEqual({
      status: 200,
      body: {
        entries: [
          { name: 'README.md', path: 'README.md', is_directory: false, size: 5, extension: '.md' },
        ],
        path: '',
        total: 1,
      },
    })
    const content = await get(`/api/panes/${id}/files/content?path=README.md`)
    expect(content.status).toBe(200)
    expect(content.body).toMatchObject({
      path: 'README.md',
      content: 'hello',
      language: 'markdown',
    })
    expect(content.body).not.toHaveProperty('absolute_path')
  })

  it("falls back to the active session's working directory", async () => {
    const id = pane(null, agentDir)
    const tree = await get(`/api/panes/${id}/files/tree`)
    const { entries } = tree.body as { entries: { name: string }[] }
    expect(entries.map((entry) => entry.name)).toEqual(['other.txt'])
  })

  it('answers missing, bad and refused requests as the Python backend did', async () => {
    expect(await get('/api/panes/not-a-uuid/files/tree')).toEqual({
      status: 400,
      body: { detail: 'Invalid UUID' },
    })
    expect((await get(`/api/panes/${crypto.randomUUID()}/files/tree`)).status).toBe(404)
    expect(await get(`/api/panes/${pane(null, null)}/files/tree`)).toEqual({
      status: 400,
      body: { detail: 'Pane has no working directory' },
    })
    expect(await get(`/api/panes/${pane(join(shellDir, 'gone'), null)}/files/tree`)).toEqual({
      status: 404,
      body: { detail: 'Pane working directory does not exist' },
    })
    const id = pane(shellDir, agentDir)
    expect(await get(`/api/panes/${id}/files/tree?path=.git`)).toEqual({
      status: 403,
      body: { detail: 'Access denied: .git' },
    })
    expect((await get(`/api/panes/${id}/files/content`)).status).toBe(422)
    expect((await get(`/api/panes/${id}/files/content?path=missing.txt`)).status).toBe(404)
  })

  it("reads a tab on another host there, through Tether's hub, never this computer's copy", async () => {
    const created = store.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'shell' })
    const shell = tether.add({
      host: 'agent-work',
      tool: 'shell',
      projectId: 'aico',
      projectRoot: shellDir,
    })
    store.link(shell.id, created.id, 'shell')
    const remote = `/v1/sessions/${shell.id}/files`
    const listing = {
      entries: [{ name: 'far.txt', path: 'far.txt', is_directory: false }],
      path: '',
      total: 1,
    }
    tether.hostAnswers.set(`GET ${remote}/tree`, {
      status: 200,
      body: { ...listing, host: 'agent-work' },
    })
    expect(await get(`/api/panes/${created.id}/files/tree`)).toEqual({ status: 200, body: listing })
    tether.hostAnswers.set(`GET ${remote}/content?path=far.txt`, {
      status: 200,
      body: { path: 'far.txt', content: 'far away', host: 'agent-work' },
    })
    expect(await get(`/api/panes/${created.id}/files/content?path=far.txt`)).toEqual({
      status: 200,
      body: { path: 'far.txt', content: 'far away' },
    })
    // The host's own refusal keeps its words and status.
    tether.hostAnswers.set(
      `GET ${remote}/content?path=.env`,
      new TetherError(403, 'access_denied', {
        error: 'access_denied',
        detail: 'Access denied: .env',
      }),
    )
    expect(await get(`/api/panes/${created.id}/files/content?path=.env`)).toEqual({
      status: 403,
      body: { detail: 'Access denied: .env' },
    })
    // Off: say so, and leave Try again open.
    tether.hostAnswers.set(
      `GET ${remote}/tree?path=src`,
      new TetherError(409, 'host_unavailable', {
        error: 'host_unavailable',
        host: 'agent-work',
        state: 'powered_off',
      }),
    )
    expect(await get(`/api/panes/${created.id}/files/tree?path=src`)).toEqual({
      status: 503,
      body: { detail: 'agent-work is powered off, so its files can’t be shown.' },
    })
    // A host whose Tether has no files routes yet.
    tether.hostAnswers.set(
      `GET ${remote}/tree?path=old`,
      new TetherError(404, 'not_found', { error: 'not_found' }),
    )
    expect(await get(`/api/panes/${created.id}/files/tree?path=old`)).toEqual({
      status: 409,
      body: { detail: 'agent-work needs an update before its files can be shown here.' },
    })
  })

  it('answers an unreadable directory 403', async () => {
    const id = pane(shellDir, agentDir)
    mkdirSync(join(shellDir, 'locked'))
    chmodSync(join(shellDir, 'locked'), 0o000)
    try {
      const locked = await get(`/api/panes/${id}/files/tree?path=locked`)
      // Root reads anything; everyone else is refused.
      expect(locked.status).toBe(process.getuid?.() === 0 ? 200 : 403)
    } finally {
      chmodSync(join(shellDir, 'locked'), 0o755)
    }
  })
})
