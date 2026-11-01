import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LaneReporter,
  type LaneReportOperations,
  LaneReportStore,
  type LaneView,
  type LocalLineage,
  laneLine,
  laneTitle,
  laneView,
  WatchRefused,
} from './lane-reports'
import {
  adoptLineage,
  bindCatalog,
  clearLaunched,
  getWidget,
  insertWidget,
  removeWidget,
  setCoordinator,
} from './lifecycle/catalog'
import { Store } from './store'
import { composeDelivery, DEFAULT_WAKE_POLICY, type Wake, WakeStore } from './wakes'

const ROOT = 'aaaa0001'
const HELPER_PARENT = 'aaaa0002'
const LANE = 'bbbb0001'
const WATCHER = 'cccc0001'
const SHELL = 'dddd0001'
const SETTLE = DEFAULT_WAKE_POLICY.laneSettleSeconds * 1000

const stores: Store[] = []
const reporters: LaneReporter[] = []
afterEach(() => {
  for (const reporter of reporters.splice(0)) reporter.stop()
  for (const store of stores.splice(0)) store.close()
  vi.useRealTimers()
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})

function view(overrides: Partial<LaneView> = {}): LaneView {
  return {
    id: LANE,
    host: null,
    generation: 'g1',
    state: 'idle',
    stateAt: Date.now(),
    stateDetail: null,
    stateAgentAt: 0,
    statePrevious: 'idle',
    createdAt: 0,
    coordinatorId: ROOT,
    parentId: ROOT,
    launched: true,
    title: 'TEST',
    requestId: null,
    waitingOn: null,
    ...overrides,
  }
}

function harness(options: { store?: Store; sessions?: LocalLineage[] } = {}) {
  const store = options.store ?? new Store(':memory:', () => 1_000)
  if (!options.store) stores.push(store)
  bindCatalog(store.db)
  const delivered: { to: string; source: string; line: string }[] = []
  const logs: string[] = []
  const receivers = new Set([ROOT, HELPER_PARENT, LANE, WATCHER])
  const gone = new Set<string>()
  const sessions = options.sessions ?? []
  const ops: LaneReportOperations = {
    now: () => Date.now(),
    policy: () => DEFAULT_WAKE_POLICY,
    receiver: (id) => receivers.has(id),
    sessions: () => sessions,
    deliver: (to, source, line) => delivered.push({ to, source, line }),
    agentGone: (id) => gone.has(id),
    log: (line) => logs.push(line),
  }
  const reporter = new LaneReporter(new LaneReportStore(store.db), ops)
  reporters.push(reporter)
  return { store, reporter, delivered, logs, receivers, gone, sessions }
}

/** Observe, then let `ms` pass (timers fire). */
function step(reporter: LaneReporter, next: Partial<LaneView>, ms = 0): void {
  reporter.observe(view(next))
  vi.advanceTimersByTime(ms)
}

describe('lane lines', () => {
  it('names the lane, never reply text, and points at status', () => {
    const lane = {
      id: LANE,
      host: null,
      title: 'Store lane',
      requestId: 'neri-r1',
      coordinatorId: ROOT,
      parentId: ROOT,
      launched: true,
    }
    expect(laneLine('finished', lane, { minutes: 4 })).toBe(
      '[Ready] lane "Store lane" (req neri-r1) went idle after 4m · st aico root status neri-r1',
    )
    expect(laneLine('blocked', { ...lane, requestId: null }, { detail: 'permission prompt' })).toBe(
      `[Ready] lane "Store lane" is blocked: permission prompt · st aico widget status --widget-id ${LANE}`,
    )
    expect(laneLine('ended', { ...lane, host: 'neri-vm' }, { exited: true })).toContain(
      'lane "Store lane" on neri-vm (req neri-r1) ended (its agent exited)',
    )
  })

  it('strips what could break out of the line or start a command', () => {
    expect(laneTitle('/clear "x" [y] `z`‮\nnext')).toBe('clear x y z next')
    expect(laneTitle('!rm')).toBe('rm')
    expect(laneTitle('')).toBe('untitled')
    expect(Array.from(laneTitle('x'.repeat(200)))).toHaveLength(60)
  })

  it('reads a descriptor and rejects what is not a session', () => {
    expect(laneView({ id: 'nope', generation: 'g' }, null)).toBeNull()
    const parsed = laneView(
      {
        id: LANE,
        generation: 'g',
        state: 'idle',
        stateAgentAt: 5,
        coordinatorId: ROOT,
        parentId: 'bad',
        launched: true,
        displayTitle: 'T',
        rootRequestId: 'r1',
        waitingOn: null,
      },
      'vm',
    )
    expect(parsed).toMatchObject({ host: 'vm', parentId: null, launched: true, title: 'T' })
  })
})

