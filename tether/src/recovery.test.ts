// The crash recovery state machine with the engine, clock and commands
// replaced: no tmux, systemd or agent process is involved.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { writeJsonFile } from './continuity'
import { getWidget, insertWidget, removeWidget, setWidgetOwnership } from './lifecycle/catalog'
import type { AbandonedScope, RespawnResult } from './lifecycle/engine'
import { initStore, registerBuiltinTuis } from './lifecycle/testing'
import type { LifecycleApiContext } from './lifecycle-api'
import { type AgentSeen, Recovery, type RecoveryEngine } from './recovery'

const RESUME = '3e0161b0-9591-4f68-a80a-656951537274'
const INVOCATION = 'a'.repeat(32)
const SERVER = 'b'.repeat(32)
const PANE_PID = 4242
const T0 = Date.parse('2026-10-16T03:00:00Z')

let dir: string
let stateDir: string
let savedEnv: { HOME?: string; XDG_RUNTIME_DIR?: string }
let seq = 0

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-recovery-'))
  savedEnv = { HOME: process.env.HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }
  // No real transcripts or host admission verdict are read.
  process.env.HOME = dir
  process.env.XDG_RUNTIME_DIR = join(dir, 'run')
  registerBuiltinTuis()
  initStore(join(dir, 'catalog.db'))
})

afterAll(() => {
  process.env.HOME = savedEnv.HOME
  process.env.XDG_RUNTIME_DIR = savedEnv.XDG_RUNTIME_DIR
  rmSync(dir, { recursive: true, force: true })
})

interface Harness {
  id: string
  recovery: Recovery
  clock: { now: number }
  pane: { pid: number } | null
  agent: AgentSeen | null
  exit: number | null
  release: 'released' | 'busy' | 'refused'
  running: { id: string; resumeId: string | null }[]
  paneExitedAt: number | null
  systemState: string
  journal: string
  respawn: Mock<(id: string) => Promise<RespawnResult>>
  ensure: Mock<(id: string) => Promise<boolean>>
  sleep: (ms: number) => Promise<void>
}

function harness(): Harness {
  seq += 1
  const id = `c0${String(seq).padStart(6, '0')}`
  stateDir = join(dir, `state-${seq}`)
  insertWidget(id, 'claude-code')
  setWidgetOwnership(id, `tmux-spawn-${id}.scope`, 1, INVOCATION)
  mkdirSync(stateDir, { recursive: true })
  writeJsonFile(join(stateDir, 'continuity.json'), {
    v: 1,
    bootId: 'x',
    updatedAt: T0,
    sessions: [{ id, tool: 'claude-code', resumeId: RESUME, observedAt: T0 }],
  })
  const h = {
    id,
    clock: { now: T0 },
    pane: { pid: PANE_PID },
    agent: null,
    exit: 137,
    release: 'released',
    running: [],
    paneExitedAt: null,
    systemState: 'running',
    journal: '',
    respawn: vi.fn(async (_id: string): Promise<RespawnResult> => ({ status: 'replaced' })),
    ensure: vi.fn(async (_id: string) => true),
    sleep: async (ms: number) => {
      h.clock.now += ms
    },
  } as unknown as Harness
  const engine: RecoveryEngine = {
    currentPane: async () => h.pane,
    agentIn: () => h.agent,
    agentExit: () => h.exit,
    reconcile: async () => {},
    release: async () => h.release,
    ensure: (rowId) => h.ensure(rowId),
    respawn: (rowId) => h.respawn(rowId),
    lastFailure: () => undefined,
    notify: () => {},
    paneExitedAt: () => h.paneExitedAt,
    runningConversations: async () => h.running,
  }
  const context = {
    paths: { stateDir },
    gui: { connected: () => false, send: async () => true },
  } as unknown as LifecycleApiContext
  h.recovery = new Recovery(context, {
    now: () => h.clock.now,
    sleep: (ms) => h.sleep(ms),
    log: () => {},
    engine,
    run: async (command, args) => {
      if (command === 'systemctl') return `${h.systemState}\n`
      if (command === 'journalctl' && args.includes('--user') && !args.includes('-u'))
        return h.journal
      return ''
    },
  })
  return h
}

