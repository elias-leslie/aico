import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getWidget,
  insertWidget,
  removeWidget,
  reserveRootRequest,
} from '@aico/session-engine/catalog'
import { type RestoreReport, readJsonFile, writeJsonFile } from '@aico/session-engine/continuity'
import { rootLaunchEnvironment } from '@aico/session-engine/root-launch'
import { initStore } from '@aico/session-engine/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Placement } from './hub/placement'
import type { LifecycleApiContext } from './lifecycle-api'
import { Continuity } from './reboot'

const h = vi.hoisted(() => ({
  status: 'pending',
  exit: 78,
  agent: false,
  probe: null as
    | null
    | { kind: 'waiting'; reason: string }
    | { kind: 'running'; pid: number; resumeId: string },
  launches: [] as string[],
  ensure: vi.fn(),
  respawn: vi.fn(),
}))
vi.mock('@aico/session-engine/engine', () => ({
  ensureSessionSerialized: (...args: unknown[]) => h.ensure(...args),
  respawnAndRelaunch: (...args: unknown[]) => h.respawn(...args),
  lastEnsureFailure: () => undefined,
  verifiedCurrentManagedPane: async () => (h.status === 'running' ? { pid: 99999999 } : null),
  verifySessionStatus: async () => h.status,
  agentExitOf: () => (h.agent ? { state: 'started' } : { state: 'exit', status: h.exit }),
  whenReady: async () => {},
}))
vi.mock('@aico/session-engine/continuity', async (original) => ({
  ...(await original<typeof import('@aico/session-engine/continuity')>()),
  observeAgent: () =>
    h.agent
      ? { pid: 7, resumeId: '3e0161b0-9591-4f68-a80a-656951537274', idle: null, blocked: false }
      : null,
}))
vi.mock('@aico/session-engine/entry-agent', () => ({
  probeEntryAgent: async () => h.probe ?? { kind: 'unconfigured' },
}))

const ID = 'b0070001'
const RESUME = '3e0161b0-9591-4f68-a80a-656951537274'
let dir: string
let now: number
let service: Continuity