describe('finished', () => {
  it('reports a turn too short for the poll, once, after the settle', () => {
    const { reporter, delivered } = harness()
    step(reporter, { stateAgentAt: 100 }) // first sighting: absorbed
    step(reporter, { stateAgentAt: 200 }, SETTLE - 1)
    expect(delivered).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(delivered).toEqual([
      {
        to: ROOT,
        source: `lane:${LANE}:finished`,
        line: expect.stringContaining('lane "TEST" went idle'),
      },
    ])
    step(reporter, { stateAgentAt: 200 }, SETTLE * 2)
    expect(delivered).toHaveLength(1)
  })

  it('says how long the turn ran, and an idle that ends within the settle is not a finish', () => {
    const { reporter, delivered } = harness()
    step(reporter, { state: 'working', stateAgentAt: 100 }, 5 * 60_000)
    step(reporter, { stateAgentAt: 200 }, SETTLE / 2)
    step(reporter, { state: 'working', stateAgentAt: 300 }, 60_000)
    expect(delivered).toHaveLength(0)
    step(reporter, { stateAgentAt: 400 }, SETTLE)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.line).toContain('went idle after 6m')
  })

  it('a restart neither repeats a finish nor loses one that happened while down', () => {
    const first = harness()
    step(first.reporter, { state: 'working', stateAgentAt: 100 })
    step(first.reporter, { stateAgentAt: 200 }, SETTLE)
    expect(first.delivered).toHaveLength(1)
    first.reporter.stop()
    const again = harness({ store: first.store })
    step(again.reporter, { stateAgentAt: 200 }, SETTLE * 2)
    expect(again.delivered).toHaveLength(0)
    vi.advanceTimersByTime(DEFAULT_WAKE_POLICY.laneFinishedFloorSeconds * 1000)
    step(again.reporter, { stateAgentAt: 300 }, SETTLE)
    expect(again.delivered).toHaveLength(1)
  })

  it('a new generation (recovery, respawn) resets quietly', () => {
    const { reporter, delivered } = harness()
    step(reporter, { state: 'working', stateAgentAt: 100 })
    step(reporter, { generation: 'g2', stateAgentAt: 200 }, SETTLE * 2)
    expect(delivered).toHaveLength(0)
    step(reporter, { generation: 'g2', state: 'working', stateAgentAt: 300 })
    step(reporter, { generation: 'g2', stateAgentAt: 400 }, SETTLE)
    expect(delivered).toHaveLength(1)
  })

  it('a lane that waits on a check-in of its own is not finished', () => {
    const { reporter, delivered } = harness()
    step(reporter, { state: 'working', stateAgentAt: 100 })
    step(reporter, { stateAgentAt: 200, waitingOn: 'a check-in at 14:00' }, SETTLE * 2)
    expect(delivered).toHaveLength(0)
  })

  it('holds a second finish to the floor and folds later ones into it', () => {
    const { reporter, delivered } = harness()
    const floor = DEFAULT_WAKE_POLICY.laneFinishedFloorSeconds * 1000
    step(reporter, { state: 'working', stateAgentAt: 100 })
    step(reporter, { stateAgentAt: 200 }, SETTLE)
    expect(delivered).toHaveLength(1)
    step(reporter, { state: 'working', stateAgentAt: 300 })
    step(reporter, { stateAgentAt: 400 }, SETTLE)
    step(reporter, { state: 'working', stateAgentAt: 500 })
    step(reporter, { stateAgentAt: 600 }, SETTLE)
    expect(delivered).toHaveLength(1)
    vi.advanceTimersByTime(floor)
    expect(delivered).toHaveLength(2)
    vi.advanceTimersByTime(floor * 2)
    expect(delivered).toHaveLength(2)
  })

  it('goes to the launcher, or the root when the launcher cannot take it', () => {
    const { reporter, delivered, receivers } = harness()
    step(reporter, { parentId: HELPER_PARENT, state: 'working', stateAgentAt: 100 })
    step(reporter, { parentId: HELPER_PARENT, stateAgentAt: 200 }, SETTLE)
    expect(delivered.map((d) => d.to)).toEqual([HELPER_PARENT])
    receivers.delete(HELPER_PARENT)
    vi.advanceTimersByTime(DEFAULT_WAKE_POLICY.laneFinishedFloorSeconds * 1000)
    step(reporter, { parentId: HELPER_PARENT, state: 'working', stateAgentAt: 300 })
    step(reporter, { parentId: HELPER_PARENT, stateAgentAt: 400 }, SETTLE)
    expect(delivered.map((d) => d.to)).toEqual([HELPER_PARENT, ROOT])
  })

  it('a remote helper whose launcher is on its own host is not the root’s to hear', () => {
    const { reporter, delivered } = harness()
    const remote = { host: 'neri-vm', parentId: 'eeee0001' }
    step(reporter, { ...remote, state: 'working', stateAgentAt: 100 })
    step(reporter, { ...remote, stateAgentAt: 200 }, SETTLE)
    expect(delivered).toEqual([])
  })

  it('a lane launched while Tether runs reports a first turn the poll never saw working', () => {
    const { reporter, delivered } = harness()
    const createdAt = Date.now()
    step(reporter, { createdAt, generation: 'g0', state: 'unknown' })
    step(reporter, { createdAt, generation: 'g1', state: 'unknown' }) // the launch's own
    step(reporter, { createdAt, generation: 'g1', stateAgentAt: createdAt + 5_000 }, SETTLE)
    expect(delivered.map((d) => d.source)).toEqual([`lane:${LANE}:finished`])
  })

  it('closing a dialog the owner opened is not a finished turn', () => {
    const { reporter, delivered } = harness()
    step(reporter, { stateAgentAt: 100 })
    step(reporter, { state: 'blocked', stateDetail: 'dialog open', stateAgentAt: 200 }, 5_000)
    step(reporter, { stateAgentAt: 300 }, SETTLE * 2)
    expect(delivered).toEqual([])
  })

  it('lineage an owner set (not launched) reports nothing', () => {
    const { reporter, delivered } = harness()
    step(reporter, { launched: false, state: 'working', stateAgentAt: 100 })
    step(reporter, { launched: false, stateAgentAt: 200 }, SETTLE * 2)
    expect(delivered).toHaveLength(0)
  })
})