function row(h: Harness) {
  const current = getWidget(h.id)
  if (!current) throw new Error('fixture row missing')
  return current
}

function sessions(h: Harness): Record<string, unknown>[] {
  return h.recovery.status().sessions as Record<string, unknown>[]
}

/** Past the record's start time and the 60 s admission settle. */
async function runDue(h: Harness): Promise<void> {
  h.clock.now += 61_000
  await h.recovery.tick()
  h.clock.now += 61_000
  await h.recovery.tick()
}

/** The agent was killed; its fallback shell holds exit status 137. */
async function agentKilled(h: Harness): Promise<void> {
  await h.recovery.inspect(row(h), 'running', PANE_PID, null)
  expect(sessions(h)).toMatchObject([{ id: h.id, kind: 'agent-exited', state: 'waiting' }])
}

function unitResult(unit: string, result: string, at: number): string {
  return JSON.stringify({
    MESSAGE: `${unit}: Failed with result '${result}'.`,
    MESSAGE_ID: 'd9b373ed55a64feb8242e02dbe79a49c',
    UNIT_RESULT: result,
    USER_UNIT: unit,
    USER_INVOCATION_ID: INVOCATION,
    __REALTIME_TIMESTAMP: String(at * 1000),
  })
}

function abandoned(h: Harness, overrides: Partial<AbandonedScope> = {}): AbandonedScope {
  return {
    widgetId: h.id,
    scopeUnit: `tmux-spawn-${h.id}.scope`,
    scopeInvocationId: INVOCATION,
    tmuxServerId: SERVER,
    serverUnit: null,
    serverInvocationId: null,
    serverDead: false,
    startup: false,
    at: h.clock.now,
    ...overrides,
  }
}

