import type { RunList, RunListItem, RunView, StepView } from '@agent-hub/sdk'
import { describe, expect, it } from 'vitest'
import type { RunsConfig } from './config'
import { resolveRunsConfig } from './config'
import { type DismissedStore, RunControlError, type RunsApi, RunTracker } from './runs'
import { phaseWord, runMembers, stepSummary } from './runs-view'

const NOW = Date.parse('2026-10-28T12:00:00Z')
const CTX = { launcherId: 'c0d0ae59', url: 'http://hub/workflow-runs/r1' }

function step(key: string, status: string, extra: Partial<StepView> = {}): StepView {
  return { key, status, position: 0, ...extra } as StepView
}

function view(id: string, state: string, steps: StepView[], extra: Partial<RunView> = {}): RunView {
  return {
    id,
    state,
    goal: `Goal of ${id}`,
    launched_by: 'aico-widget-c0d0ae59',
    created_at: '2026-10-28T11:00:00+00:00',
    last_activity_at: '2026-10-28T11:55:00+00:00',
    steps: steps.map((s, i) => ({ ...s, position: i })),
    ...extra,
  } as RunView
}

describe('runMembers', () => {
  it('maps a running run and its steps, with the live phase and both models', () => {
    const members = runMembers(
      view('r1', 'running', [
        step('one', 'completed', {
          attempts: 1,
          attempt_limit: 2,
          attempt_history: [
            { attempt: 1, requested_model: 'a/m1', served_model: 'a/m1', effective_model: 'a/m1' },
          ],
        }),
        step('two', 'running', {
          attempts: 2,
          attempt_limit: 3,
          live: { phase: 'tool:bash' },
          attempt_history: [
            { attempt: 2, requested_model: 'a/m1', served_model: 'b/m2', fallback_used: true },
          ],
        } as Partial<StepView>),
        step('three', 'pending'),
      ]),
      CTX,
    )
    const [run, one, two, three] = members
    expect(run).toMatchObject({
      id: 'run:r1',
      kind: 'run',
      coordinatorId: 'c0d0ae59',
      group: 'working',
      word: 'running',
      title: 'Goal of r1',
      summary: '1 working · 1 pending · 1 done',
      can: { cancel: true, dismiss: false, decide: false },
    })
    expect(run?.hint).toContain('st workflow')
    expect(one).toMatchObject({ coordinatorId: 'run:r1', group: 'idle', word: 'done' })
    expect(two).toMatchObject({
      id: 'step:r1:two',
      group: 'working',
      word: 'tool bash',
      requestedModel: 'a/m1',
      servedModel: 'b/m2',
      fallback: true,
      attempt: 2,
      attemptLimit: 3,
      can: { cancel: true },
    })
    expect(three).toMatchObject({ group: 'idle', word: 'pending' })
  })

  it('puts the steps the owner is asked about in needs you, with the time they began waiting', () => {
    const members = runMembers(
      view(
        'r2',
        'needs_owner',
        [step('a', 'needs_owner'), step('b', 'failed'), step('c', 'completed')],
        {
          pause: {
            reason: 'step_failed',
            at: '2026-10-28T11:30:00Z',
            waiting: { b: { reason: 'step_failed' } },
          },
        },
      ),
      CTX,
    )
    const [run, a, b] = members
    expect(run).toMatchObject({
      group: 'needs-you',
      word: 'waiting for you',
      reason: 'step failed',
      at: Date.parse('2026-10-28T11:30:00Z'),
      can: { decide: false, cancel: true },
    })
    // `a` is marked needs_owner by Agent Hub but is not in the waiting map: only the map decides.
    expect(a).toMatchObject({ group: 'needs-you', can: { decide: false } })
    expect(b).toMatchObject({
      group: 'needs-you',
      word: 'waiting for you',
      can: { decide: true, cancel: false },
      at: Date.parse('2026-10-28T11:30:00Z'),
    })
  })

  it('decides a pause that names no step on the run, and nothing for blocked dependencies', () => {
    const integration = runMembers(
      view('r3', 'needs_owner', [step('a', 'completed')], {
        pause: { reason: 'integration_conflict', at: '2026-10-28T11:30:00Z' },
      }),
      CTX,
    )
    expect(integration[0]?.can.decide).toBe(true)
    const blocked = runMembers(
      view('r4', 'needs_owner', [step('a', 'pending')], {
        pause: { reason: 'blocked_dependencies', waiting: { a: { reason: 'x' } } },
      }),
      CTX,
    )
    expect(blocked[0]?.can.decide).toBe(false)
    expect(blocked[1]?.can.decide).toBe(false)
  })

  it('shows ended runs without a status group and offers dismiss', () => {
    const failed = runMembers(
      view('r5', 'failed', [step('a', 'failed')], { failure: { reason: 'step_failed' } }),
      CTX,
    )[0]
    expect(failed).toMatchObject({
      group: 'no-status',
      word: 'failed',
      reason: 'step failed',
      can: { dismiss: true, cancel: false },
      hint: null,
    })
    const done = runMembers(view('r6', 'completed', [step('a', 'completed')]), CTX)[0]
    expect(done).toMatchObject({ group: 'finished', word: 'completed', can: { dismiss: true } })
    expect(runMembers(view('r7', 'cancelled', []), CTX)[0]).toMatchObject({
      group: 'no-status',
      word: 'cancelled',
    })
  })

  it('reads Agent Hub times without a zone as UTC and words phases plainly', () => {
    const run = runMembers(
      view('r8', 'running', [], { last_activity_at: '2026-10-28T11:55:00' }),
      CTX,
    )[0]
    expect(run?.at).toBe(Date.parse('2026-10-28T11:55:00Z'))
    expect(phaseWord('provider_retry')).toBe('provider retry')
    expect(phaseWord('thinking')).toBe('thinking')
    expect(phaseWord(undefined)).toBeNull()
    expect(stepSummary([])).toBeNull()
  })
})

