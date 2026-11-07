import { TetherError } from '@aico/tether-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebStore } from './db'
import { createLifecycle } from './lifecycle'
import { registerRecoveryRoutes } from './recovery'
import { FakeTether, serveRoutes } from './testing'

const NOW = Date.now()
const BOOT = 'boot-1'

const crash = (fields: Record<string, unknown>) => ({
  id: 'aaaaaaaa',
  name: null,
  tool: 'claude',
  origin: 'a-term',
  state: 'held',
  kind: 'pane-stopped',
  cause: 'oom-kill',
  agent_was_hog: false,
  died_at: NOW - 3_600_000,
  died_at_approx: false,
  recovered_at: null,
  attempt: 0,
  reason: null,
  resumable: true,
  detail_file: '/home/someone/.local/state/tether/default/recovery/x.md',
  ...fields,
})

let tether: FakeTether
let store: WebStore
let server: Awaited<ReturnType<typeof serveRoutes>>

function answer(sessions: unknown[], reboot?: unknown) {
  tether.hostAnswers.set('GET /v1/recovery/status', {
    status: 200,
    body: { v: 1, boot_id: BOOT, max_attempts: 2, window_hours: 6, sessions },
  })
  if (reboot) tether.hostAnswers.set('GET /v1/reboot/status', { status: 200, body: reboot })
  else tether.hostAnswers.set('GET /v1/reboot/status', new TetherError(500, 'broken', {}))
}

// biome-ignore lint/suspicious/noExplicitAny: test JSON answers
type Answer = { status: number; body: any }

