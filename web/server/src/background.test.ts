import { followEvents, TetherUnavailable } from 'tether/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Asks } from './asks'
import { Background, reconcileLinks } from './background'
import { WebStore } from './db'
import { Shows } from './shows'
import { FakeTether } from './testing'

vi.mock('tether/client', async (original) => ({
  ...(await original<typeof import('tether/client')>()),
  followEvents: vi.fn(() => () => {}),
}))

let tether: FakeTether
let store: WebStore
let shows: Shows
let pushes: string[][]
let paneId: string

const DAY_MS = 24 * 60 * 60 * 1000
const event = (type: string, data: Record<string, unknown> = {}) => ({
  seq: 1,
  bootId: 'boot',
  type,
  at: 0,
  data,
})

function background(trustShows = true, forward?: (event: unknown) => void) {
  return new Background({
    forward,
    tether: tether.client,
    store,
    shows,
    asks: new Asks({
      tether: tether.client,
      publicHost: null,
      run: async (argv, _t, input) => {
        pushes.push(input === undefined ? argv : [...argv, input])
        return ''
      },
    }),
    trustShows,
    uploads: { dir: '/nonexistent/uploads', remoteDir: '~/uploads', maxBytes: 1, maxAgeMs: 1 },
    maintenance: { enabled: false, intervalMs: 1000, emptyPaneDays: 7 },
  })
}

function linked(tool = 'codex') {
  const session = tether.add({ tool, projectId: 'aico' })
  store.link(session.id, paneId, tool)
  return session
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  tether = new FakeTether()
  store = new WebStore(':memory:')
  pushes = []
  shows = new Shows({
    tether: tether.client,
    publicHost: null,
    run: async (argv) => {
      pushes.push(argv)
    },
  })
  paneId = store.createPane({ projectId: 'aico', name: 'Aico', activeMode: 'codex' }).id
})

afterEach(() => {
  store.close()
  vi.restoreAllMocks()
})

describe('events', () => {
  it("follows Tether's one stream: forwards each event, applies it, reconciles on resync", async () => {
    const dead = linked()
    tether.sessions.delete(dead.id)
    const forwarded: unknown[] = []
    const work = background(true, (item) => forwarded.push(item))
    work.start()
    const handlers = vi.mocked(followEvents).mock.calls[0][1]
    const ended = event('session.ended', { id: 'other' })
    handlers.onEvent(ended)
    expect(forwarded).toEqual([ended])
    handlers.onResync()
    await vi.waitFor(() => expect(store.getLink(dead.id)).toBeNull())
    work.stop()
  })

  it('drops the link of an ended session and ignores unknown events', async () => {
    const kept = linked()
    const ended = linked('shell')
    const work = background()
    await work.event(event('session.ended', { id: ended.id }))
    await work.event(event('session.renamed', { id: kept.id }))
    await work.event(event('session.ended', { id: 'never-linked' }))
    expect(store.listLinks().map((link) => link.session_id)).toEqual([kept.id])
  })

  it('reconciles on a gap', async () => {
    const alive = linked()
    const gone = linked('shell')
    tether.sessions.delete(gone.id)
    await background().event(event('gap'))
    expect(store.listLinks().map((link) => link.session_id)).toEqual([alive.id])
  })

  it("keeps a link's mode on the snapshot's tool without reading the session", async () => {
    const session = linked('shell')
    const read = vi.spyOn(tether, 'getSession')
    await background().event(
      event('session.updated', { id: session.id, session: { ...session, tool: 'claude' } }),
    )
    expect(store.getLink(session.id)?.mode).toBe('claude')
    expect(read).not.toHaveBeenCalled()
    await background().event(
      event('session.updated', { id: session.id, session: { ...session, status: 'ended' } }),
    )
    expect(store.getLink(session.id)).toBeNull()
  })

  it('reads the session when the event has no snapshot, and drops a link to a gone one', async () => {
    const session = linked('shell')
    session.tool = 'codex'
    await background().event(event('session.created', { id: session.id }))
    expect(store.getLink(session.id)?.mode).toBe('codex')
    tether.sessions.delete(session.id)
    await background().event(event('session.updated', { id: session.id }))
    expect(store.getLink(session.id)).toBeNull()
  })

  it('reads nothing for sessions no tab shows', async () => {
    const read = vi.spyOn(tether, 'getSession')
    await background().event(event('session.updated', { id: tether.add().id }))
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps a link when Tether cannot be asked', async () => {
    const session = linked()
    vi.spyOn(tether, 'getSession').mockRejectedValue(new TetherUnavailable('down'))
    await background().event(event('session.updated', { id: session.id }))
    expect(store.getLink(session.id)).not.toBeNull()
  })

  it("takes agent shares only from the owner's default Tether", async () => {
    const share = {
      id: 'ab12cd34ef56',
      session: 'ab12cd34',
      kind: 'files',
      title: null,
      createdAt: '2026-10-27T10:00:00.000Z',
      paths: ['/srv/a.txt'],
    }
    await background(false).event(event('show.requested', share))
    expect(pushes).toEqual([])
    await background(true).event(event('show.requested', share))
    expect(pushes).toHaveLength(1)
  })

  it("pushes a new blocking ask only from the owner's default Tether", async () => {
    const ask = {
      id: 'ab12cd34ef56',
      session: null,
      requester: 'nightly',
      question: 'Run the cleanup?',
      options: [],
      recommended: null,
      body: null,
      command: null,
      share: null,
      blocking: true,
      state: 'open',
      answer: null,
      note: null,
      delivery: null,
      createdAt: 1,
      updatedAt: 1,
      answeredAt: null,
    }
    await background(false).event(event('asks.changed', { ask, created: true }))
    expect(pushes).toEqual([])
    await background(true).event(event('asks.changed', { ask, created: true }))
    expect(pushes).toHaveLength(1)
    expect(JSON.parse(pushes[0]?.at(-1) ?? '{}').body).toBe(
      '“nightly” has a question for you. Open Aico to answer it.',
    )
  })
})

