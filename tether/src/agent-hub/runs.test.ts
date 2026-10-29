import type { RunList, RunListItem, RunView, StepView } from '@agent-hub/sdk'
import { describe, expect, it } from 'vitest'
import type { RunsConfig } from './config'
import { resolveRunsConfig } from './config'
import {
  type DismissedStore,
  type PauseNoticeStore,
  RunControlError,
  type RunsApi,
  RunTracker,
} from './runs'
import { pauseNotice, phaseWord, runMembers, runProgress } from './runs-view'

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
      summary: '1 of 3 done',
      progress: '1 of 3 done',
      headline: 'two working',
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
            at: '2026-10-28T11:30:00Z' as never, // older Agent Hub text time; the SDK now types epoch seconds
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
      progress: '1 of 3 done',
      headline: 'b needs a decision',
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

  it('decides a failed step Agent Hub lists in the pause failed list, with a time in epoch seconds', () => {
    const [run, make, after] = runMembers(
      view('r6', 'needs_owner', [step('make', 'failed'), step('after', 'pending')], {
        pause: {
          reason: 'step_failed',
          step_key: 'make',
          at: 1793230241.99,
          failed: {
            make: { status: 'failed', reason: 'max_attempts: acceptance_failed', error: null },
          },
          blocked: { after: { state: 'blocked', reason: 'blocked by make (failed)' } },
        },
      }),
      CTX,
    )
    expect(run).toMatchObject({ group: 'needs-you', at: 1793230241990, can: { decide: false } })
    expect(make).toMatchObject({
      group: 'needs-you',
      word: 'waiting for you',
      reason: 'max attempts: acceptance failed',
      can: { decide: true },
    })
    expect(after).toMatchObject({ group: 'idle', can: { decide: false } })
  })

  it('decides a pause that names no step on the run, and nothing for blocked dependencies', () => {
    const integration = runMembers(
      view('r3', 'needs_owner', [step('a', 'completed')], {
        pause: { reason: 'integration_conflict', at: '2026-10-28T11:30:00Z' as never },
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
    expect(phaseWord('waiting')).toBe('waiting for output')
    expect(phaseWord(undefined)).toBeNull()
    expect(runProgress([])).toBeNull()
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

describe('a run as one line', () => {
  it('says progress and state in words, naming the steps that need a decision', () => {
    const [run] = runMembers(
      view(
        'r9',
        'needs_owner',
        [
          step('lint-fix', 'failed'),
          step('a', 'completed'),
          step('b', 'skipped'),
          step('c', 'pending'),
          step('d', 'pending'),
        ],
        { pause: { reason: 'step_failed', at: 1793230241, waiting: { 'lint-fix': {} } } },
      ),
      CTX,
    )
    expect(run).toMatchObject({
      progress: '2 of 5 done',
      headline: 'lint-fix needs a decision',
      group: 'needs-you',
    })
    const finished = runMembers(view('r10', 'completed', [step('a', 'completed')]), CTX)[0]
    expect(finished).toMatchObject({ progress: '1 of 1 done', headline: 'finished' })
    const failed = runMembers(
      view('r11', 'failed', [step('a', 'failed')], { failure: { reason: 'step_failed' } }),
      CTX,
    )[0]
    expect(failed?.headline).toBe('failed: step failed')
  })

  it('marks a step that has an attempt session to read, without naming it', () => {
    const [, started, fresh] = runMembers(
      view('r12', 'running', [
        step('a', 'running', { attempt_history: [{ attempt: 1, session_id: 'sess-1' }] }),
        step('b', 'pending'),
      ]),
      CTX,
    )
    expect(started?.session).toBe(true)
    expect(fresh?.session).toBe(false)
    expect(JSON.stringify(started)).not.toContain('sess-1')
  })

  it('opens the latest attempt of a step of a listed run, or a named attempt of it, and no other', async () => {
    const fake = new FakeRuns()
    fake.runs.set(
      'r1',
      view('r1', 'running', [
        step('a', 'running', {
          agent_slug: 'coder',
          attempt_history: [
            { attempt: 1, session_id: 'old', requested_model: 'x/m' },
            { attempt: 2, session_id: 'new', requested_model: 'x/m2' },
          ],
        }),
        step('b', 'pending'),
      ]),
    )
    const { instance } = tracker(fake, LAUNCHER)
    await instance.tick()
    expect(instance.stepSession('r1', 'a')).toMatchObject({
      sessionId: 'new',
      agentSlug: 'coder',
      requestedModel: 'x/m2',
      attempt: 2,
    })
    expect(instance.stepSession('r1', 'a', 'old').sessionId).toBe('old')
    expect(() => instance.stepSession('r1', 'a', 'elsewhere')).toThrow(RunControlError)
    expect(() => instance.stepSession('r1', 'b')).toThrow(/not started/)
    expect(() => instance.stepSession('r1', 'zzz')).toThrow(RunControlError)
    expect(() => instance.stepSession('other', 'a')).toThrow(RunControlError)
  })

  it('drops an ended run on its own once the delay has passed, and keeps a going one', async () => {
    const fake = new FakeRuns()
    fake.runs.set('done', view('done', 'completed', [step('a', 'completed')]))
    fake.runs.set('live', view('live', 'running', [step('a', 'running')]))
    const t = tracker(fake, LAUNCHER, { now: NOW })
    await t.instance.tick()
    expect(t.instance.snapshot().items.map((m) => m.runId)).toContain('done')
    t.clock.now = NOW + CONFIG.endedRetentionMs - 10 * 60_000 // its last activity was 5 min before NOW
    await t.instance.tick()
    expect(t.instance.snapshot().items.map((m) => m.runId)).toContain('done')
    t.clock.now = NOW + CONFIG.endedRetentionMs + 10 * 60_000
    const before = t.notified.length
    await t.instance.tick()
    expect(t.instance.snapshot().items.map((m) => m.runId)).toEqual(['live', 'live'])
    expect(t.notified.length).toBeGreaterThan(before)
  })
})

describe('telling the coordinator about a pause', () => {
  const paused = (at: number, waiting = 'a') =>
    view('r1', 'needs_owner', [step(waiting, 'failed')], {
      goal: 'Proof run',
      pause: { reason: 'step_failed', at, waiting: { [waiting]: { reason: 'step_failed' } } },
    })

  function pausing(fake: FakeRuns, launchers: { id: string; ownershipId: string }[]) {
    let told: Record<string, { key: string; at: number }> = {}
    const store: PauseNoticeStore = { read: () => told, write: (t) => (told = { ...t }) }
    const sent: { to: string; text: string }[] = []
    let accept = true
    const make = () =>
      new RunTracker({
        api: () => fake.api,
        launchers: () => launchers,
        config: CONFIG,
        dismissed: { read: () => ({}), write: () => {} },
        pauses: {
          store,
          maxChars: () => 500,
          tell: (to, notice) => {
            if (!accept) return false
            sent.push({ to, text: notice.text })
            return true
          },
        },
        notify: () => {},
        now: () => NOW,
        log: () => {},
      })
    return { make, sent, refuse: () => (accept = false), allow: () => (accept = true) }
  }

  it('says which run and step, why, and the exact command', () => {
    const notice = pauseNotice(paused(1793230241), 500)
    expect(notice?.text).toBe(
      'Workflow run "Proof run" (r1) needs the owner to decide: step a (step failed). ' +
        'Ask the owner, then run only their answer: st workflow resume r1 --step a --action retry|skip|fail',
    )
    expect(pauseNotice(view('r2', 'running', []), 500)).toBeNull()
    const long = pauseNotice(
      view('r3', 'needs_owner', [step('a', 'failed')], {
        goal: 'g'.repeat(300),
        pause: { reason: 'step_failed', at: 1, waiting: { a: { reason: 'r'.repeat(300) } } },
      }),
      200,
    )
    expect(long?.text.length).toBeLessThanOrEqual(200)
    expect(long?.text).toContain('st workflow resume r3 --step a')
  })

  it('tells once per pause, again for a new pause, and not again after a restart', async () => {
    const fake = new FakeRuns()
    fake.runs.set('r1', paused(1000))
    const p = pausing(fake, LAUNCHER)
    const first = p.make()
    await first.tick()
    await first.tick()
    await first.tick()
    expect(p.sent).toHaveLength(1)
    expect(p.sent[0]).toMatchObject({ to: 'c0d0ae59' })
    expect(p.sent[0]?.text).toContain('--step a')

    // Tether restarts: the same pause is not told again.
    const restarted = p.make()
    await restarted.tick()
    expect(p.sent).toHaveLength(1)

    // The owner answers, the run goes on, then it pauses again on another step.
    fake.runs.set('r1', view('r1', 'running', [step('a', 'running')]))
    await restarted.tick()
    fake.runs.set('r1', paused(2000, 'b'))
    await restarted.tick()
    await restarted.tick()
    expect(p.sent).toHaveLength(2)
    expect(p.sent[1]?.text).toContain('--step b')
  })

  it('tells a new pause on the same run even when the run was not seen going in between', async () => {
    const fake = new FakeRuns()
    fake.runs.set('r1', paused(1000))
    const p = pausing(fake, LAUNCHER)
    const t = p.make()
    await t.tick()
    fake.runs.set('r1', paused(2000))
    await t.tick()
    expect(p.sent).toHaveLength(2)
  })

  it('keeps trying while the session cannot take a note, and tells no ended session', async () => {
    const fake = new FakeRuns()
    fake.runs.set('r1', paused(1000))
    const p = pausing(fake, LAUNCHER)
    p.refuse()
    const t = p.make()
    await t.tick()
    await t.tick()
    expect(p.sent).toHaveLength(0)
    p.allow()
    await t.tick()
    expect(p.sent).toHaveLength(1)

    // The coordinator has ended: nobody is told; the owner answers from the run.
    const gone = pausing(fake, [])
    const orphan = gone.make()
    await orphan.tick()
    await orphan.tick()
    expect(gone.sent).toHaveLength(0)
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
    expect(resolveRunsConfig({}, '/h', none, { baseUrl: 'http://box:8003' }).endedRetentionMs).toBe(
      1_800_000,
    )
    expect(
      resolveRunsConfig({ TETHER_AGENT_HUB_RUNS_ENDED_MS: '60000' }, '/h', none, {
        baseUrl: 'http://box:8003',
      }).endedRetentionMs,
    ).toBe(60_000)
    expect(
      resolveRunsConfig({ TETHER_AGENT_HUB_RUNS_POLL_MS: 'x' }, '/h', none, {
        baseUrl: 'http://box:8003',
      }).pollMs,
    ).toBe(3000)
  })
})