async function get(): Promise<Answer> {
  const response = await fetch(`${server.base}/api/recovery`)
  return { status: response.status, body: await response.json() }
}
async function resume(body?: unknown): Promise<Answer> {
  const response = await fetch(`${server.base}/api/recovery/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

beforeEach(async () => {
  tether = new FakeTether()
  store = new WebStore(':memory:')
  const life = createLifecycle({ tether: tether.client, store })
  server = await serveRoutes((router) =>
    registerRecoveryRoutes(router, life, tether.client, 'here'),
  )
})
afterEach(async () => {
  await server.close()
  store.close()
})

describe('GET /api/recovery', () => {
  it('is empty when nothing stopped, and says when it looked', async () => {
    answer([], { boot_id: BOOT, restore_boot_id: null, restored: [], failed: [], pending: [] })
    const { status, body } = await get()
    expect(status).toBe(200)
    expect(body).toMatchObject({ items: [], resumable: 0, partial: null, restartAt: null })
    expect(typeof body.checkedAt).toBe('number')
  })

  it('names sessions, words each outcome and lists the ones waiting on the owner first', async () => {
    tether.projectList = [{ id: 'aico', name: 'Aico', root: '/srv/aico' }]
    const held = tether.add({
      id: 'aaaaaaaa',
      tool: 'claude',
      label: 'Restore drill',
      projectId: 'aico',
      status: 'uncertain',
    })
    const back = tether.add({
      id: 'bbbbbbbb',
      tool: 'codex',
      label: 'Security hunt',
      status: 'running',
      host: 'agent-work',
    })
    const soon = tether.add({
      id: 'cccccccc',
      tool: 'claude',
      label: 'Waiting one',
      status: 'uncertain',
    })
    answer([
      crash({
        id: back.id,
        tool: 'codex',
        cause: 'killed',
        state: 'recovered',
        attempt: 1,
        recovered_at: NOW - 3_000_000,
        died_at: NOW - 3_100_000,
      }),
      crash({
        id: held.id,
        reason: 'it crashed again within 10 minutes of being recovered',
        agent_was_hog: true,
      }),
      crash({
        id: soon.id,
        state: 'waiting',
        cause: 'lost',
        kind: 'server-died',
        attempt: 1,
        resumable: true,
        reason: 'waiting until host admission has allowed agent launches for a minute',
      }),
    ])
    const { body } = await get()
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([held.id, soon.id, back.id])
    expect(body.resumable).toBe(1)
    expect(body.items[0]).toMatchObject({
      name: 'Restore drill',
      agent: 'Claude',
      project: 'Aico',
      machine: 'here',
      what: 'Ran out of memory (the agent itself was using most of it)',
      outcome: 'gave_up',
      note: 'Gave up: it crashed again within 10 minutes of being recovered.',
      attemptsLeft: 0,
      resumable: true,
      canOpen: false,
    })
    expect(body.items[1]).toMatchObject({
      outcome: 'waiting',
      what: 'Lost its session server',
      attemptsLeft: 1,
      resumable: false,
    })
    expect(body.items[1].note).toContain('Waiting to resume:')
    expect(body.items[2]).toMatchObject({
      outcome: 'resumed',
      machine: 'agent-work',
      what: 'Was killed',
      note: 'Resumed where it left off.',
      resumedAt: NOW - 3_000_000,
      attemptsLeft: 1,
      canOpen: true,
    })
    // Facts only: no detail file path, no ids of conversations.
    expect(JSON.stringify(body)).not.toContain('/home/someone')
  })

  it('names a session Tether no longer lists as it was recorded, and cannot open it', async () => {
    const kept = tether.add({ id: 'dddddddd', tool: 'shell', label: 'dddddddd' })
    answer([crash({ id: kept.id, name: 'Named once' }), crash({ id: 'eeeeeeee', name: 'Gone' })])
    const { body } = await get()
    // A crash record whose session is gone is still Tether's record; it names the session as recorded.
    expect(body.items.find((item: { id: string }) => item.id === 'eeeeeeee').name).toBe('Gone')
    expect(body.items.find((item: { id: string }) => item.id === 'eeeeeeee').canOpen).toBe(false)
  })

  it('shows what a workstation restart stopped, and that a later crash of the same session wins', async () => {
    const a = tether.add({ id: 'aaaaaaaa', tool: 'codex', label: 'Came back', status: 'running' })
    const b = tether.add({ id: 'bbbbbbbb', tool: 'shell', label: 'A shell', status: 'running' })
    const c = tether.add({ id: 'cccccccc', tool: 'claude', label: 'Stuck', status: 'uncertain' })
    answer(
      [
        crash({
          id: a.id,
          tool: 'codex',
          cause: 'oom-kill',
          state: 'recovered',
          attempt: 1,
          recovered_at: NOW,
        }),
      ],
      {
        boot_id: BOOT,
        restore_boot_id: BOOT,
        restore_started_at: NOW - 7_200_000,
        restored: [
          { id: a.id, name: null, tool: 'codex', resumed: true },
          { id: b.id, name: null, tool: 'shell', resumed: false },
          { id: 'ffffffff', name: null, tool: 'claude', resumed: true },
        ],
        failed: [
          {
            id: c.id,
            name: null,
            tool: 'claude',
            reason: 'no live agent with its conversation appeared within 2 minutes',
          },
        ],
        pending: [],
      },
    )
    const { body } = await get()
    expect(body.restartAt).toBe(NOW - 7_200_000)
    const byId = Object.fromEntries(body.items.map((item: { id: string }) => [item.id, item]))
    expect(Object.keys(byId).sort()).toEqual([a.id, b.id, c.id])
    expect(byId[a.id].cause).toBe('crash')
    expect(byId[b.id]).toMatchObject({
      cause: 'restart',
      what: 'Stopped when the workstation restarted',
      outcome: 'resumed',
      note: 'Started again fresh; it had no conversation to resume.',
      agent: 'Shell',
    })
    expect(byId[c.id]).toMatchObject({
      outcome: 'gave_up',
      resumable: false,
      note: 'Gave up: no live agent with its conversation appeared within 2 minutes.',
    })
  })

  it('ignores a restart report from an earlier boot', async () => {
    const a = tether.add({ id: 'aaaaaaaa', tool: 'codex', status: 'running' })
    answer([], {
      boot_id: BOOT,
      restore_boot_id: 'older-boot',
      restore_started_at: NOW - 60_000,
      restored: [{ id: a.id, name: null, tool: 'codex', resumed: true }],
      failed: [],
      pending: [],
    })
    expect((await get()).body.items).toEqual([])
  })

  it('says so when the restart report cannot be read, instead of showing nothing', async () => {
    answer([])
    const { body } = await get()
    expect(body.items).toEqual([])
    expect(body.partial).toMatch(/restart/)
  })

  it('fails (not empty) when Tether cannot answer', async () => {
    tether.hostAnswers.set('GET /v1/recovery/status', new TetherError(500, 'broken', {}))
    const { status, body } = await get()
    expect(status).toBe(502)
    expect(body.detail).toBeTruthy()
  })
})

describe('POST /api/recovery/resume', () => {
  const resumeKey = (id: string) => `POST /v1/recovery/${id}/resume`
  const setup = () => {
    const a = tether.add({ id: 'aaaaaaaa', tool: 'claude', label: 'First' })
    const b = tether.add({ id: 'bbbbbbbb', tool: 'claude', label: 'Second' })
    const waiting = tether.add({ id: 'cccccccc', tool: 'claude', label: 'Third' })
    answer([
      crash({ id: a.id }),
      crash({ id: b.id }),
      crash({ id: waiting.id, state: 'waiting' }),
      crash({ id: 'dddddddd', resumable: false }),
    ])
    return { a, b }
  }

  it('resumes everything waiting on the owner, one at a time, and nothing else', async () => {
    const { a, b } = setup()
    tether.hostAnswers.set(resumeKey(a.id), { status: 202, body: {} })
    tether.hostAnswers.set(resumeKey(b.id), { status: 202, body: {} })
    const { status, body } = await resume()
    expect(status).toBe(200)
    expect(body).toEqual({
      resumed: 2,
      results: [
        { id: a.id, name: 'First', ok: true, reason: null },
        { id: b.id, name: 'Second', ok: true, reason: null },
      ],
    })
    expect(
      tether
        .callsOf('request')
        .map((args) => `${args[0]} ${args[1]}`)
        .filter((x) => x.startsWith('POST')),
    ).toEqual([resumeKey(a.id), resumeKey(b.id)])
  })

  it('reports which ones Tether refused, in words', async () => {
    const { a, b } = setup()
    tether.hostAnswers.set(
      resumeKey(a.id),
      new TetherError(409, 'reservation_unavailable', { reason: 'not enough memory free' }),
    )
    tether.hostAnswers.set(resumeKey(b.id), { status: 202, body: {} })
    const { body } = await resume({})
    expect(body.resumed).toBe(1)
    expect(body.results[0]).toEqual({
      id: a.id,
      name: 'First',
      ok: false,
      reason: 'There isn’t room to start it now (not enough memory free).',
    })
  })

  it('resumes one session when asked for one', async () => {
    const { a, b } = setup()
    tether.hostAnswers.set(resumeKey(b.id), { status: 202, body: {} })
    const { body } = await resume({ id: b.id })
    expect(body.resumed).toBe(1)
    expect(tether.calls.some((call) => call.args[1] === resumeKey(a.id).slice(5))).toBe(false)
  })

  it('refuses a session that is not waiting on the owner, and a bad id', async () => {
    setup()
    const waiting = await resume({ id: 'cccccccc' })
    expect(waiting).toMatchObject({ status: 409 })
    expect((await resume({ id: 'nope' })).status).toBe(422)
  })

  it('says when there is nothing to resume', async () => {
    answer([])
    const { status, body } = await resume()
    expect(status).toBe(409)
    expect(body.detail).toBe('Nothing is waiting to be resumed')
    expect(tether.callsOf('request').some((args) => args[0] === 'POST')).toBe(false)
  })
})
