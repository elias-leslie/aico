// Synthetic catalog and lifecycle receipts only: no native agent or hunt is touched.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type AskDelivery, AskStore, handOffAsks, transferAskNotices } from './asks'
import { callSocket } from './client'
import { resolvePaths, type TetherPaths } from './config'
import { type RunningDaemon, startDaemon } from './daemon'
import {
  getWidget,
  insertWidget,
  recordLauncher,
  setCoordinator,
  setWidgetOwnership,
} from './lifecycle/catalog'
import * as engine from './lifecycle/engine'
import { generationOf } from './lifecycle-api'

vi.mock('./lifecycle/engine', async (original) => ({
  ...(await original<typeof import('./lifecycle/engine')>()),
  rootManagedGateState: vi.fn(async () => 'active-workload'),
  verifySessionStatus: vi.fn(async () => 'running'),
  ensureSessionSerialized: vi.fn(),
  respawnAndRelaunch: vi.fn(),
  endSession: vi.fn(),
  loadTui: vi.fn(),
  switchProject: vi.fn(),
}))

const OLD = 'aa000001',
  NEXT = 'aa000002',
  LANE = 'bb000001',
  CHILD = 'bb000002',
  OTHER = 'bb000003'
let dir: string, paths: TetherPaths, daemon: RunningDaemon
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-transfer-'))
  paths = resolvePaths({
    instance: 'test',
    env: {
      HOME: dir,
      TETHER_STATE_DIR: join(dir, 'state'),
      TETHER_RUNTIME_DIR: join(dir, 'run'),
      XDG_CONFIG_HOME: join(dir, 'config'),
    },
  })
  daemon = await startDaemon(paths, {
    TETHER_RECONCILE: 'off',
    TETHER_SUMMITFLOW_URL: 'off',
    AICO_TASKS_DB: '/nonexistent/tasks.db',
    HOME: '/nonexistent',
  })
  await daemon.ready
  for (const id of [OLD, NEXT, LANE, CHILD, OTHER]) {
    insertWidget(id, id === LANE ? 'pi' : 'codex')
    setWidgetOwnership(id, `synthetic-${id}.scope`, 1, `invocation-${id}`, '$1', '%1')
    daemon.store.db
      .prepare("UPDATE sessions SET launch_state = 'dispatched', launch_nonce = ? WHERE id = ?")
      .run(id, id)
  }
  recordLauncher(LANE, OLD)
  recordLauncher(CHILD, LANE)
  recordLauncher(OTHER, OLD)
  setCoordinator(NEXT, true)
  vi.clearAllMocks()
})
afterEach(async () => {
  await daemon.close()
  rmSync(dir, { recursive: true, force: true })
  vi.mocked(engine.rootManagedGateState).mockResolvedValue('active-workload')
})
const row = (id: string) => getWidget(id)!
const body = () => ({
  generation: generationOf(row(LANE)),
  coordinatorId: NEXT,
  coordinatorGeneration: generationOf(row(NEXT)),
  fromCoordinatorId: OLD,
})
const transfer = (input = body()) =>
  callSocket(paths.socket, 'POST', `/v1/sessions/${LANE}/transfer`, input)

it('transfers a linked running Pi lane and its helpers without replacing any runtime identity', async () => {
  const booking = JSON.stringify([
    {
      requestId: 'hunt-synthetic',
      host: 'local',
      needs: { memBytes: 4294967296, cpu: 2 },
      state: 'held',
    },
  ])
  daemon.store.putSetting('placement_reservations', booking, Date.now())
  const before = row(LANE),
    child = row(CHILD),
    other = row(OTHER)
  expect(await transfer()).toMatchObject({
    status: 200,
    body: {
      id: LANE,
      generation: generationOf(before),
      coordinatorId: NEXT,
      parentId: NEXT,
      launched: true,
      transferred: [LANE, CHILD],
    },
  })
  expect(row(LANE)).toEqual({
    ...before,
    coordinatorId: NEXT,
    parentId: NEXT,
    coordinatorColor: row(NEXT).coordinatorColor,
  })
  expect(row(CHILD)).toEqual({
    ...child,
    coordinatorId: NEXT,
    coordinatorColor: row(NEXT).coordinatorColor,
  })
  expect(row(OTHER)).toEqual(other)
  expect(daemon.store.getSetting('placement_reservations')).toBe(booking)
  expect(await transfer()).toMatchObject({ status: 200 }) // response-loss retry
  for (const op of [
    engine.ensureSessionSerialized,
    engine.respawnAndRelaunch,
    engine.endSession,
    engine.loadTui,
    engine.switchProject,
  ])
    expect(op).not.toHaveBeenCalled()
})