// --- the tracker -----------------------------------------------------------------

const CONFIG: RunsConfig = {
  pollMs: 1_000,
  endedRetentionMs: 3_600_000,
  listLimit: 30,
  concurrency: 2,
  frontendUrl: 'http://hub-web:3003',
}

function item(run: RunView): RunListItem {
  return {
    id: run.id,
    state: run.state,
    launched_by: run.launched_by,
    created_at: run.created_at,
    last_activity_at: run.last_activity_at,
  }
}

class FakeRuns {
  runs = new Map<string, RunView>()
  down: 'network' | null = null
  listCalls: string[] = []
  gets: string[] = []
  calls: string[] = []

  api: RunsApi = {
    list: async (params) => {
      this.listCalls.push(String(params?.launched_by))
      if (this.down) throw Object.assign(new Error('down'), { status: 0, code: 'network_error' })
      const runs = [...this.runs.values()].filter((r) => r.launched_by === params?.launched_by)
      return { runs: runs.map(item), total: runs.length, limit: 30, offset: 0 } as RunList
    },
    get: async (id) => {
      this.gets.push(id)
      const run = this.runs.get(id)
      if (!run) throw Object.assign(new Error('missing'), { status: 404 })
      return structuredClone(run)
    },
    resume: async (id, decision) => {
      this.calls.push(`resume ${id} ${decision.action} ${decision.step_key ?? ''}`)
      return { state: 'running' }
    },
    cancel: async (id) => {
      this.calls.push(`cancel ${id}`)
      return { state: 'cancelled' }
    },
    cancelStep: async (id, key) => {
      this.calls.push(`cancel ${id} ${key}`)
      return { state: 'running' }
    },
  }
}

function tracker(
  fake: FakeRuns,
  launchers: { id: string; ownershipId: string }[],
  clock: { now: number } = { now: NOW },
) {
  let dismissed: Record<string, number> = {}
  const store: DismissedStore = { read: () => dismissed, write: (d) => (dismissed = { ...d }) }
  const notified: number[] = []
  const instance = new RunTracker({
    api: () => fake.api,
    launchers: () => launchers,
    config: CONFIG,
    dismissed: store,
    notify: () => notified.push(clock.now),
    now: () => clock.now,
    log: () => {},
  })
  return { instance, notified, dismissed: () => dismissed, clock }
}

