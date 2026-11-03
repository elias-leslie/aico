import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaneView } from './lane-reports'
import { bindCatalog, insertWidget, removeWidget } from './lifecycle/catalog'
import { Store } from './store'
import type { PullRead } from './wait-kinds'
import {
  LONG_POLL_MAX_SECONDS,
  sessionVerdict,
  spanLabel,
  type Wait,
  type WaitOperations,
  type WaitRefused,
  WaitService,
  WaitStore,
  waitLine,
} from './waits'
import { DEFAULT_WAKE_POLICY, type EndedSession } from './wakes'

const WAITER = 'aaaa0001'
const LANE = 'bbbb0001'
const OTHER = 'cccc0001'
const SETTLE = DEFAULT_WAKE_POLICY.laneSettleSeconds * 1000
const T0 = 1_000_000

const stores: Store[] = []
const services: WaitService[] = []
afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  for (const store of stores.splice(0)) store.close()
  vi.useRealTimers()
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})

function view(overrides: Partial<LaneView> = {}): LaneView {
  return {
    id: LANE,
    host: null,
    generation: 'g1',
    state: 'working',
    stateAt: Date.now(),
    stateDetail: null,
    stateAgentAt: 0,
    statePrevious: 'idle',
    createdAt: 0,
    coordinatorId: WAITER,
    parentId: WAITER,
    launched: true,
    title: 'TEST lane',
    requestId: 'test-lane',
    waitingOn: null,
    tool: 'claude-code',
    modelSwitch: null,
    ...overrides,
  }
}

function harness() {
  const store = new Store(':memory:', () => T0)
  stores.push(store)
  bindCatalog(store.db)
  insertWidget(WAITER, 'claude-code', T0)
  insertWidget(LANE, 'claude-code', T0)
  const views = new Map<string, LaneView | null>([[LANE, view()]])
  const delivered: { to: string; source: string; line: string }[] = []
  const relaunched: { ended: EndedSession; line: string }[] = []
  const changed: (string | null)[] = []
  const gone = new Set<string>()
  const notMain = new Map<string, string>()
  const ended = new Set<string>()
  const pulls = new Map<string, PullRead>()
  const told = new Set<string>()
  const refreshed: string[] = []
  const cmds = new Map<string, { argv: string[]; cwd: string; deadline: number }>()
  const settled: string[] = []
  const swept: string[][] = []
  const ops: WaitOperations = {
    now: () => Date.now(),
    policy: () => DEFAULT_WAKE_POLICY,
    resolve: (ref) => {
      if (views.has(ref)) return { id: ref, host: null }
      for (const [id, item] of views) if (item?.requestId === ref) return { id, host: null }
      return null
    },
    view: (id) => views.get(id) ?? null,
    endedSession: (ref) => (ended.has(ref) ? ref : null),
    pullRef: (kind, ref) => {
      if (kind === 'job')
        for (const key of pulls.keys()) if (key.startsWith(`job:${ref}`)) return key.slice(4)
      return pulls.has(`${kind}:${ref}`) ? ref : null
    },
    read: (kind, ref) => pulls.get(`${kind}:${ref}`),
    refresh: (kind, ref, force) => refreshed.push(`${kind}:${ref}:${force}`),
    createCmd: (ref, spec) => {
      cmds.set(ref, spec)
      pulls.set(`cmd:${ref}`, { state: 'waiting', detail: null, title: spec.argv.join(' ') })
    },
    cmdArgv: (ref) => cmds.get(ref)?.argv ?? null,
    settled: (wait) => settled.push(`${wait.kind}:${wait.ref}`),
    sweepCmd: (armed) => swept.push([...armed]),
    told: (wait) => told.has(wait.id),
    agentGone: (id) => gone.has(id),
    receiver: (id) => id === WAITER || id === OTHER,
    notMainAgent: async (waiter, thread) => notMain.get(`${waiter}/${thread}`) ?? null,
    deliver: (to, source, line) => delivered.push({ to, source, line }),
    relaunch: (ended, line) => relaunched.push({ ended, line }),
    changed: (waiter) => changed.push(waiter),
    log: () => {},
  }
  const waits = new WaitService(new WaitStore(store.db), ops)
  services.push(waits)
  waits.start()
  const set = (overrides: Partial<LaneView> | null) => {
    views.set(LANE, overrides === null ? null : view(overrides))
    waits.check(new Set([`session:${LANE}`]))
  }
  const arm = (input: Partial<Parameters<WaitService['arm']>[0]> = {}) =>
    waits.arm({
      waiter: WAITER,
      by: null,
      kind: 'session',
      ref: LANE,
      until: 'finished',
      since: null,
      timeoutMinutes: null,
      key: null,
      note: null,
      thread: null,
      ...input,
    })
  const pull = (kind: string, ref: string, reading: PullRead) => {
    pulls.set(`${kind}:${ref}`, reading)
    waits.check(new Set([`${kind}:${ref}`]))
  }
  return {
    store,
    waits,
    views,
    delivered,
    relaunched,
    changed,
    gone,
    notMain,
    ended,
    pulls,
    told,
    refreshed,
    cmds,
    settled,
    swept,
    set,
    pull,
    arm,
  }
}