it('moves existing and future open questions, including their fallback after the lane ends', async () => {
  const created = await callSocket(paths.socket, 'POST', '/v1/asks', {
    session: LANE,
    question: 'Synthetic question?',
  })
  const id = (created.body as { id: string }).id
  const asks = new AskStore(daemon.store.db)
  expect(asks.get(id)).toMatchObject({ launcher: OLD, coordinator: OLD })
  expect((await transfer()).status).toBe(200)
  expect(asks.get(id)).toMatchObject({ id, launcher: NEXT, coordinator: NEXT, state: 'open' })
  const wake = vi.fn(() => null),
    withdraw = vi.fn()
  const delivery: AskDelivery = {
    wake,
    withdraw,
    cancel: () => {},
    receiver: (who) => who === NEXT,
    noteMaxChars: () => 500,
    sessionChanged: () => {},
  }
  withdraw.mockReturnValue(1)
  transferAskNotices([{ ask: asks.get(id)!, from: OLD }], delivery)
  expect(withdraw).toHaveBeenCalledWith(`ask:${id}:filed`)
  expect(wake).toHaveBeenCalledWith(
    NEXT,
    expect.stringContaining('Synthetic question?'),
    `ask:${id}:filed`,
  )
  expect(handOffAsks(asks, delivery, LANE, null)).toMatchObject([{ id, answerTo: NEXT }])
  const next = await callSocket(paths.socket, 'POST', '/v1/asks', {
    session: LANE,
    question: 'Another synthetic question?',
  })
  expect(asks.get((next.body as { id: string }).id)).toMatchObject({
    launcher: NEXT,
    coordinator: NEXT,
  })
})

/** The queued `[Ask] filed` notices for this ask, by receiver. */
const filed = (id: string) =>
  (
    daemon.store.db
      .prepare('SELECT session_id FROM wakes WHERE source = ? ORDER BY session_id')
      .all(`ask:${id}:filed`) as { session_id: string }[]
  ).map((r) => r.session_id)

it('the transfer route moves a still-queued [Ask] notice to the new launcher', async () => {
  const created = await callSocket(paths.socket, 'POST', '/v1/asks', {
    session: LANE,
    question: 'Synthetic queued notice?',
  })
  const id = (created.body as { id: string }).id
  expect(filed(id)).toEqual([OLD])
  expect((await transfer()).status).toBe(200)
  expect(filed(id)).toEqual([NEXT])
  // A response-loss retry changes no launcher and sends nothing again.
  expect((await transfer()).status).toBe(200)
  expect(filed(id)).toEqual([NEXT])
})

it('the transfer route never re-sends an [Ask] notice already delivered', async () => {
  const created = await callSocket(paths.socket, 'POST', '/v1/asks', {
    session: LANE,
    question: 'Synthetic delivered notice?',
  })
  const id = (created.body as { id: string }).id
  // The old launcher took the line.
  daemon.store.db.prepare('DELETE FROM wakes WHERE source = ?').run(`ask:${id}:filed`)
  expect((await transfer()).status).toBe(200)
  expect(filed(id)).toEqual([])
})

it('rolls the lineage back if an open-question update fails', async () => {
  await callSocket(paths.socket, 'POST', '/v1/asks', {
    session: LANE,
    question: 'Synthetic transaction?',
  })
  const before = row(LANE)
  daemon.store.db.exec(
    "CREATE TRIGGER synthetic_transfer_failure BEFORE UPDATE OF coordinator_id ON asks BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
  )
  expect((await transfer()).status).toBe(500)
  expect(row(LANE)).toEqual(before)
})

it('rejects invalid bodies and a missing destination without a metadata change', async () => {
  const before = row(LANE)
  for (const input of [
    { ...body(), coordinatorId: true },
    { ...body(), coordinatorGeneration: 'bad' },
    { ...body(), surprise: true },
  ])
    expect(
      (await callSocket(paths.socket, 'POST', `/v1/sessions/${LANE}/transfer`, input)).status,
    ).toBe(400)
  expect((await transfer({ ...body(), coordinatorId: 'ffffffff' })).status).toBe(404)
  expect(row(LANE)).toEqual(before)
})

it('refuses stale generations, wrong old lineage, a non-root destination and an unlaunched join', async () => {
  const before = row(LANE)
  for (const input of [
    { ...body(), generation: 'f'.repeat(64) },
    { ...body(), coordinatorGeneration: 'f'.repeat(64) },
    { ...body(), fromCoordinatorId: NEXT },
    { ...body(), coordinatorId: CHILD, coordinatorGeneration: generationOf(row(CHILD)) },
  ]) {
    expect((await transfer(input)).status).toBe(409)
    expect(row(LANE)).toEqual(before)
  }
  daemon.store.db.prepare('UPDATE sessions SET launched = 0 WHERE id = ?').run(LANE)
  expect(await transfer()).toMatchObject({ status: 409, body: { error: 'lane_not_linked' } })
})

it('refuses a destination that is busy or no longer running without applying anything', async () => {
  const before = row(LANE),
    lock = engine.lifecycleOwners.acquire(NEXT)!
  try {
    expect((await transfer()).status).toBe(409)
  } finally {
    engine.releaseLifecycleOwner(NEXT, lock)
  }
  vi.mocked(engine.rootManagedGateState).mockImplementation(async (current) =>
    current.id === NEXT ? null : 'active-workload',
  )
  expect((await transfer()).status).toBe(409)
  expect(row(LANE)).toEqual(before)
})