describe('reconcileLinks', () => {
  it('drops dead links, keeps live ones, prunes tabs empty past the cutoff', async () => {
    const alive = linked()
    const dead = linked('shell')
    tether.sessions.delete(dead.id)
    const emptyTab = store.createPane({ projectId: null, name: 'Empty', activeMode: 'shell' }).id
    const now = Date.now()
    expect(await reconcileLinks(tether.client, store, 7, now)).toEqual({
      links: 2,
      links_dropped: 1,
      panes_pruned: 0,
    })
    expect(await reconcileLinks(tether.client, store, 7, now + 8 * DAY_MS)).toEqual({
      links: 1,
      links_dropped: 0,
      panes_pruned: 1,
    })
    expect(store.getPane(emptyTab)).toBeNull()
    expect(store.getPane(paneId)).not.toBeNull()
    expect(store.getLink(alive.id)).not.toBeNull()
  })

  it('never treats an outage as every session ended', async () => {
    linked()
    vi.spyOn(tether, 'listSessions').mockRejectedValue(new TetherUnavailable('down'))
    await expect(reconcileLinks(tether.client, store, 7)).rejects.toThrow(TetherUnavailable)
    expect(store.listLinks()).toHaveLength(1)
  })
})

describe('maintenance', () => {
  it('reconciles links and prunes settings of projects Tether no longer lists', async () => {
    tether.projectList = [{ id: 'keep', name: 'Keep', root: '/tmp' }]
    store.upsertProjectSettings('keep', { enabled: true })
    store.upsertProjectSettings('gone', { enabled: true })
    const dead = linked()
    tether.sessions.delete(dead.id)
    const result = await background().runMaintenance('manual')
    expect(result).toMatchObject({
      skipped: false,
      reconciliation: { links_dropped: 1 },
      project_count: 1,
      orphaned_project_settings_deleted: 1,
      upload_cleanup: { scanned_files: 0, errors: 0 },
    })
    expect([...store.allProjectSettings().keys()]).toEqual(['keep'])
  })

  it('never prunes settings when Tether lists no projects or is down', async () => {
    store.upsertProjectSettings('a', { enabled: true })
    tether.projectList = []
    expect(await background().runMaintenance('manual')).toMatchObject({
      project_settings_cleanup_skipped: true,
    })
    vi.spyOn(tether, 'projects').mockRejectedValue(new TetherUnavailable('down'))
    vi.spyOn(tether, 'listSessions').mockRejectedValue(new TetherUnavailable('down'))
    expect(await background().runMaintenance('manual')).toMatchObject({
      reconciliation: { skipped: 'tether_unavailable' },
      project_settings_cleanup_skipped: true,
    })
    expect(store.allProjectSettings().has('a')).toBe(true)
  })

  it('skips a pass while one is running', async () => {
    const work = background()
    const first = work.runMaintenance('startup')
    expect(await work.runMaintenance('interval')).toEqual({ reason: 'interval', skipped: true })
    expect((await first).skipped).toBe(false)
    expect((await work.runMaintenance('interval')).skipped).toBe(false)
  })
})