describe('sessionVerdict', () => {
  const policy = DEFAULT_WAKE_POLICY
  it('finished: idle with the agent time after since, held settle', () => {
    const wait = { until: 'finished' as const, since: T0 }
    const idle = view({ state: 'idle', stateAt: T0, stateAgentAt: T0 + 1 })
    expect(sessionVerdict(wait, idle, false, policy, T0 + 1)).toEqual({
      outcome: null,
      recheckAt: T0 + SETTLE,
    })
    expect(sessionVerdict(wait, idle, false, policy, T0 + SETTLE).outcome).toBe('until')
    // A turn that ended before since is not one.
    const old = view({ state: 'idle', stateAt: T0 - SETTLE, stateAgentAt: T0 - 5 })
    expect(sessionVerdict(wait, old, false, policy, T0 + SETTLE).outcome).toBeNull()
    // Waiting on something of its own is not finished.
    const waiting = view({ ...idle, waitingOn: 'a check-in at 5:30 PM' })
    expect(sessionVerdict(wait, waiting, false, policy, T0 + SETTLE).outcome).toBeNull()
  })

  it('an idle with no agent time (a first sighting after a restart) is no finished turn', () => {
    const wait = { until: 'finished' as const, since: T0 }
    const idle = view({ state: 'idle', stateAt: T0 + 5, stateAgentAt: 0 })
    expect(sessionVerdict(wait, idle, false, policy, T0 + 5 + SETTLE).outcome).toBeNull()
  })

  it('blocked: a prompt or question held, never a dialog', () => {
    const wait = { until: 'blocked' as const, since: 0 }
    const held = DEFAULT_WAKE_POLICY.laneBlockedSeconds * 1000
    const prompt = view({ state: 'blocked', stateDetail: 'permission prompt', stateAt: T0 })
    expect(sessionVerdict(wait, prompt, false, policy, T0 + held).outcome).toBe('until')
    const dialog = view({ state: 'blocked', stateDetail: 'dialog open', stateAt: T0 })
    expect(sessionVerdict(wait, dialog, false, policy, T0 + held).outcome).toBeNull()
  })

  it('a gone session is ended, or gone for any other until', () => {
    expect(sessionVerdict({ until: 'ended', since: 0 }, null, false, policy, T0).outcome).toBe(
      'until',
    )
    expect(sessionVerdict({ until: 'finished', since: 0 }, null, false, policy, T0).outcome).toBe(
      'gone',
    )
    expect(
      sessionVerdict({ until: 'idle', since: 0 }, view({ state: 'unknown' }), true, policy, T0)
        .outcome,
    ).toBe('gone')
  })
})

describe('waitLine', () => {
  const base = {
    ref: LANE,
    host: null,
    until: 'finished' as const,
    note: null,
    armedAt: T0,
    cursor: { state: 'working', detail: null, title: 'TEST lane', requestId: 'test-lane' },
  }

  it('names the session, the outcome and the command to look with', () => {
    expect(waitLine(base, 'until', T0)).toBe(
      '[Ready] session "TEST lane" (req test-lane) went idle · st aico root status test-lane',
    )
    expect(waitLine(base, 'gone', T0)).toBe(
      '[Wait over] session "TEST lane" (req test-lane) ended before it went idle · st aico root status test-lane',
    )
    expect(waitLine(base, 'timeout', T0 + 2 * 3600_000)).toBe(
      '[Wait timed out] session "TEST lane" (req test-lane) not idle yet after 2h: it is working · st aico root status test-lane',
    )
  })

  it('carries a cleaned note and a cleaned title, never brackets or quotes', () => {
    const line = waitLine(
      {
        ...base,
        note: 'merge "it" [now]',
        cursor: { state: 'blocked', detail: 'input needed', title: '/x "y"', requestId: null },
        until: 'blocked',
      },
      'until',
      T0,
    )
    expect(line).toBe(
      '[Ready] session "x y" is blocked: input needed · re: "merge it now" · st aico widget status --widget-id bbbb0001',
    )
  })

  it('spans', () => {
    expect(spanLabel(30_000)).toBe('1m')
    expect(spanLabel(45 * 60_000)).toBe('45m')
    expect(spanLabel(90 * 60_000)).toBe('1h30m')
    expect(spanLabel(7 * 24 * 3600_000)).toBe('7d')
  })
})

