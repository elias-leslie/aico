import type { RunMember, RunsAnswer } from 'tether/client'
import { describe, expect, it, vi } from 'vitest'
import { createRuns } from './runs'

const URL = 'http://hub.test/workflow-runs/r1'

function member(extra: Partial<RunMember>): RunMember {
  return {
    id: 'run:r1',
    kind: 'run',
    coordinator: false,
    coordinatorId: 'c0d0ae59',
    runId: 'r1',
    stepKey: null,
    title: 'Ship the thing',
    group: 'working',
    at: 1_000,
    word: 'running',
    status: 'running',
    url: URL,
    agent: null,
    tool: null,
    requestedModel: null,
    servedModel: null,
    fallback: false,
    attempt: null,
    attemptLimit: null,
    reason: null,
    session: false,
    can: { decide: false, cancel: true, dismiss: false },
    cancelling: false,
    hint: null,
    progress: '1 of 2 done',
    headline: 'build working',
    ...extra,
  }
}

const step = (extra: Partial<RunMember> = {}) =>
  member({
    id: 'step:r1:build',
    kind: 'step',
    coordinatorId: 'c0d0ae59',
    stepKey: 'build',
    title: 'build',
    tool: 'pi',
    group: 'working',
    word: 'tool bash',
    requestedModel: 'opencode-go/a',
    servedModel: 'opencode-go/b',
    fallback: true,
    attempt: 2,
    attemptLimit: 3,
    session: true,
    progress: null,
    headline: null,
    ...extra,
  })

const answer = (items: RunMember[], extra: Partial<RunsAnswer> = {}): RunsAnswer => ({
  status: 'ok',
  error: null,
  updatedAt: 1,
  items,
  ...extra,
})

function setup() {
  const attention = { updateId: vi.fn(), removed: vi.fn() }
  const tray = vi.fn()
  const openStep = vi.fn()
  const tools = [
    { slug: 'pi', name: 'Pi' },
    { slug: 'claude-code', name: 'Claude Code' },
  ]
  const runs = createRuns({ attention, tray, tools: () => tools, openStep, now: () => 181_000 })
  return { runs, attention, tray, openStep }
}

describe('runs in the desktop', () => {
  it('gives the attention tracker each run, not its steps, and redraws the tray', () => {
    const { runs, attention, tray } = setup()
    runs.apply(
      answer([
        member({ group: 'needs-you', at: 5 }),
        step({ group: 'needs-you' }),
        member({ id: 'run:r2', runId: 'r2', group: 'finished' }),
      ]),
    )
    expect(attention.updateId).toHaveBeenCalledTimes(2)
    expect(attention.updateId).toHaveBeenCalledWith('run:r1', 'blocked', 5)
    expect(attention.updateId).toHaveBeenCalledWith('run:r2', 'idle', 1_000)
    expect(tray).toHaveBeenCalledOnce()
  })

  it('clears a run that is gone, but nothing while Agent Hub has not been reached', () => {
    const { runs, attention } = setup()
    runs.apply(answer([member({})]))
    runs.apply(answer([], { status: 'unavailable', error: 'Agent Hub is not reachable' }))
    expect(attention.removed).not.toHaveBeenCalled()
    runs.apply(answer([member({})], { status: 'stale', error: 'Agent Hub is not reachable' }))
    runs.apply(answer([]))
    expect(attention.removed).toHaveBeenCalledWith('run:r1')
  })

  it('lists only running and waiting steps, as child agents of the launcher, never a run', () => {
    const { runs } = setup()
    runs.apply(
      answer([
        member({ group: 'needs-you' }),
        step({ at: 61_000 }),
        step({
          id: 'step:r1:ask',
          stepKey: 'ask',
          title: 'ask',
          group: 'needs-you',
          tool: 'claude-code',
          at: 1_000,
        }),
        step({ id: 'step:r1:later', stepKey: 'later', title: 'later', group: 'idle' }),
        step({
          id: 'step:r1:done',
          stepKey: 'done',
          title: 'done',
          group: 'idle',
          status: 'completed',
        }),
        step({
          id: 'step:r1:bad',
          stepKey: 'bad',
          title: 'bad',
          group: 'no-status',
          status: 'cancelled',
        }),
      ]),
    )
    const rows = runs.widgets()
    expect(rows.map((w) => [w.id, w.label, w.group, w.open, w.coordinatorId, w.detail])).toEqual([
      ['step:r1:build', 'build · Pi', 'working', false, 'c0d0ae59', 'working 2m'],
      ['step:r1:ask', 'ask · Claude Code', 'needs-you', false, 'c0d0ae59', 'waiting 3m'],
    ])
    // The run itself still feeds attention, by its member id.
    expect(runs.member('run:r1')?.kind).toBe('run')
  })

  it('says when the runs may be out of date', () => {
    const { runs } = setup()
    expect(runs.notice()).toBeNull()
    runs.apply(answer([]))
    expect(runs.notice()).toBeNull()
    runs.apply(answer([], { status: 'stale', error: 'Agent Hub is not reachable' }))
    expect(runs.notice()).toBe('Workflow runs may be out of date: Agent Hub is not reachable')
    runs.apply(answer([], { status: 'unavailable', error: null }))
    expect(runs.notice()).toBe('Workflow runs unavailable: Agent Hub is not reachable')
  })

  it('reads a step’s latest attempt in its own window, named for the step and its run', () => {
    const { runs, openStep } = setup()
    runs.apply(answer([member({}), step()]))
    runs.openStep('r1', 'build')
    expect(openStep).toHaveBeenCalledWith({
      runId: 'r1',
      stepKey: 'build',
      title: 'build — Ship the thing',
    })
  })

  it('opens nothing for a step that has no attempt yet or a run that is not listed', () => {
    const { runs, openStep } = setup()
    runs.apply(answer([member({}), step({ session: false })]))
    runs.openStep('r1', 'build')
    runs.openStep('zzz', 'build')
    expect(openStep).not.toHaveBeenCalled()
  })
})