describe('crash recovery', () => {
  let h: Harness
  beforeEach(() => {
    h = harness()
  })

  it('resumes a killed agent in its pane and records the recovery once the agent is back', async () => {
    await agentKilled(h)
    h.respawn.mockImplementation(async () => {
      h.agent = { pid: 7, resumeId: RESUME }
      return { status: 'replaced' }
    })
    await runDue(h)
    expect(h.respawn).toHaveBeenCalledTimes(1)
    expect(sessions(h)).toMatchObject([{ state: 'recovered', attempt: 1 }])
  })

  it('drops the record when the owner restarted the agent by hand, and never kills it', async () => {
    await agentKilled(h)
    h.agent = { pid: 8, resumeId: RESUME }
    await runDue(h)
    expect(h.respawn).not.toHaveBeenCalled()
    expect(sessions(h)).toEqual([])
    expect(h.recovery.resumeOwner(RESUME)).toBeNull()
    // The owner's agent exits; the shell still says 137 from the first death.
    h.agent = null
    await h.recovery.inspect(row(h), 'running', PANE_PID, null)
    expect(sessions(h)).toEqual([])
  })

  it('drops a held record as soon as continuity sees the agent running again', async () => {
    await agentKilled(h)
    await runDue(h) // the resume never shows up, so the session is held
    expect(sessions(h)).toMatchObject([{ state: 'held' }])
    expect(h.recovery.resumeOwner(RESUME)).toBe(h.id)
    await h.recovery.inspect(row(h), 'running', PANE_PID, 9)
    expect(sessions(h)).toEqual([])
    expect(h.recovery.resumeOwner(RESUME)).toBeNull()
  })

  it('does not resume a conversation another session is already running', async () => {
    await agentKilled(h)
    h.running = [{ id: 'f0000001', resumeId: RESUME }]
    await runDue(h)
    expect(h.respawn).not.toHaveBeenCalled()
    expect(sessions(h)).toEqual([])
  })

  it('holds a resume that fell back to the shell instead of calling it recovered', async () => {
    await agentKilled(h)
    await runDue(h)
    expect(h.respawn).toHaveBeenCalledTimes(1)
    expect(sessions(h)).toMatchObject([{ state: 'held' }])
    expect(String(sessions(h)[0]?.reason)).toContain('the resume did not start')
  })

  it('retries a pane-stopped relaunch while another lifecycle operation holds the session', async () => {
    h.pane = null
    h.journal = unitResult(`tmux-spawn-${h.id}.scope`, 'oom-kill', h.clock.now)
    await h.recovery.onAbandoned(abandoned(h))
    expect(sessions(h)).toMatchObject([
      { kind: 'pane-stopped', cause: 'oom-kill', state: 'waiting' },
    ])
    h.release = 'busy'
    await runDue(h)
    expect(sessions(h)).toMatchObject([{ state: 'waiting' }])
    expect(h.ensure).not.toHaveBeenCalled()
    h.release = 'released'
    h.ensure.mockImplementation(async () => {
      h.pane = { pid: 11 }
      h.agent = { pid: 12, resumeId: RESUME }
      return true
    })
    h.clock.now += 31_000
    await h.recovery.tick()
    expect(h.ensure).toHaveBeenCalledTimes(1)
    expect(sessions(h)).toMatchObject([{ state: 'recovered' }])
  })

  it('reports a session still being classified as the owner of its conversation', async () => {
    h.pane = null
    let release: () => void = () => {}
    h.sleep = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    const classifying = h.recovery.onAbandoned(abandoned(h))
    await vi.waitFor(() => expect(h.recovery.resumeOwner(RESUME)).toBe(h.id))
    h.journal = unitResult(`tmux-spawn-${h.id}.scope`, 'signal', h.clock.now)
    release()
    await classifying
    expect(h.recovery.resumeOwner(RESUME)).toBe(h.id)
  })

  it('ignores a unit result logged well after the pane went, and a stop timeout', async () => {
    h.pane = null
    const at = h.clock.now
    h.journal = unitResult(`tmux-spawn-${h.id}.scope`, 'signal', at + 30_000)
    await h.recovery.onAbandoned(abandoned(h, { at }))
    expect(sessions(h)).toEqual([])
    h.journal = unitResult(`tmux-spawn-${h.id}.scope`, 'timeout', at)
    await h.recovery.onAbandoned(abandoned(h, { at }))
    expect(sessions(h)).toEqual([])
  })

  it('reads a vanished tmux server as lost only when no pane exited and the host is up', async () => {
    h.pane = null
    const server = { serverDead: true, serverUnit: `aico-tmux-server-${SERVER}.service` }
    // Agent seen running, then the owner's /exit and exit end the last pane.
    await h.recovery.inspect(row(h), 'running', PANE_PID, 5)
    h.clock.now += 30_000
    h.paneExitedAt = h.clock.now - 1_000
    await h.recovery.onAbandoned(abandoned(h, server))
    expect(sessions(h)).toEqual([])
    // Logout or shutdown.
    await h.recovery.inspect(row(h), 'running', PANE_PID, 5)
    h.paneExitedAt = null
    h.systemState = 'stopping'
    await h.recovery.onAbandoned(abandoned(h, server))
    expect(sessions(h)).toEqual([])
    // Killed while Tether kept running.
    await h.recovery.inspect(row(h), 'running', PANE_PID, 5)
    h.systemState = 'running'
    await h.recovery.onAbandoned(abandoned(h, server))
    expect(sessions(h)).toMatchObject([{ kind: 'server-died', cause: 'lost', state: 'waiting' }])
  })

  it('forgets the record of a session that was ended', async () => {
    await agentKilled(h)
    removeWidget(h.id)
    await runDue(h)
    expect(h.respawn).not.toHaveBeenCalled()
    expect(sessions(h)).toEqual([])
  })
})