describe('blocked', () => {
  it('reports a held permission prompt to the root and the launcher, once', () => {
    const { reporter, delivered } = harness()
    const at = Date.now()
    step(reporter, {
      parentId: HELPER_PARENT,
      state: 'blocked',
      stateDetail: 'permission prompt',
      stateAt: at,
    })
    vi.advanceTimersByTime(DEFAULT_WAKE_POLICY.laneBlockedSeconds * 1000)
    expect(delivered.map((d) => d.to).sort()).toEqual([ROOT, HELPER_PARENT].sort())
    expect(delivered[0]?.line).toContain('is blocked: permission prompt')
    step(
      reporter,
      { parentId: HELPER_PARENT, state: 'blocked', stateDetail: 'permission prompt', stateAt: at },
      60_000,
    )
    expect(delivered).toHaveLength(2)
  })

  it('the same prompt seen again after a Tether restart is not reported twice', () => {
    const first = harness()
    const blocked = { state: 'blocked' as const, stateDetail: 'input needed', stateAt: Date.now() }
    step(first.reporter, { ...blocked, statePrevious: 'working' }, 5_000)
    expect(first.delivered).toHaveLength(1)
    first.reporter.stop()
    const again = harness({ store: first.store })
    step(again.reporter, { ...blocked, statePrevious: 'unknown', stateAt: Date.now() }, 60_000)
    expect(again.delivered).toHaveLength(0)
    step(again.reporter, { state: 'working', stateAgentAt: 500 })
    step(again.reporter, { ...blocked, statePrevious: 'working', stateAt: Date.now() }, 5_000)
    expect(again.delivered).toHaveLength(1)
  })

  it('ignores dialog open and a prompt answered within the hold', () => {
    const { reporter, delivered } = harness()
    step(reporter, { state: 'blocked', stateDetail: 'dialog open' }, 60_000)
    step(reporter, { state: 'blocked', stateDetail: 'input needed', stateAt: Date.now() }, 1_000)
    step(reporter, { state: 'working', stateAgentAt: 100 }, 60_000)
    expect(delivered).toHaveLength(0)
  })
})