describe('WaitService', () => {
  it('a lane that already finished fires at arm, once', async () => {
    const h = harness()
    // The waiter sent the lane a follow-up; the lane finished after it.
    h.waits.store.recordSend(WAITER, LANE, T0 - 60_000)
    h.views.set(LANE, view({ state: 'idle', stateAt: T0 - 30_000, stateAgentAt: T0 - 30_000 }))
    const { wait, created } = await h.arm()
    expect(created).toBe(true)
    expect(wait.since).toBe(T0 - 60_000)
    expect(wait.state).toBe('fired')
    expect(wait.outcome).toBe('until')
    expect(h.delivered).toEqual([
      {
        to: WAITER,
        source: `wait:${wait.id}`,
        line: '[Ready] session "TEST lane" (req test-lane) went idle · st aico root status test-lane',
      },
    ])
    h.waits.check()
    expect(h.delivered).toHaveLength(1)
  })

  it('since defaults to the launch for the launcher, else to arming', async () => {
    const h = harness()
    h.views.set(LANE, view({ createdAt: T0 - 5_000 }))
    expect((await h.arm()).wait.since).toBe(T0 - 5_000)
    h.views.set(LANE, view({ parentId: OTHER, createdAt: T0 - 5_000 }))
    expect((await h.arm({ until: 'idle' })).wait.since).toBe(T0)
    expect((await h.arm({ until: 'blocked', since: 42 })).wait.since).toBe(42)
  })

  it('a working lane fires once when it finishes, after settle', async () => {
    const h = harness()
    const { wait } = await h.arm()
    expect(wait.state).toBe('armed')
    expect(h.waits.waitingOn(WAITER)).toBe('a wait on session "TEST lane" (finished)')
    vi.setSystemTime(T0 + 60_000)
    h.set({ state: 'idle', stateAt: T0 + 60_000, stateAgentAt: T0 + 60_000 })
    expect(h.delivered).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(SETTLE + 100)
    expect(h.delivered).toHaveLength(1)
    expect(h.waits.store.get(wait.id)?.state).toBe('fired')
    h.set({ state: 'idle', stateAt: T0 + 60_000, stateAgentAt: T0 + 60_000 })
    expect(h.delivered).toHaveLength(1)
    expect(h.waits.waitingOn(WAITER)).toBeNull()
  })

  it('a deadline fires timeout with the last state, never silent', async () => {
    const h = harness()
    const { wait } = await h.arm({ timeoutMinutes: 2, note: 'store lane' })
    await vi.advanceTimersByTimeAsync(2 * 60_000 + 100)
    const over = h.waits.store.get(wait.id) as Wait
    expect(over.state).toBe('timed_out')
    expect(over.outcome).toBe('timeout')
    expect(h.delivered.map((item) => item.line)).toEqual([
      '[Wait timed out] session "TEST lane" (req test-lane) not idle yet after 2m: it is working · re: "store lane" · st aico root status test-lane',
    ])
  })

  it('cancel is quiet and confirms only an armed wait', async () => {
    const h = harness()
    const { wait } = await h.arm()
    expect(h.waits.cancel(wait.id).cancelled).toBe(true)
    expect(h.waits.cancel(wait.id)).toMatchObject({
      cancelled: false,
      wait: { state: 'cancelled' },
    })
    h.set({ state: 'idle', stateAt: T0, stateAgentAt: T0 + 1 })
    await vi.advanceTimersByTimeAsync(SETTLE + 100)
    expect(h.delivered).toHaveLength(0)
  })

  it('fires at most once: the seq compare-and-set refuses a second settle', async () => {
    const h = harness()
    const { wait } = await h.arm()
    expect(h.waits.store.settle(wait, 'fired', 'until', 'x', T0)).toBe(true)
    expect(h.waits.store.settle(wait, 'fired', 'until', 'y', T0)).toBe(false)
    expect(h.waits.store.get(wait.id)?.line).toBe('x')
  })

  it('the same key returns the armed wait; once over or cancelled it arms a new one', async () => {
    const h = harness()
    const first = await h.arm({ key: 'lane-1' })
    const again = await h.arm({ key: 'lane-1', ref: 'test-lane' })
    expect(again.created).toBe(false)
    expect(again.wait.id).toBe(first.wait.id)
    await expect(h.arm({ key: 'lane-1', until: 'idle' })).rejects.toMatchObject({
      code: 'key_conflict',
    })
    h.waits.cancel(first.wait.id)
    const second = await h.arm({ key: 'lane-1' })
    expect(second.created).toBe(true)
    h.set({ state: 'idle', stateAt: T0 - SETTLE, stateAgentAt: T0 + 1 })
    expect(h.waits.store.get(second.wait.id)?.state).toBe('fired')
    expect((await h.arm({ key: 'lane-1' })).created).toBe(true)
    // A blocking client has no session to keep keys for.
    await expect(h.arm({ waiter: null, key: 'x' })).rejects.toMatchObject({ code: 'invalid_body' })
  })

  it('a kept wait that fires while its End still runs relaunches, never pastes', async () => {
    const h = harness()
    const { wait } = await h.arm({ key: 'k' })
    const ended = {
      id: WAITER,
      tool: 'claude-code',
      projectId: null,
      projectRoot: '/tmp',
      name: null,
      origin: 'aico',
      coordinator: true,
      coordinatorId: null,
      resumeId: null,
    }
    h.waits.keep(WAITER, ended)
    expect(h.waits.store.get(wait.id)?.key).toBeNull()
    h.set({ state: 'idle', stateAt: T0 - SETTLE, stateAgentAt: T0 + 1 })
    expect(h.relaunched).toHaveLength(1)
    expect(h.delivered).toHaveLength(0)
  })

  it('a long poll before start holds instead of answering at once', async () => {
    const h = harness()
    const { wait } = await h.arm()
    h.waits.stop()
    let answered = false
    const answer = h.waits.waitFor(wait.id, 5_000).then(() => {
      answered = true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(answered).toBe(false)
    await vi.advanceTimersByTimeAsync(4_100)
    await answer
    expect(answered).toBe(true)
  })

  it('refuses itself, a non-agent waiter, a provable subagent and too many', async () => {
    const h = harness()
    const code = async (input: Parameters<typeof h.arm>[0]) => {
      try {
        await h.arm(input)
        return 'armed'
      } catch (error) {
        return (error as WaitRefused).code
      }
    }
    h.views.set(WAITER, view({ id: WAITER, requestId: null }))
    expect(await code({ ref: WAITER })).toBe('self_wait')
    expect(await code({ waiter: null, by: LANE })).toBe('self_wait')
    expect(await code({ waiter: LANE })).toBe('wait_unsupported')
    expect(await code({ ref: 'nope-req' })).toBe('not_found')
    h.notMain.set(`${WAITER}/thread-sub-1`, 'subagent')
    expect(await code({ thread: 'thread-sub-1' })).toBe('not_main_agent')
    expect(await code({ thread: 'thread-main' })).toBe('armed')
    expect(await code({ ref: 'test-lane', until: 'idle' })).toBe('armed')
    for (let i = 2; i < DEFAULT_WAKE_POLICY.maxWaitsPerSession; i += 1) await h.arm()
    expect(await code({})).toBe('too_many_waits')
    expect(
      await code({ timeoutMinutes: DEFAULT_WAKE_POLICY.waitMaxMinutes + 1, waiter: null }),
    ).toBe('invalid_body')
  })

  it('a session that ends: ended fires, finished is gone', async () => {
    const h = harness()
    const ended = await h.arm({ until: 'ended' })
    const finished = await h.arm()
    h.set(null)
    expect(h.waits.store.get(ended.wait.id)?.outcome).toBe('until')
    expect(h.waits.store.get(finished.wait.id)?.outcome).toBe('gone')
    expect(h.delivered.map((item) => item.line).sort()).toEqual([
      '[Ready] session "TEST lane" (req test-lane) ended · st aico root status test-lane',
      '[Wait over] session "TEST lane" (req test-lane) ended before it went idle · st aico root status test-lane',
    ])
  })

  it('an agent that left its pane for good counts as ended', async () => {
    const h = harness()
    const { wait } = await h.arm({ until: 'ended' })
    h.gone.add(LANE)
    h.set({ state: 'unknown' })
    expect(h.waits.store.get(wait.id)?.outcome).toBe('until')
  })

  it('a blocking client (no waiter) is answered by waitFor and gets no paste', async () => {
    const h = harness()
    const { wait } = await h.arm({ waiter: null, by: WAITER })
    // The session it was armed from hears it (lane lines it covers skip it).
    expect(wait.armedBy).toBe(WAITER)
    const answer = h.waits.waitFor(wait.id, 55_000)
    h.set({ state: 'idle', stateAt: T0, stateAgentAt: T0 + 1 })
    await vi.advanceTimersByTimeAsync(SETTLE + 100)
    expect((await answer)?.state).toBe('fired')
    expect(h.delivered).toHaveLength(0)
    // Idempotent: asking again returns the same line.
    expect((await h.waits.waitFor(wait.id, 55_000))?.line).toContain('[Ready]')
  })

  it('a --block client counts for the lane lines it covers only while it is there', async () => {
    const h = harness()
    const event = { outcome: 'finished' as const, at: 0, agentAt: T0 + 1 }
    const heard = () => [...h.waits.heardFrom(LANE, '', [WAITER], event)]
    const { wait } = await h.arm({ waiter: null, by: WAITER })
    // Armed, but no client has asked yet: a dead client would swallow the line.
    expect(heard()).toEqual([])
    const attached = h.waits.waitFor(wait.id, 1_000)
    expect(heard()).toEqual([WAITER])
    await vi.advanceTimersByTimeAsync(1_100)
    await attached
    // Between long polls it still counts; two missed polls later it does not.
    expect(heard()).toEqual([WAITER])
    await vi.advanceTimersByTimeAsync(2 * LONG_POLL_MAX_SECONDS * 1000 + 1)
    expect(heard()).toEqual([])
    // Fired with no client there: nobody was told.
    h.set({ state: 'idle', stateAt: T0, stateAgentAt: T0 + 1 })
    await vi.advanceTimersByTimeAsync(SETTLE + 100)
    expect(new WaitStore(h.store.db).get(wait.id)?.state).toBe('fired')
    expect(heard()).toEqual([])
    // A client that comes back and is given the line heard it.
    expect((await h.waits.waitFor(wait.id, 55_000))?.state).toBe('fired')
    expect(heard()).toEqual([WAITER])
  })

  it('waitFor returns the armed wait when its time is up', async () => {
    const h = harness()
    const { wait } = await h.arm({ waiter: null })
    const answer = h.waits.waitFor(wait.id, 1_000)
    await vi.advanceTimersByTimeAsync(1_100)
    expect((await answer)?.state).toBe('armed')
  })

  it('a kept wait relaunches when ready, never for a timeout', async () => {
    const h = harness()
    const ready = await h.arm()
    const late = await h.arm({ until: 'idle', timeoutMinutes: 1 })
    const ended: EndedSession = {
      id: WAITER,
      tool: 'claude-code',
      projectId: null,
      projectRoot: '/tmp',
      name: null,
      origin: 'aico',
      coordinator: true,
      coordinatorId: null,
      resumeId: null,
    }
    expect(h.waits.keep(WAITER, ended)).toBe(2)
    removeWidget(WAITER)
    expect(h.waits.store.get(ready.wait.id)).toMatchObject({ waiter: null, kept: true })
    h.views.set(LANE, view({ state: 'working', stateAt: T0 }))
    await vi.advanceTimersByTimeAsync(60_000 + 100)
    expect(h.waits.store.get(late.wait.id)?.state).toBe('timed_out')
    expect(h.relaunched).toHaveLength(0)
    h.set({ state: 'idle', stateAt: Date.now(), stateAgentAt: Date.now() })
    await vi.advanceTimersByTimeAsync(SETTLE + 100)
    expect(h.relaunched).toEqual([{ ended, line: expect.stringContaining('[Ready]') }])
    expect(h.delivered).toHaveLength(0)
  })

  it("a waiter's waits go with it unless kept, and so do its sends", async () => {
    const h = harness()
    const { wait } = await h.arm()
    h.waits.store.recordSend(WAITER, LANE, T0)
    removeWidget(WAITER)
    expect(h.waits.store.get(wait.id)).toBeUndefined()
    expect(h.waits.store.lastSend(WAITER, LANE)).toBeNull()
  })

  it('prunes waits that are over after the keep window', async () => {
    const h = harness()
    const { wait } = await h.arm()
    h.waits.cancel(wait.id)
    vi.setSystemTime(T0 + DEFAULT_WAKE_POLICY.waitKeepDays * 24 * 3600_000 + 1)
    h.waits.check()
    expect(h.waits.store.get(wait.id)).toBeUndefined()
  })

  it('lists armed waits, then recent ones newest first', async () => {
    const h = harness()
    const a = await h.arm()
    const b = await h.arm({ until: 'idle' })
    h.waits.cancel(a.wait.id)
    expect(h.waits.list(WAITER, false).map((wait) => wait.id)).toEqual([b.wait.id])
    expect(h.waits.list(WAITER, true).map((wait) => wait.id)).toEqual([b.wait.id, a.wait.id])
  })

  it('poke looks at the waits on that session after the current stack', async () => {
    const h = harness()
    const { wait } = await h.arm({ until: 'ended' })
    h.views.set(LANE, null)
    h.waits.poke(LANE)
    expect(h.waits.store.get(wait.id)?.state).toBe('armed')
    await vi.advanceTimersByTimeAsync(1)
    expect(h.waits.store.get(wait.id)?.state).toBe('fired')
  })

  it('a session that already ended fires at arm, not unknown', async () => {
    const h = harness()
    h.ended.add('dddd0001')
    const { wait } = await h.arm({ ref: 'dddd0001', until: 'ended' })
    expect(wait).toMatchObject({ state: 'fired', outcome: 'until' })
    const gone = await h.arm({ ref: 'dddd0001', until: 'finished' })
    expect(gone.wait).toMatchObject({ state: 'fired', outcome: 'gone' })
    await expect(h.arm({ ref: 'eeee0001' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('prunes waits that are over even when nothing is armed', async () => {
    const h = harness()
    const { wait } = await h.arm()
    h.waits.cancel(wait.id)
    vi.setSystemTime(T0 + DEFAULT_WAKE_POLICY.waitKeepDays * 24 * 3600_000 + 1)
    await vi.advanceTimersByTimeAsync(3600_000 + 100)
    expect(h.waits.store.get(wait.id)).toBeUndefined()
  })
})

describe('cmd waits', () => {
  const cmdArm = (h: ReturnType<typeof harness>, argv: string[], extra = {}) =>
    h.arm({
      kind: 'cmd',
      ref: '',
      until: 'succeeded',
      cmd: { argv, cwd: '/srv/x' },
      ...extra,
    })

  it('records the command under a ref Tether makes, deadline included', async () => {
    const h = harness()
    const { wait } = await cmdArm(h, ['sleep', '20'], { timeoutMinutes: 10 })
    expect(wait).toMatchObject({ kind: 'cmd', state: 'armed', until: 'succeeded' })
    expect(wait.ref).toMatch(/^[0-9a-f]{12}$/)
    expect(h.cmds.get(wait.ref)).toEqual({
      argv: ['sleep', '20'],
      cwd: '/srv/x',
      deadline: wait.deadline,
    })
    expect(wait.deadline - wait.armedAt).toBe(600_000)
    expect(h.waits.waitingOn(WAITER)).toBe(`a wait on command aico-wait-${wait.ref} (succeeded)`)
  })

  it('exit 0 is ready; anything else is over as failed; the watcher is let go', async () => {
    const h = harness()
    const ok = await cmdArm(h, ['sleep', '20'], { note: 'build up' })
    h.pull('cmd', ok.wait.ref, { state: 'succeeded', detail: 'exit-0', title: 'sleep 20' })
    expect(h.delivered[0]?.line).toBe(
      `[Ready] command "sleep 20" (aico-wait-${ok.wait.ref}) succeeded · re: "build up" · journalctl --user -u aico-wait-${ok.wait.ref}`,
    )
    const bad = await cmdArm(h, ['false'])
    h.pull('cmd', bad.wait.ref, { state: 'failed', detail: 'exit-1', title: 'false' })
    expect(h.waits.store.get(bad.wait.id)).toMatchObject({ state: 'fired', outcome: 'gone' })
    expect(h.delivered[1]?.line).toBe(
      `[Wait over] command "false" (aico-wait-${bad.wait.ref}) failed (exit 1) · journalctl --user -u aico-wait-${bad.wait.ref}`,
    )
    const never = await cmdArm(h, ['nope'])
    h.pull('cmd', never.wait.ref, { state: 'failed', detail: 'start-failed', title: 'nope' })
    expect(h.delivered[2]?.line).toContain('could not start')
    expect(h.settled).toEqual([
      `cmd:${ok.wait.ref}`,
      `cmd:${bad.wait.ref}`,
      `cmd:${never.wait.ref}`,
    ])
  })

  it('a cancel or a timeout lets the watcher go; the full look sweeps the rest', async () => {
    const h = harness()
    const a = await cmdArm(h, ['sleep', '99'])
    h.waits.cancel(a.wait.id)
    expect(h.settled).toEqual([`cmd:${a.wait.ref}`])
    const b = await cmdArm(h, ['sleep', '99'], { timeoutMinutes: 1 })
    h.pulls.set(`cmd:${b.wait.ref}`, { state: 'running', detail: null, title: 'sleep 99' })
    vi.setSystemTime(T0 + 61_000)
    h.waits.check()
    expect(h.delivered[0]?.line).toBe(
      `[Wait timed out] command "sleep 99" (aico-wait-${b.wait.ref}) not finished after 1m: it is running · journalctl --user -u aico-wait-${b.wait.ref}`,
    )
    expect(h.settled).toContain(`cmd:${b.wait.ref}`)
    expect(h.swept.at(-1)).toEqual([])
    // systemd stopped the watcher at its runtime limit (Tether was down past
    // the deadline): the wait timed out, it did not fail.
    const c = await cmdArm(h, ['sleep', '99'], { timeoutMinutes: 1 })
    vi.setSystemTime(T0 + 200_000)
    h.pull('cmd', c.wait.ref, { state: 'failed', detail: 'timeout', title: 'sleep 99' })
    expect(h.waits.store.get(c.wait.id)).toMatchObject({ outcome: 'timeout' })
    expect(h.delivered.at(-1)?.line).toMatch(/^\[Wait timed out\] command "sleep 99"/)
  })

  it('a key returns the same command wait; another command conflicts', async () => {
    const h = harness()
    const first = await cmdArm(h, ['sleep', '20'], { key: 'build' })
    const again = await cmdArm(h, ['sleep', '20'], { key: 'build' })
    expect(again).toMatchObject({ created: false, wait: { id: first.wait.id } })
    expect(h.cmds.size).toBe(1)
    await expect(cmdArm(h, ['sleep', '21'], { key: 'build' })).rejects.toMatchObject({
      code: 'key_conflict',
    })
  })
})

describe('pull kinds', () => {
  const JOB = 'a'.repeat(32)
  const pullArm = (h: ReturnType<typeof harness>, kind: string, ref: string, until: string) =>
    h.arm({ kind: kind as Wait['kind'], ref, until })

  it('a job wait takes an id prefix, fires once on its final state', async () => {
    const h = harness()
    h.pulls.set(`job:${JOB}`, { state: 'running', detail: null, title: 'aico' })
    const { wait } = await pullArm(h, 'job', JOB.slice(0, 8), 'done')
    expect(wait).toMatchObject({ ref: JOB, state: 'armed' })
    h.pull('job', JOB, { state: 'failed', detail: '2', title: 'aico' })
    expect(h.delivered).toEqual([
      {
        to: WAITER,
        source: `wait:${wait.id}`,
        line: `[Ready] service job aaaaaaaa (aico) failed (exit 2) · st service result ${JOB}`,
      },
    ])
    h.pull('job', JOB, { state: 'failed', detail: '2', title: 'aico' })
    expect(h.delivered).toHaveLength(1)
  })

  it('refuses a ref its owner does not know, and a bad until', async () => {
    const h = harness()
    await expect(pullArm(h, 'job', JOB, 'done')).rejects.toMatchObject({ code: 'not_found' })
    h.pulls.set('reply:abc123', null)
    await expect(pullArm(h, 'reply', 'abc123', 'acked')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('a reply wait fires on an answer; closed without one is gone', async () => {
    const h = harness()
    h.pulls.set('reply:abc123', { state: 'open', detail: null, title: 'cc:1c7a9f' })
    const a = await pullArm(h, 'reply', 'abc123', 'acked')
    h.pull('reply', 'abc123', { state: 'acked', detail: 'yes', title: 'cc:1c7a9f' })
    expect(h.delivered[0]?.line).toBe(
      '[Ready] request abc123 to cc:1c7a9f answered: yes · st sessions inbox',
    )
    h.pulls.set('reply:def456', { state: 'open', detail: null, title: 'cc:1' })
    const b = await pullArm(h, 'reply', 'def456', 'acked')
    h.pull('reply', 'def456', { state: 'closed', detail: null, title: 'cc:1' })
    expect(h.waits.store.get(b.wait.id)?.outcome).toBe('gone')
    expect(h.waits.store.get(a.wait.id)?.outcome).toBe('until')
  })

  it("a reply line names the recipient's window, an ask line its question", async () => {
    const h = harness()
    const title = 'SummitFlow — One wake per message (cc:94bdf3)'
    h.pulls.set('reply:abc123', { state: 'open', detail: null, title })
    await pullArm(h, 'reply', 'abc123', 'acked')
    h.pull('reply', 'abc123', { state: 'acked', detail: 'yes', title })
    const ask = 'c'.repeat(12)
    h.pulls.set(`ask:${ask}`, { state: 'open', detail: null, title: 'Rebuild aico now?' })
    await pullArm(h, 'ask', ask, 'answered')
    h.pull('ask', ask, { state: 'answered', detail: null, title: 'Rebuild aico now?' })
    expect(h.delivered.map((d) => d.line)).toEqual([
      `[Ready] request abc123 to ${title} answered: yes · st sessions inbox`,
      `[Ready] ask "Rebuild aico now?" (${ask}) answered · tether ask get ${ask}`,
    ])
  })

  it('a tap not taken in yet arms and waits; a timeout says so', async () => {
    const h = harness()
    const TAP = 'b'.repeat(32)
    h.pulls.set(`tap:${TAP}`, undefined)
    const { wait } = await h.arm({ kind: 'tap', ref: TAP, until: 'decided', timeoutMinutes: 1 })
    expect(wait.state).toBe('armed')
    vi.setSystemTime(T0 + 61_000)
    h.waits.check()
    expect(h.delivered[0]?.line).toBe(
      '[Wait timed out] tap bbbbbbbb not decided after 1m · nightshift pending',
    )
  })

  it('an ask answered to the waiter itself fires without a second line', async () => {
    const h = harness()
    const ASK = 'c'.repeat(12)
    h.pulls.set(`ask:${ASK}`, { state: 'open', detail: null, title: null })
    const { wait } = await pullArm(h, 'ask', ASK, 'answered')
    h.told.add(wait.id)
    h.pull('ask', ASK, { state: 'answered', detail: null, title: null })
    expect(h.waits.store.get(wait.id)).toMatchObject({ state: 'fired', outcome: 'until' })
    expect(h.delivered).toEqual([])
  })

  it('a run that ends without needing the owner is gone for needs-you', async () => {
    const h = harness()
    h.pulls.set('run:run-1', { state: 'running', detail: null, title: null })
    const { wait } = await pullArm(h, 'run', 'run-1', 'needs-you')
    h.pull('run', 'run-1', { state: 'succeeded', detail: null, title: null })
    expect(h.waits.store.get(wait.id)?.line).toBe(
      '[Wait over] workflow run run-1 ended without needing the owner: succeeded · st workflow get run-1',
    )
  })

  it('a nudge re-reads the waits of that kind and ref at once, forcing the probe', async () => {
    const h = harness()
    h.pulls.set(`job:${JOB}`, { state: 'running', detail: null, title: null })
    const { wait } = await pullArm(h, 'job', JOB, 'done')
    h.pulls.set(`job:${JOB}`, { state: 'succeeded', detail: '0', title: null })
    expect(h.waits.nudge('job', JOB)).toBe(1)
    expect(h.refreshed).toContain(`job:${JOB}:true`)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.waits.store.get(wait.id)?.outcome).toBe('until')
    expect(h.waits.nudge('job', JOB)).toBe(0)
  })

  it('waitingOn names the kind and the ref', async () => {
    const h = harness()
    h.pulls.set('host:gem', { state: 'offline', detail: null, title: null })
    await pullArm(h, 'host', 'gem', 'connected')
    expect(h.waits.waitingOn(WAITER)).toBe('a wait on host gem (connected)')
  })
})
