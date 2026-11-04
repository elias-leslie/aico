import { describe, expect, it } from 'vitest'
import { openTasksDb } from './db'
import { callerFromEnv } from './identity'
import { Registry } from './projects'
import { type Caller, TaskError, TaskStore } from './tasks'

function setup() {
  let now = Date.parse('2026-11-04T10:00:00Z')
  const db = openTasksDb(':memory:')
  const tick = () => now
  const registry = new Registry(db, tick)
  registry.register({ id: 'aico', root: '/srv/aico', name: 'Aico' })
  const store = new TaskStore(db, tick)
  return { db, store, registry, advance: (ms: number) => (now += ms) }
}

const ann: Caller = { owner: 'ann', session: { id: 'claude-code:aaa', tether: 'aico-widget-1' } }
const bob: Caller = { owner: 'bob' }

const planned = (store: TaskStore) =>
  store.create({
    project_id: 'aico',
    title: 'Do it',
    subtasks: [{ description: 'first' }, { description: 'second' }],
  })

describe('task states', () => {
  it('starts pending, runs when claimed, completes when done', () => {
    const { store } = setup()
    const task = store.create({ project_id: 'aico', title: 'Plain' })
    expect(task.status).toBe('pending')
    store.claim(task.id, ann)
    expect(store.require(task.id).status).toBe('running')
    store.done(task.id, ann, { summary: 'shipped' })
    const finished = store.require(task.id)
    expect([finished.status, finished.summary, finished.outcome]).toEqual([
      'completed',
      'shipped',
      'completed',
    ])
    expect(store.openClaim(task.id)).toBeNull()
  })

  it('a failed outcome can be claimed again; a completed or abandoned task cannot', () => {
    const { store } = setup()
    const task = store.create({ project_id: 'aico', title: 'Flaky' })
    store.claim(task.id, ann)
    store.done(task.id, ann, { outcome: 'failed', summary: 'broke' })
    expect(store.require(task.id).status).toBe('failed')
    store.claim(task.id, bob)
    store.done(task.id, bob)
    expect(() => store.claim(task.id, ann)).toThrow(/completed/)
    const other = store.create({ project_id: 'aico', title: 'Dropped' })
    store.abandon(other.id, { reason: 'moot' })
    expect(store.require(other.id).status).toBe('abandoned')
    expect(() => store.claim(other.id, ann)).toThrow(/abandoned/)
  })

  it('done on a finished task changes nothing; a task with open subtasks cannot complete', () => {
    const { store } = setup()
    const task = planned(store)
    store.claim(task.id, ann)
    expect(() => store.done(task.id, ann)).toThrow(/1\.1, 1\.2/)
    store.done(task.id, ann, { ref: '1.1' })
    store.done(task.id, ann, { ref: '1.2' })
    expect(store.done(task.id, ann)).toBe(true)
    expect(store.done(task.id, ann)).toBe(false)
  })

  it('refuses a task in a retired or unknown project', () => {
    const { store, registry } = setup()
    registry.retire('aico', 'gone')
    expect(() => store.create({ project_id: 'aico', title: 'x' })).toThrow(/retired/)
    expect(() => store.create({ project_id: 'nope', title: 'x' })).toThrow(/no project/)
  })

  it('a task blocked by an open task cannot be claimed', () => {
    const { store } = setup()
    const first = store.create({ project_id: 'aico', title: 'First' })
    const second = store.create({ project_id: 'aico', title: 'Second', blocked_by: first.id })
    expect(() => store.claim(second.id, ann)).toThrow(/blocked by/)
    store.claim(first.id, ann)
    store.done(first.id, ann)
    expect(store.claim(second.id, ann)).toBe('claimed')
  })

  it('abandoning needs the token of the current state', () => {
    const { store, advance } = setup()
    const task = store.create({ project_id: 'aico', title: 'T' })
    const token = store.abandonToken(task.id)
    advance(1000)
    store.appendLog(task.id, 'moved') // changes updated_at
    expect(store.abandonToken(task.id)).not.toBe(token)
  })
})