describe('ended', () => {
  it('the delete trigger records a launched lane and the reporter sends it once', () => {
    const { reporter, delivered, store } = harness()
    insertWidget(ROOT, 'claude-code', 1_000)
    insertWidget(LANE, 'claude-code', 1_000)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: ROOT })
    step(reporter, { title: 'Lane title' })
    removeWidget(LANE)
    expect(new LaneReportStore(store.db).outbox()).toHaveLength(1)
    reporter.drainOutbox()
    reporter.drainOutbox()
    expect(delivered).toEqual([
      {
        to: ROOT,
        source: `lane:${LANE}:ended`,
        line: expect.stringContaining('lane "Lane title" ended'),
      },
    ])
    expect(new LaneReportStore(store.db).get('', LANE)).toBeUndefined()
  })

  it('a session nobody launched leaves nothing in the outbox', () => {
    const { store } = harness()
    insertWidget(LANE, 'claude-code', 1_000)
    removeWidget(LANE)
    expect(new LaneReportStore(store.db).outbox()).toHaveLength(0)
  })

  it('an agent that left for the shell ends the lane once, and the later delete adds nothing', () => {
    const { reporter, delivered, gone } = harness()
    insertWidget(ROOT, 'claude-code', 1_000)
    insertWidget(LANE, 'claude-code', 1_000)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: ROOT })
    step(reporter, { state: 'working', stateAgentAt: 100 })
    gone.add(LANE)
    step(reporter, { state: 'unknown', stateAgentAt: 100 }, SETTLE)
    expect(delivered.map((d) => d.line)).toEqual([
      expect.stringContaining('ended (its agent exited)'),
    ])
    step(reporter, { stateAgentAt: 900 }, SETTLE)
    removeWidget(LANE)
    reporter.drainOutbox()
    expect(delivered).toHaveLength(1)
  })

  it('a lane that stopped being reported leaves no cursor behind when it ends', () => {
    const { reporter, store } = harness()
    insertWidget(LANE, 'claude-code', 1_000)
    step(reporter, { state: 'working', stateAgentAt: 100 })
    step(reporter, { launched: false, state: 'working', stateAgentAt: 100 })
    removeWidget(LANE)
    reporter.drainOutbox()
    expect(new LaneReportStore(store.db).cursors()).toEqual([])
  })

  it('an agent that comes back in the same session reports again', () => {
    const { reporter, delivered, gone } = harness()
    step(reporter, { state: 'working', stateAgentAt: 100 })
    gone.add(LANE)
    step(reporter, { state: 'unknown', stateAgentAt: 100 }, SETTLE)
    gone.delete(LANE)
    step(reporter, { state: 'idle', stateAgentAt: 200 }, SETTLE) // resumed: absorbed
    step(reporter, { state: 'working', stateAgentAt: 300 })
    step(reporter, { state: 'idle', stateAgentAt: 400 }, SETTLE)
    expect(delivered.map((d) => d.source)).toEqual([`lane:${LANE}:ended`, `lane:${LANE}:finished`])
  })

  it('the session that ended the lane gets no ended line; everyone else still does', () => {
    const { reporter, delivered, logs, store } = harness()
    insertWidget(ROOT, 'claude-code', 1_000)
    insertWidget(HELPER_PARENT, 'claude-code', 1_000)
    insertWidget(WATCHER, 'claude-code', 1_000)
    insertWidget(LANE, 'claude-code', 1_000)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: HELPER_PARENT })
    step(reporter, { parentId: HELPER_PARENT, title: 'Lane title' })
    reporter.setWatch(WATCHER, LANE, 'watch')
    const lanes = new LaneReportStore(store.db)
    // The launcher ends it (`st aico root end` from HELPER_PARENT).
    expect(lanes.markEnd(LANE, HELPER_PARENT, Date.now())).toBe(true)
    expect(lanes.markEnd(LANE, ROOT, Date.now())).toBe(false) // another End's mark stays
    removeWidget(LANE)
    lanes.unmarkEnd(LANE)
    expect(lanes.outbox()).toMatchObject([{ lane: LANE, endedBy: HELPER_PARENT }])
    reporter.drainOutbox()
    // Its launcher ended it: the root hears nothing either; the explicit watcher does.
    expect(delivered.map((d) => d.to)).toEqual([WATCHER])
    expect(logs).toContain(
      `lane=${LANE} ended -> ${WATCHER} (skipped ${ROOT},${HELPER_PARENT}: ended by its launcher ${HELPER_PARENT})`,
    )
    expect(store.db.prepare('SELECT * FROM session_end_requests').all()).toEqual([])
  })

  it('the root ending a helper someone else launched still tells that launcher', () => {
    const { reporter, delivered, logs, store } = harness()
    insertWidget(ROOT, 'claude-code', 1_000)
    insertWidget(HELPER_PARENT, 'claude-code', 1_000)
    insertWidget(LANE, 'claude-code', 1_000)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: HELPER_PARENT })
    step(reporter, { parentId: HELPER_PARENT })
    const lanes = new LaneReportStore(store.db)
    lanes.markEnd(LANE, ROOT, Date.now())
    removeWidget(LANE)
    lanes.unmarkEnd(LANE)
    reporter.drainOutbox()
    expect(delivered.map((d) => d.to)).toEqual([HELPER_PARENT])
    expect(logs).toContain(
      `lane=${LANE} ended -> ${HELPER_PARENT} (skipped ${ROOT}: ended by ${ROOT})`,
    )
  })

  it('a launcher ending its helper spares the root; its exit still reaches both', () => {
    const { reporter, delivered, gone } = harness()
    step(reporter, { parentId: HELPER_PARENT, state: 'working', stateAgentAt: 100 })
    gone.add(LANE)
    step(reporter, { parentId: HELPER_PARENT, state: 'unknown', stateAgentAt: 100 }, SETTLE)
    expect(delivered.map((d) => d.to).sort()).toEqual([ROOT, HELPER_PARENT])
  })

  it('a coordinator ending its only lane hears nothing, and the log names the skip', () => {
    const { reporter, delivered, logs, store } = harness()
    insertWidget(ROOT, 'claude-code', 1_000)
    insertWidget(LANE, 'claude-code', 1_000)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: ROOT })
    step(reporter, { title: 'Lane title' })
    const lanes = new LaneReportStore(store.db)
    lanes.markEnd(LANE, ROOT, Date.now())
    removeWidget(LANE)
    lanes.unmarkEnd(LANE)
    reporter.drainOutbox()
    expect(delivered).toEqual([])
    expect(logs).toContain(
      `lane=${LANE} ended: no receiver (skipped ${ROOT}: ended by its launcher ${ROOT})`,
    )
    expect(lanes.get('', LANE)).toBeUndefined()
    expect(lanes.outbox()).toEqual([])
  })

  it('an End that did not happen, an unknown ender, or a crash leaves today’s ended', () => {
    const { reporter, delivered, store } = harness()
    insertWidget(ROOT, 'claude-code', 1_000)
    insertWidget(LANE, 'claude-code', 1_000)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: ROOT })
    step(reporter, {})
    const lanes = new LaneReportStore(store.db)
    // A refused End took its mark back; the owner then closes the lane.
    lanes.markEnd(LANE, ROOT, Date.now())
    lanes.unmarkEnd(LANE)
    removeWidget(LANE)
    reporter.drainOutbox()
    expect(delivered.map((d) => d.to)).toEqual([ROOT])

    // An ender that is no receiver changes nothing.
    insertWidget(LANE, 'claude-code', 1_000)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: ROOT })
    lanes.markEnd(LANE, 'eeee0001', Date.now())
    removeWidget(LANE)
    lanes.unmarkEnd(LANE)
    reporter.drainOutbox()
    expect(delivered.map((d) => d.to)).toEqual([ROOT, ROOT])

    // A mark a crash left behind is gone once Tether starts again.
    insertWidget(LANE, 'claude-code', 1_000)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: ROOT })
    lanes.markEnd(LANE, ROOT, Date.now())
    reporter.stop()
    const restarted = harness({ store }).reporter
    removeWidget(LANE)
    restarted.drainOutbox()
    expect(lanes.outbox()).toEqual([])
    expect(store.db.prepare('SELECT * FROM session_end_requests').all()).toEqual([])
  })

  it('an outbox row from before v24 (no ended_by) reports as before', () => {
    const { reporter, delivered, store } = harness()
    store.db
      .prepare(
        `INSERT INTO lane_outbox (lane, at, coordinator_id, parent_id, launched, title, request_id)
         VALUES (?, 1, ?, ?, 1, 'Old row', NULL)`,
      )
      .run(LANE, ROOT, HELPER_PARENT)
    expect(new LaneReportStore(store.db).outbox()).toMatchObject([{ endedBy: null }])
    reporter.drainOutbox()
    expect(delivered.map((d) => d.to).sort()).toEqual([ROOT, HELPER_PARENT])
  })

  it('a relayed lane ends once on the hub', () => {
    const { reporter, delivered } = harness()
    step(reporter, { host: 'neri-vm', title: 'Remote' })
    reporter.ended(LANE, 'neri-vm')
    reporter.ended(LANE, 'neri-vm')
    expect(delivered).toEqual([
      {
        to: ROOT,
        source: `lane:neri-vm/${LANE}:ended`,
        line: expect.stringContaining('lane "Remote" on neri-vm ended'),
      },
    ])
  })
})