const LAUNCHER = [{ id: 'c0d0ae59', ownershipId: 'aico-widget-c0d0ae59' }]

describe('RunTracker', () => {
  it('lists the runs a session launched, asks by its ownership id, and ignores other runs', async () => {
    const fake = new FakeRuns()
    fake.runs.set('r1', view('r1', 'running', [step('a', 'running')]))
    fake.runs.set('r2', view('r2', 'running', [], { launched_by: null }))
    const { instance, notified } = tracker(fake, LAUNCHER)
    await instance.tick()
    expect(fake.listCalls).toEqual(['aico-widget-c0d0ae59'])
    const answer = instance.snapshot()
    expect(answer.status).toBe('ok')
    expect(answer.items.map((m) => m.id)).toEqual(['run:r1', 'step:r1:a'])
    expect(answer.items[0]?.url).toBe('http://hub-web:3003/workflow-runs/r1')
    expect(notified).toHaveLength(1)
    await instance.tick()
    expect(notified).toHaveLength(1)
  })

  it('reads an ended run once, and an active run every poll', async () => {
    const fake = new FakeRuns()
    fake.runs.set('live', view('live', 'running', [step('a', 'running')]))
    fake.runs.set('done', view('done', 'completed', [step('a', 'completed')]))
    const { instance } = tracker(fake, LAUNCHER)
    await instance.tick()
    await instance.tick()
    expect(fake.gets.filter((id) => id === 'live')).toHaveLength(2)
    expect(fake.gets.filter((id) => id === 'done')).toHaveLength(1)
  })

  it('drops ended runs past their retention, never lists an old backlog, and keeps active runs', async () => {
    const fake = new FakeRuns()
    fake.runs.set('old', view('old', 'completed', [], { last_activity_at: '2026-10-27T01:00:00Z' }))
    fake.runs.set('live', view('live', 'running', [], { last_activity_at: '2026-10-27T01:00:00Z' }))
    const { instance } = tracker(fake, LAUNCHER)
    await instance.tick()
    expect(instance.snapshot().items.map((m) => m.id)).toEqual(['run:live'])
    expect(fake.gets).not.toContain('old')
  })

  it('drops a dismissed run, remembers it across a new tracker, and refuses to dismiss a live run', async () => {
    const fake = new FakeRuns()
    fake.runs.set('done', view('done', 'failed', [step('a', 'failed')]))
    fake.runs.set('live', view('live', 'running', []))
    const first = tracker(fake, LAUNCHER)
    await first.instance.tick()
    expect(() => first.instance.dismiss('live')).toThrow(RunControlError)
    first.instance.dismiss('done')
    expect(first.instance.snapshot().items.map((m) => m.runId)).toEqual(['live'])
    expect(Object.keys(first.dismissed())).toEqual(['done'])
    const again = new RunTracker({
      api: () => fake.api,
      launchers: () => LAUNCHER,
      config: CONFIG,
      dismissed: { read: () => first.dismissed(), write: () => {} },
      notify: () => {},
      now: () => NOW,
      log: () => {},
    })
    await again.tick()
    expect(again.snapshot().items.map((m) => m.runId)).toEqual(['live'])
  })

  it('shows a run again when new steps reopen a dismissed one', async () => {
    const fake = new FakeRuns()
    fake.runs.set('r', view('r', 'completed', []))
    const t = tracker(fake, LAUNCHER)
    await t.instance.tick()
    t.instance.dismiss('r')
    fake.runs.set('r', view('r', 'running', [step('a', 'running')]))
    await t.instance.tick()
    expect(t.instance.snapshot().items.map((m) => m.id)).toEqual(['run:r', 'step:r:a'])
    expect(t.dismissed()).toEqual({})
  })

  it('keeps the last answer when Agent Hub cannot be reached, marked stale', async () => {
    const fake = new FakeRuns()
    fake.runs.set('r1', view('r1', 'running', []))
    const { instance, notified } = tracker(fake, LAUNCHER)
    const before = instance.snapshot()
    expect(before).toMatchObject({ status: 'ok', items: [], updatedAt: null })
    fake.down = 'network'
    await instance.tick()
    expect(instance.snapshot()).toMatchObject({
      status: 'unavailable',
      error: 'Agent Hub is not reachable',
    })
    fake.down = null
    await instance.tick()
    expect(instance.snapshot()).toMatchObject({ status: 'ok', error: null })
    fake.down = 'network'
    await instance.tick()
    const stale = instance.snapshot()
    expect(stale).toMatchObject({ status: 'stale', error: 'Agent Hub is not reachable' })
    expect(stale.items.map((m) => m.id)).toEqual(['run:r1'])
    expect(stale.updatedAt).toBe(NOW)
    expect(notified.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps following an active run after its launcher ends, and drops it once it is over', async () => {
    const fake = new FakeRuns()
    fake.runs.set(
      'r1',
      view('r1', 'needs_owner', [step('a', 'failed')], {
        pause: { reason: 'step_failed', waiting: { a: {} } },
      }),
    )
    const launchers = [...LAUNCHER]
    const t = tracker(fake, launchers)
    await t.instance.tick()
    launchers.length = 0
    await t.instance.tick()
    expect(t.instance.snapshot().items[0]).toMatchObject({
      id: 'run:r1',
      coordinatorId: 'c0d0ae59',
    })
    fake.runs.set('r1', view('r1', 'completed', []))
    await t.instance.tick()
    expect(t.instance.snapshot().items).toEqual([])
  })

  it('answers a waiting step, cancels, and refuses what is not allowed', async () => {
    const fake = new FakeRuns()
    fake.runs.set(
      'r1',
      view('r1', 'needs_owner', [step('a', 'failed'), step('b', 'running')], {
        pause: { reason: 'step_failed', waiting: { a: { reason: 'step_failed' } } },
      }),
    )
    const { instance } = tracker(fake, LAUNCHER)
    await instance.tick()
    await instance.resume('r1', 'a', 'retry')
    await expect(instance.resume('r1', 'b', 'retry')).rejects.toMatchObject({ code: 'not_allowed' })
    await expect(instance.resume('r1', 'nope', 'skip')).rejects.toMatchObject({
      code: 'unknown_step',
    })
    await expect(instance.resume('zzz', 'a', 'skip')).rejects.toMatchObject({ code: 'unknown_run' })
    await instance.cancel('r1', 'b')
    await expect(instance.cancel('r1', 'a')).rejects.toMatchObject({ code: 'not_allowed' })
    await instance.cancel('r1', null)
    expect(fake.calls).toEqual(['resume r1 retry a', 'cancel r1 b', 'cancel r1'])
  })
})

describe('resolveRunsConfig', () => {
  const none = () => {
    throw new Error('ENOENT')
  }
  it('derives the run page address the way st workflow does, and lets variables win', () => {
    expect(resolveRunsConfig({}, '/h', none, { baseUrl: 'http://box:8003' })).toMatchObject({
      frontendUrl: 'http://box:3003',
      pollMs: 3000,
    })
    expect(
      resolveRunsConfig(
        { AGENT_HUB_FRONTEND_URL: 'https://agent.example/', TETHER_AGENT_HUB_RUNS_POLL_MS: '500' },
        '/h',
        none,
        { baseUrl: 'http://box:8003' },
      ),
    ).toMatchObject({ frontendUrl: 'https://agent.example', pollMs: 500 })
    expect(
      resolveRunsConfig({ TETHER_AGENT_HUB_RUNS_POLL_MS: 'x' }, '/h', none, {
        baseUrl: 'http://box:8003',
      }).pollMs,
    ).toBe(3000)
  })
})