function continuity(
  sleep: (ms: number) => Promise<void> = async (ms) => {
    now += ms
  },
) {
  return new Continuity({ paths: { stateDir: dir } } as LifecycleApiContext, {
    headless: true,
    now: () => now,
    sleep,
    log: () => {},
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-reboot-'))
  initStore(join(dir, 'catalog.db'))
  insertWidget(ID, 'pi')
  mkdirSync(join(dir, 'state'))
  now = 1000
  h.status = 'pending'
  h.exit = 78
  h.agent = false
  h.probe = null
  h.launches = []
  h.ensure.mockReset().mockImplementation(async () => {
    h.status = 'running'
    h.launches.push(rootLaunchEnvironment(ID).AICO_ROOT_RESUME_SESSION_ID ?? '')
    return true
  })
  h.respawn.mockReset().mockImplementation(async () => {
    h.launches.push(rootLaunchEnvironment(ID).AICO_ROOT_RESUME_SESSION_ID ?? '')
    return { status: 'replaced' }
  })
  writeJsonFile(join(dir, 'continuity.json'), {
    v: 1,
    bootId: 'old',
    updatedAt: now,
    sessions: [{ id: ID, tool: 'pi', resumeId: RESUME, observedAt: now }],
  })
  service = continuity()
})

it('rebooks durable needs before resuming when both the booking and runtime are initially unavailable', async () => {
  removeWidget(ID)
  reserveRootRequest(
    {
      requestId: 'synthetic-root',
      digest: 'a'.repeat(64),
      widgetId: ID,
      logicalSessionId: 'synthetic-logical',
      role: 'test',
      leadRootReference: null,
      facetCapsuleRef: null,
      createdAt: now,
      origin: 'aico',
    },
    'pi',
    'synthetic',
    dir,
  )
  const settings = new Map<string, string>([
    [
      'placement_intents',
      JSON.stringify({
        'synthetic-root': {
          host: 'local',
          needs: { memBytes: 1024 ** 3, cpu: 1, caps: [] },
        },
      }),
    ],
  ])
  let healthy = false
  const placement = new Placement({
    env: { TETHER_PLACEMENT_FILE: join(dir, 'placement.json'), XDG_RUNTIME_DIR: join(dir, 'run') },
    settings: {
      get: (key) => settings.get(key) ?? null,
      put: (key, value) => {
        settings.set(key, value)
      },
    },
    hostNames: () => [],
    peer: () => null,
    existingHost: () => null,
    localRoot: () => 'live',
    now: () => now,
    log: () => {},
    cpu: () => ({ cpus: 8, load5: 0 }),
    readText: async () =>
      JSON.stringify({
        v: 1,
        state: healthy ? 'green' : 'red',
        admit: healthy,
        mem_available_gib: 20,
        updated_at: now / 1000,
        expires_at: now / 1000 + 60,
        reason: 'synthetic readiness',
      }),
  })
  h.exit = 75
  h.respawn.mockImplementation(async () => {
    h.agent = true
    return { status: 'replaced' }
  })
  service = new Continuity({ paths: { stateDir: dir }, placement } as LifecycleApiContext, {
    headless: true,
    now: () => now,
    log: () => {},
    sleep: async (ms) => {
      now += ms
      expect(now).toBeLessThan(120_000)
      expect(readJsonFile<RestoreReport>(join(dir, 'restore.json'))?.restored).toEqual([])
      if (!healthy) {
        expect(h.ensure).not.toHaveBeenCalled()
        healthy = true
      }
    },
  })
  const report = await service.restoreAfterStart()
  expect(report?.restored).toMatchObject([{ id: ID, resumed: true }])
  expect(placement.list()).toMatchObject([
    { requestId: 'synthetic-root', memBytes: 1024 ** 3, cpu: 1, state: 'held' },
  ])
  expect(h.launches.every((id) => id === RESUME)).toBe(true)
})
afterEach(() => {
  service.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('reboot agent readiness', () => {
  it('requires the live probe rather than an old conversation observation from the entry', async () => {
    h.agent = true
    h.probe = { kind: 'waiting', reason: 'no native process yet' }
    service = continuity(async (ms) => {
      now += ms
      expect(readJsonFile<RestoreReport>(join(dir, 'restore.json'))?.restored).toEqual([])
      h.probe = { kind: 'running', pid: 123, resumeId: RESUME }
    })
    expect((await service.restoreAfterStart())?.restored).toMatchObject([{ id: ID, resumed: true }])
    expect(now).toBeGreaterThan(1000)
  })

  it('leaves a different live conversation untouched and reports failure', async () => {
    h.agent = true
    h.probe = { kind: 'running', pid: 123, resumeId: '5a7741ea-e6b1-4062-853b-0d9d2e03d549' }
    const report = await service.restoreAfterStart()
    expect(report?.restored).toEqual([])
    expect(report?.failed).toMatchObject([
      { reason: expect.stringContaining('different conversation') },
    ])
    expect(h.respawn).not.toHaveBeenCalled()
  })
  it('keeps confirming when an early probe still names another conversation', async () => {
    h.agent = true
    h.probe = { kind: 'running', pid: 123, resumeId: '5a7741ea-e6b1-4062-853b-0d9d2e03d549' }
    service = continuity(async (ms) => {
      now += ms
      // The resumed conversation shows up on the next look.
      h.probe = { kind: 'running', pid: 123, resumeId: RESUME }
    })
    const report = await service.restoreAfterStart()
    expect(report?.failed).toEqual([])
    expect(report?.restored).toMatchObject([{ id: ID, resumed: true }])
    expect(h.respawn).not.toHaveBeenCalled()
  })

  it('reports an entry that exited 78 as failed, never as a restored Pi', async () => {
    const report = await service.restoreAfterStart()
    expect(report?.restored).toEqual([])
    expect(report?.failed).toMatchObject([{ id: ID, reason: expect.stringContaining('78') }])
    expect(getWidget(ID)).toBeDefined()
  })

  it('keeps retrying a transient entry beyond fifteen minutes and resumes the same conversation', async () => {
    h.exit = 75
    service = continuity(async (ms) => {
      now += ms
      await service.observe()
      expect(readJsonFile<RestoreReport>(join(dir, 'restore.json'))?.restored).toEqual([])
      if (now > 20 * 60_000) h.agent = true
    })
    const report = await service.restoreAfterStart()
    expect(now).toBeGreaterThan(20 * 60_000)
    expect(report?.restored).toEqual([{ id: ID, name: null, tool: 'pi', resumed: true }])
    expect(h.respawn).toHaveBeenCalled()
    expect(h.launches.every((id) => id === RESUME)).toBe(true)
  })

  it('settles restoreFinished after the first full pass while a session is still retrying', async () => {
    h.exit = 75
    let finished = false
    let finishedWhileRetrying = false
    service = continuity(async (ms) => {
      now += ms
      await new Promise((resolve) => setImmediate(resolve))
      if (finished) finishedWhileRetrying = true
      h.agent = true
    })
    void service.restoreFinished.then(() => {
      finished = true
    })
    const report = await service.restoreAfterStart()
    // Dead-shell cleanup waits on this; a pending session must not hold it.
    expect(finishedWhileRetrying).toBe(true)
    expect(report?.restored).toMatchObject([{ id: ID }])
  })

  it('resumes a durable pending attempt after Tether restarts at a fallback shell', async () => {
    h.status = 'running'
    h.exit = 75
    writeJsonFile(join(dir, 'restore.json'), {
      v: 1,
      bootId: 'old',
      startedAt: 1,
      finishedAt: null,
      restored: [],
      failed: [],
      pending: [{ id: ID, name: null, tool: 'pi', reason: 'entry exited 75' }],
    })
    h.respawn.mockImplementation(async () => {
      h.agent = true
      return { status: 'replaced' }
    })
    const report = await service.restoreAfterStart()
    expect(report?.restored).toMatchObject([{ id: ID, resumed: true }])
    expect(h.ensure).not.toHaveBeenCalled()
    expect(h.respawn).toHaveBeenCalledOnce()
  })
})