describe('watch and unwatch', () => {
  it('a watch adds a receiver, an unwatch removes a lineage one', () => {
    const sessions: LocalLineage[] = [
      { id: LANE, coordinatorId: ROOT, parentId: ROOT, launched: true },
    ]
    const { reporter, delivered } = harness({ sessions })
    expect(reporter.setWatch(WATCHER, LANE, 'watch')).toBe('watch')
    expect(reporter.setWatch(ROOT, LANE, 'watch')).toBe('lineage')
    expect(reporter.setWatch(ROOT, LANE, 'unwatch')).toBe('none')
    step(reporter, { state: 'working', stateAgentAt: 100 })
    step(reporter, { stateAgentAt: 200 }, SETTLE)
    expect(delivered.map((d) => d.to)).toEqual([WATCHER])
    expect(reporter.watchesOf(ROOT)).toMatchObject([{ lane: LANE, mode: 'unwatch' }])
    expect(reporter.setWatch(ROOT, LANE, 'watch')).toBe('lineage')
    expect(reporter.watchesOf(ROOT)).toEqual([])
  })

  it('a root watching a helper adds its finished; unwatching it drops blocked and ended', () => {
    const sessions: LocalLineage[] = [
      { id: LANE, coordinatorId: ROOT, parentId: HELPER_PARENT, launched: true },
    ]
    const { reporter } = harness({ sessions })
    expect(reporter.setWatch(ROOT, LANE, 'watch')).toBe('watch')
    expect(reporter.setWatch(HELPER_PARENT, LANE, 'watch')).toBe('lineage')
    expect(reporter.setWatch(ROOT, LANE, 'unwatch')).toBe('none')
    expect(reporter.watchesOf(ROOT)).toMatchObject([{ lane: LANE, mode: 'unwatch' }])
  })

  it('a watch makes a lane nobody launched report', () => {
    const { reporter, delivered } = harness()
    reporter.setWatch(WATCHER, LANE, 'watch')
    step(reporter, {
      launched: false,
      coordinatorId: null,
      parentId: null,
      state: 'working',
      stateAgentAt: 100,
    })
    step(
      reporter,
      { launched: false, coordinatorId: null, parentId: null, stateAgentAt: 200 },
      SETTLE,
    )
    expect(delivered.map((d) => d.to)).toEqual([WATCHER])
  })

  it('refuses watching yourself and closing a cycle', () => {
    const sessions: LocalLineage[] = [
      { id: LANE, coordinatorId: ROOT, parentId: ROOT, launched: true },
    ]
    const { reporter } = harness({ sessions })
    expect(() => reporter.setWatch(LANE, LANE, 'watch')).toThrow(WatchRefused)
    // LANE reports to ROOT; ROOT watched by LANE would close ROOT -> LANE -> ROOT.
    expect(() => reporter.setWatch(LANE, ROOT, 'watch')).toThrow(/watch_cycle/)
    reporter.setWatch(WATCHER, LANE, 'watch')
    expect(() => reporter.setWatch(LANE, WATCHER, 'watch')).toThrow(/watch_cycle/)
  })

  it('a non-agent session never receives', () => {
    const { reporter, delivered } = harness()
    reporter.setWatch(SHELL, LANE, 'watch')
    step(reporter, { state: 'working', stateAgentAt: 100 })
    step(reporter, { stateAgentAt: 200 }, SETTLE)
    expect(delivered.map((d) => d.to)).toEqual([ROOT])
  })

  it('a watcher that ends takes its watches with it', () => {
    const { store, reporter } = harness()
    insertWidget(WATCHER, 'claude-code', 1_000)
    reporter.setWatch(WATCHER, LANE, 'watch')
    removeWidget(WATCHER)
    expect(new LaneReportStore(store.db).watches()).toEqual([])
  })
})