describe('claims', () => {
  it('refuses a second claimer, resumes the same one, and --force takes over', () => {
    const { store, advance } = setup()
    const task = store.create({ project_id: 'aico', title: 'T' })
    expect(store.claim(task.id, ann)).toBe('claimed')
    expect(store.claim(task.id, ann)).toBe('resumed')
    expect(() => store.claim(task.id, bob)).toThrow(/claimed by ann/)
    advance(60_000)
    expect(store.claim(task.id, bob, { force: true })).toBe('claimed')
    expect(store.openClaim(task.id)?.owner).toBe('bob')
    const history = store.claims(task.id)
    expect(history.map((c) => [c.owner, c.released_at !== null, c.release_reason])).toEqual([
      ['ann', true, 'taken over by bob'],
      ['bob', false, null],
    ])
  })

  it('release keeps the claim as history, and only the owner may release', () => {
    const { store } = setup()
    const task = store.create({ project_id: 'aico', title: 'T' })
    store.claim(task.id, ann)
    expect(() => store.release(task.id, bob)).toThrow(/claimed by ann/)
    store.release(task.id, ann)
    expect(store.require(task.id).status).toBe('pending')
    expect(store.openClaim(task.id)).toBeNull()
    expect(store.claims(task.id)).toHaveLength(1)
    store.claim(task.id, bob)
    store.release(task.id, bob, { pause: true })
    expect(store.require(task.id).status).toBe('paused')
    expect(store.claim(task.id, ann)).toBe('claimed')
  })

  it('subtask claims: one owner each, the parent claimed first, release resets it', () => {
    const { store } = setup()
    const task = planned(store)
    expect(store.claim(task.id, ann, { ref: '1.1' })).toBe('claimed')
    expect(store.openClaim(task.id)?.owner).toBe('ann')
    expect(store.subtasks(task.id)[0]?.status).toBe('running')
    expect(() => store.claim(task.id, bob, { ref: '1.1' })).toThrow(/claimed by ann/)
    expect(() => store.claim(task.id, bob, { ref: '1.2' })).toThrow(/claimed by ann/)
    expect(store.claim(task.id, ann, { ref: '1.2' })).toBe('claimed')
    store.release(task.id, ann, { ref: '1.2' })
    expect(store.subtasks(task.id)[1]?.status).toBe('pending')
    store.done(task.id, ann, { ref: '1.1', summary: 'ok' })
    expect(store.subtasks(task.id)[0]).toMatchObject({ status: 'completed', summary: 'ok' })
    expect(() => store.claim(task.id, ann, { ref: '9.9' })).toThrow(/not found/)
  })

  it('done is refused for another owner unless forced; abandon resets a subtask', () => {
    const { store } = setup()
    const task = planned(store)
    store.claim(task.id, ann, { ref: '1.1' })
    expect(() => store.done(task.id, bob, { ref: '1.1' })).toThrow(/claimed by ann/)
    store.abandon(task.id, { ref: '1.1' })
    expect(store.subtasks(task.id)[0]?.status).toBe('pending')
    expect(store.openClaim(task.id, '1.1')).toBeNull()
  })

  it('only one open claim per task exists in the file itself', () => {
    const { store, db } = setup()
    const task = store.create({ project_id: 'aico', title: 'T' })
    store.claim(task.id, ann)
    expect(() =>
      db
        .prepare(
          "INSERT INTO claims (task_id, subtask, owner, claimed_at) VALUES (?, '', 'bob', 1)",
        )
        .run(task.id),
    ).toThrow()
  })
})

describe('session links', () => {
  it('a claim from a session links it; more sessions and more tasks link too', () => {
    const { store } = setup()
    const one = store.create({ project_id: 'aico', title: 'One' })
    const two = store.create({ project_id: 'aico', title: 'Two' })
    store.claim(one.id, ann)
    store.claim(one.id, ann) // again: no second link
    store.release(one.id, ann)
    store.claim(one.id, { owner: 'cy', session: { id: 'codex:ccc' } })
    store.claim(two.id, ann)
    expect(store.sessions(one.id).map((s) => [s.session_id, s.tether_session])).toEqual([
      ['claude-code:aaa', 'aico-widget-1'],
      ['codex:ccc', null],
    ])
    expect(store.tasksOfSession('claude-code:aaa')).toEqual([one.id, two.id])
  })

  it('a claim outside any session links nothing', () => {
    const { store } = setup()
    const task = store.create({ project_id: 'aico', title: 'T' })
    store.claim(task.id, bob)
    expect(store.sessions(task.id)).toEqual([])
  })

  it('reads the session from the Tether environment', () => {
    expect(
      callerFromEnv({
        AICO_SESSION_ID: 'aico-widget-9',
        AICO_AGENT_SLUG: 'claude-code',
        CLAUDE_CODE_SESSION_ID: 'uuid-1',
      }),
    ).toEqual({
      owner: 'aico-widget-9',
      session: { id: 'claude-code:uuid-1', tether: 'aico-widget-9' },
    })
    expect(callerFromEnv({ AICO_SESSION_ID: 'aico-widget-9' }).session).toEqual({
      id: 'aico-widget-9',
      tether: 'aico-widget-9',
    })
    expect(callerFromEnv({ AICO_CLAIM_OWNER: 'me', USER: 'x' }).session).toBeUndefined()
  })
})

describe('registry', () => {
  it('registers, finds the deepest root for a folder, and retires with history', () => {
    const { registry } = setup()
    registry.register({ id: 'inner', root: '/srv/aico/inner' })
    expect(registry.forCwd('/srv/aico/inner/src')?.id).toBe('inner')
    expect(registry.forCwd('/srv/aico/other')?.id).toBe('aico')
    expect(registry.forCwd('/srv/aico-x')).toBeNull()
    registry.retire('inner', 'merged')
    expect(registry.forCwd('/srv/aico/inner/src')?.id).toBe('aico')
    expect(registry.list().map((p) => p.id)).toEqual(['aico'])
    expect(registry.list({ all: true })).toHaveLength(2)
    expect(registry.events('inner').map((e) => e.action)).toEqual(['registered', 'retired'])
    expect(() => registry.retire('inner', 'again')).toThrow(/already retired/)
    expect(() => registry.register({ id: 'inner', root: '/x/y' })).toThrow(/retired/)
    expect(() => registry.register({ id: 'aico', root: '/x/y' })).toThrow(/already registered/)
  })
})

describe('errors', () => {
  it('names the missing task', () => {
    const { store } = setup()
    expect(() => store.claim('task-nope', ann)).toThrow(TaskError)
  })
})
