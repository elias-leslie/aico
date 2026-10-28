import { type RunMember, type RunsAnswer, TetherError, TetherUnavailable } from 'tether/client'
import { describe, expect, it, vi } from 'vitest'
import { createRuns, runFailure } from './runs'

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
    requestedModel: null,
    servedModel: null,
    fallback: false,
    attempt: null,
    attemptLimit: null,
    reason: null,
    can: { decide: false, cancel: true, dismiss: false },
    cancelling: false,
    hint: null,
    summary: '1 working',
    ...extra,
  }
}

const step = (extra: Partial<RunMember> = {}) =>
  member({
    id: 'step:r1:build',
    kind: 'step',
    coordinatorId: 'run:r1',
    stepKey: 'build',
    title: 'build',
    word: 'tool bash',
    requestedModel: 'opencode-go/a',
    servedModel: 'opencode-go/b',
    fallback: true,
    attempt: 2,
    attemptLimit: 3,
    summary: null,
    ...extra,
  })

const answer = (items: RunMember[], extra: Partial<RunsAnswer> = {}): RunsAnswer => ({
  status: 'ok',
  error: null,
  updatedAt: 1,
  items,
  ...extra,
})

function setup(response = 1) {
  const attention = { updateId: vi.fn(), removed: vi.fn() }
  const tray = vi.fn()
  const tether = {
    resumeRun: vi.fn(async () => ({})),
    cancelRun: vi.fn(async () => ({})),
    dismissRun: vi.fn(async () => ({})),
  }
  const refresh = vi.fn(async () => undefined)
  const openExternal = vi.fn(async () => undefined)
  const dialog = {
    showMessageBox: vi.fn(async () => ({ response })),
    showErrorBox: vi.fn(),
  }
  const runs = createRuns({ attention, tray, tether, refresh, openExternal, dialog })
  return { runs, attention, tray, tether, refresh, openExternal, dialog }
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

  it('lists runs and steps as tray rows without a window', () => {
    const { runs } = setup()
    runs.apply(answer([member({}), step()]))
    const rows = runs.widgets()
    expect(rows.map((w) => [w.id, w.kind, w.open, w.coordinatorId])).toEqual([
      ['run:r1', 'run', false, 'c0d0ae59'],
      ['step:r1:build', 'step', false, 'run:r1'],
    ])
    expect(rows[1]?.detail).toBe('tool bash · a → b · fallback · try 2 of 3')
    expect(rows[0]?.summary).toBe('1 working')
    expect(runs.member('step:r1:build')?.stepKey).toBe('build')
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

  it('opens only web pages', async () => {
    const { runs, openExternal } = setup()
    await runs.handle({ type: 'open', url: 'file:///etc/passwd' })
    expect(openExternal).not.toHaveBeenCalled()
    await runs.handle({ type: 'open', url: URL })
    expect(openExternal).toHaveBeenCalledWith(URL)
  })

  it('retries and skips without asking, then reads the runs again', async () => {
    const { runs, tether, dialog, refresh } = setup()
    await runs.handle({ type: 'resume', runId: 'r1', stepKey: 'build', action: 'retry' })
    await runs.handle({ type: 'resume', runId: 'r1', stepKey: 'build', action: 'skip' })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(tether.resumeRun).toHaveBeenNthCalledWith(1, 'r1', 'retry', 'build')
    expect(tether.resumeRun).toHaveBeenNthCalledWith(2, 'r1', 'skip', 'build')
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('confirms before failing a step and does nothing when the owner keeps it going', async () => {
    const kept = setup(0)
    kept.runs.apply(answer([member({}), step()]))
    await kept.runs.handle({ type: 'resume', runId: 'r1', stepKey: 'build', action: 'fail' })
    expect(kept.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(kept.tether.resumeRun).not.toHaveBeenCalled()

    const failed = setup(1)
    failed.runs.apply(answer([member({}), step()]))
    await failed.runs.handle({ type: 'resume', runId: 'r1', stepKey: 'build', action: 'fail' })
    expect(failed.dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Fail step build?', buttons: ['Keep going', 'Fail it'] }),
    )
    expect(failed.tether.resumeRun).toHaveBeenCalledWith('r1', 'fail', 'build')
  })

  it('confirms before cancelling a run or a step', async () => {
    const { runs, tether, dialog } = setup()
    runs.apply(answer([member({}), step()]))
    await runs.handle({ type: 'cancel', runId: 'r1', stepKey: null })
    await runs.handle({ type: 'cancel', runId: 'r1', stepKey: 'build' })
    expect(dialog.showMessageBox).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: 'Cancel run Ship the thing?' }),
    )
    expect(dialog.showMessageBox).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: 'Cancel step build?' }),
    )
    expect(tether.cancelRun).toHaveBeenNthCalledWith(1, 'r1', null)
    expect(tether.cancelRun).toHaveBeenNthCalledWith(2, 'r1', 'build')
  })

  it('dismisses an ended run without asking', async () => {
    const { runs, tether, dialog } = setup()
    await runs.handle({ type: 'dismiss', runId: 'r1' })
    expect(tether.dismissRun).toHaveBeenCalledWith('r1')
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('shows a failed choice as an error and still reads the runs again', async () => {
    const { runs, tether, dialog, refresh } = setup()
    tether.dismissRun.mockRejectedValueOnce(new TetherUnavailable('down'))
    await runs.handle({ type: 'dismiss', runId: 'r1' })
    expect(dialog.showErrorBox).toHaveBeenCalledWith('Workflow run', 'Tether is not reachable.')
    expect(refresh).toHaveBeenCalledOnce()
  })
})

describe('runFailure', () => {
  const err = (code: string, reason?: string) =>
    new TetherError(409, code, reason ? { reason } : {})

  it('puts each failure in the owner words', () => {
    expect(runFailure(new TetherUnavailable('x'))).toBe('Tether is not reachable.')
    expect(runFailure(err('agent_hub_unavailable'))).toBe('Agent Hub is not reachable.')
    expect(runFailure(err('agent_hub_refused', 'step is running'))).toBe(
      'Agent Hub did not accept it: step is running',
    )
    expect(runFailure(err('agent_hub_refused'))).toBe('Agent Hub did not accept it.')
    expect(runFailure(err('unknown_run'))).toBe('That run is no longer listed. It may have ended.')
    expect(runFailure(err('not_allowed', 'Nope'))).toBe('Nope')
    expect(runFailure(new Error('boom'))).toBe('Something went wrong; the run was not changed.')
  })
})