describe('launched flag', () => {
  it('a launch sets it; a coordinator mark or an owner join clears it', () => {
    harness()
    insertWidget(ROOT, 'claude-code', 1_000)
    insertWidget(LANE, 'claude-code', 1_000)
    expect(getWidget(LANE)?.launched).toBe(false)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: ROOT })
    expect(getWidget(LANE)?.launched).toBe(true)
    clearLaunched(LANE)
    expect(getWidget(LANE)?.launched).toBe(false)
    adoptLineage(LANE, { coordinatorId: ROOT, coordinatorColor: null, parentId: ROOT })
    setCoordinator(LANE, true)
    expect(getWidget(LANE)?.launched).toBe(false)
  })
})

describe('delivery rows', () => {
  function wakeStore() {
    const store = new Store(':memory:', () => 1_000)
    stores.push(store)
    bindCatalog(store.db)
    insertWidget(ROOT, 'claude-code', 1_000)
    let n = 0
    return new WakeStore(store.db, () => `${++n}`.padStart(12, '0'))
  }

  it('event lines coalesce by source and never count as check-ins', () => {
    const wakes = wakeStore()
    wakes.add({ sessionId: ROOT, dueAt: 5_000, note: 'check', createdBy: 'agent', now: 0 })
    wakes.addEvent({ sessionId: ROOT, source: 'lane:x:finished', note: 'one', now: 1 })
    wakes.addEvent({ sessionId: ROOT, source: 'lane:x:finished', note: 'two', now: 2 })
    wakes.addEvent({ sessionId: ROOT, source: 'lane:x:blocked', note: 'three', now: 3 })
    expect(wakes.checkIns(ROOT).map((w) => w.note)).toEqual(['check'])
    expect(
      wakes
        .list()
        .filter((w) => w.kind === 'event')
        .map((w) => w.note),
    ).toEqual(['two', 'three'])
  })

  it('a failed paste does not bring back a line a newer one replaced', () => {
    const wakes = wakeStore()
    const old = wakes.addEvent({ sessionId: ROOT, source: 'lane:x:finished', note: 'old', now: 1 })
    wakes.remove(old.id)
    wakes.addEvent({ sessionId: ROOT, source: 'lane:x:finished', note: 'new', now: 2 })
    wakes.restore(old)
    expect(wakes.list().map((w) => w.note)).toEqual(['new'])
  })

  const row = (note: string, kind: 'time' | 'event', dueAt = 0): Wake =>
    ({ id: note.slice(0, 12), sessionId: ROOT, dueAt, note, kind, source: null }) as unknown as Wake

  it('composes one line under the byte budget, events first, the rest left queued', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(`${n}${'x'.repeat(499)}`, 'time'))
    const out = composeDelivery([...rows, row('lane event', 'event')], 0, DEFAULT_WAKE_POLICY)
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(1800)
    expect(out.text.startsWith('lane event / [Scheduled check-in')).toBe(true)
    expect(out.taken.length).toBeGreaterThan(1)
    expect(out.taken.length).toBeLessThan(6)
    expect(out.text).not.toContain('\n')
  })

  it('an oversized first row is cut to fit, so it cannot wedge the queue', () => {
    const out = composeDelivery([row('é'.repeat(3000), 'event')], 0, DEFAULT_WAKE_POLICY)
    expect(out.taken).toHaveLength(1)
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(1800)
  })
})
