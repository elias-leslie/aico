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
import type { AgentExitMarker } from './lifecycle/tui/launch'
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
  kernel: string
  marker: { marker: AgentExitMarker; at: number } | null
  markers: Map<string, number>
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
    kernel: '',
    marker: null,
    markers: new Map<string, number>(),
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
    // Only the session's own pane scope has a marker.
    agentExitMarker: (scopeUnit) => (scopeUnit === `tmux-spawn-${id}.scope` ? h.marker : null),
    agentExitMarkers: () => [...h.markers].map(([scopeUnit, at]) => ({ scopeUnit, at })),
    removeAgentExitMarker: (scopeUnit) => {
      h.markers.delete(scopeUnit)
      if (scopeUnit === `tmux-spawn-${id}.scope`) h.marker = null
    },
  }
  const context = {
    paths: { stateDir, runtimeDir: join(dir, 'run') },
    gui: { connected: () => false, send: async () => true },
  } as unknown as LifecycleApiContext
  h.recovery = new Recovery(context, {
    now: () => h.clock.now,
    sleep: (ms) => h.sleep(ms),
    log: () => {},
    engine,
    run: async (command, args) => {
      if (command === 'systemctl') return `${h.systemState}\n`
      if (command === 'journalctl' && args.includes('-k')) return h.kernel
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

/** systemd's resource summary, the only record a scope that emptied gets. */
function unitConsumed(unit: string, at: number): string {
  return JSON.stringify({
    MESSAGE: `${unit}: Consumed 1.2s CPU time.`,
    MESSAGE_ID: 'ae8f7b866b0347b9af31fe1c80b127c0',
    USER_UNIT: unit,
    USER_INVOCATION_ID: INVOCATION,
    __REALTIME_TIMESTAMP: String(at * 1000),
  })
}

/** What systemd logs for each process `systemctl kill` signals. */
function unitSigkill(unit: string, pid: number, at: number, signal = 'SIGKILL'): string {
  return JSON.stringify({
    MESSAGE: `${unit}: Sending signal ${signal} to process ${pid} (bash) on client request.`,
    USER_UNIT: unit,
    USER_INVOCATION_ID: INVOCATION,
    __REALTIME_TIMESTAMP: String(at * 1000),
  })
}

/** The kernel's record of an OOM kill of `pid` in the session's pane. */
function kernelOom(h: Harness, pid: number, comm: string, at: number): string {
  const memcg = `/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-${h.id}.scope`
  return [
    `oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,oom_memcg=${memcg},task_memcg=${memcg},task=${comm},pid=${pid},uid=1000`,
    `Memory cgroup out of memory: Killed process ${pid} (${comm}) total-vm:1kB, anon-rss:204800kB, file-rss:0kB`,
  ]
    .map((MESSAGE) => JSON.stringify({ MESSAGE, __REALTIME_TIMESTAMP: String(at * 1000) }))
    .join('\n')
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

  it('reads a pane whose every process was SIGKILLed while the agent ran as a crash', async () => {
    h.pane = null
    const unit = `tmux-spawn-${h.id}.scope`
    const killedAt = h.clock.now - 4_000
    // The scope just emptied: no failure result, only the resource summary.
    h.journal = unitConsumed(unit, killedAt)
    h.marker = { marker: { state: 'started' }, at: T0 - 3600_000 }
    await h.recovery.onAbandoned(abandoned(h))
    expect(sessions(h)).toMatchObject([
      {
        kind: 'pane-stopped',
        cause: 'killed',
        state: 'waiting',
        died_at: killedAt,
        died_at_approx: false,
      },
    ])
    // The marker is read once and removed.
    expect(h.marker).toBeNull()
    h.ensure.mockImplementation(async () => {
      h.pane = { pid: 11 }
      h.agent = { pid: 12, resumeId: RESUME }
      return true
    })
    await runDue(h)
    expect(h.ensure).toHaveBeenCalledTimes(1)
    expect(sessions(h)).toMatchObject([{ state: 'recovered' }])
  })

  it('does not read a clean exit, a closed or stopped pane, or an old supervisor as a kill', async () => {
    h.pane = null
    const unit = `tmux-spawn-${h.id}.scope`
    h.journal = unitConsumed(unit, h.clock.now)
    // The owner typed /exit, then exit in the fallback shell.
    for (const marker of [
      { state: 'exit', status: 0 },
      { state: 'signal', signal: 'HUP' },
      { state: 'signal', signal: 'TERM' },
    ] as AgentExitMarker[]) {
      h.marker = { marker, at: h.clock.now }
      await h.recovery.onAbandoned(abandoned(h))
      expect(sessions(h)).toEqual([])
    }
    // A pane started before supervisors wrote markers.
    h.marker = null
    await h.recovery.onAbandoned(abandoned(h))
    expect(sessions(h)).toEqual([])
    // A stop that timed out is Tether's own cleanup, even with the agent running.
    h.marker = { marker: { state: 'started' }, at: h.clock.now }
    h.journal = unitResult(unit, 'timeout', h.clock.now)
    await h.recovery.onAbandoned(abandoned(h))
    expect(sessions(h)).toEqual([])
  })

  it('reads a killed pane whose empty tmux server then exited as the pane being killed', async () => {
    h.pane = null
    h.marker = { marker: { state: 'started' }, at: T0 }
    const unit = `tmux-spawn-${h.id}.scope`
    const killedAt = h.clock.now - 50_000
    h.journal = [unitSigkill(unit, 300, killedAt), unitSigkill(unit, 301, killedAt)].join('\n')
    const serverUnit = `aico-tmux-server-${SERVER}.service`
    await h.recovery.onAbandoned(abandoned(h, { serverDead: true, serverUnit }))
    expect(sessions(h)).toMatchObject([
      {
        kind: 'pane-stopped',
        cause: 'killed',
        signal: 9,
        died_at: killedAt,
        died_at_approx: false,
      },
    ])
  })

  it('reads a pane from before the exit marker as killed only on systemd SIGKILL records', async () => {
    h.pane = null
    const unit = `tmux-spawn-${h.id}.scope`
    const at = h.clock.now
    // A SIGKILL logged after Tether saw the pane go is not what ended it.
    h.journal = unitSigkill(unit, 300, at + 1_000)
    await h.recovery.onAbandoned(abandoned(h, { at }))
    expect(sessions(h)).toEqual([])
    // systemctl kill with its default SIGTERM is a stop on purpose.
    h.journal = unitSigkill(unit, 300, at - 1_000, 'SIGTERM')
    await h.recovery.onAbandoned(abandoned(h, { at }))
    expect(sessions(h)).toEqual([])
    h.journal = unitSigkill(unit, 300, at - 1_000)
    await h.recovery.onAbandoned(abandoned(h, { at }))
    expect(sessions(h)).toMatchObject([{ kind: 'pane-stopped', cause: 'killed' }])
  })

  it('does not read a SIGKILL after the agent exited as a crash', async () => {
    h.pane = null
    const unit = `tmux-spawn-${h.id}.scope`
    h.marker = { marker: { state: 'exit', status: 0 }, at: h.clock.now - 5_000 }
    h.journal = unitSigkill(unit, 300, h.clock.now - 1_000)
    await h.recovery.onAbandoned(abandoned(h))
    expect(sessions(h)).toEqual([])
  })

  it('reads a whole-pane SIGKILL as a crash when the owner had started the agent again by hand', async () => {
    const unit = `tmux-spawn-${h.id}.scope`
    // The agent was killed and the supervisor wrote its exit; the owner then
    // typed claude --resume in the fallback shell, which nothing records.
    h.marker = { marker: { state: 'exit', status: 137 }, at: h.clock.now - 60_000 }
    await h.recovery.inspect(row(h), 'running', PANE_PID, 777)
    h.clock.now += 30_000
    h.pane = null
    const killedAt = h.clock.now - 1_000
    h.journal = [unitSigkill(unit, 777, killedAt), unitConsumed(unit, killedAt)].join('\n')
    await h.recovery.onAbandoned(abandoned(h))
    expect(sessions(h)).toMatchObject([
      { kind: 'pane-stopped', cause: 'killed', died_at: killedAt, died_at_approx: false },
    ])
  })

  it("needs a systemd SIGKILL to read a hand-started agent's pane ending as a kill", async () => {
    const unit = `tmux-spawn-${h.id}.scope`
    h.marker = { marker: { state: 'exit', status: 0 }, at: h.clock.now - 60_000 }
    await h.recovery.inspect(row(h), 'running', PANE_PID, 777)
    h.clock.now += 30_000
    h.pane = null
    // The owner's agent exited and they typed exit: the scope just ends.
    h.journal = unitConsumed(unit, h.clock.now - 500)
    await h.recovery.onAbandoned(abandoned(h))
    expect(sessions(h)).toEqual([])
  })

  it('does not read a pane whose processes outlived it, until Tether stopped them, as a kill', async () => {
    h.pane = null
    const unit = `tmux-spawn-${h.id}.scope`
    const at = h.clock.now
    // The stop timed out and Tether emptied the scope with cgroup.kill.
    h.marker = { marker: { state: 'started' }, at: T0 - 3600_000 }
    h.journal = unitConsumed(unit, at + 7_000)
    await h.recovery.onAbandoned(abandoned(h, { at }))
    expect(sessions(h)).toEqual([])
  })

  it('dates a pane kill by the kill, not by an older OOM victim the agent outlived', async () => {
    h.pane = null
    const unit = `tmux-spawn-${h.id}.scope`
    const killedAt = h.clock.now - 2_000
    h.marker = { marker: { state: 'started' }, at: T0 - 3600_000 }
    h.kernel = kernelOom(h, 900, 'python', killedAt - 7 * 60_000)
    h.journal = [unitSigkill(unit, 300, killedAt), unitConsumed(unit, killedAt)].join('\n')
    await h.recovery.onAbandoned(abandoned(h))
    expect(sessions(h)).toMatchObject([
      { cause: 'killed', died_at: killedAt, died_at_approx: false, victim: null },
    ])
  })

  it('names the OOM victim that ended a pane with no unit failure', async () => {
    h.pane = null
    const unit = `tmux-spawn-${h.id}.scope`
    const endedAt = h.clock.now - 1_000
    // The kernel killed the supervisor shell itself; the rest of the pane ended.
    h.marker = { marker: { state: 'started' }, at: T0 - 3600_000 }
    h.kernel = kernelOom(h, 901, 'bash', endedAt - 20)
    h.journal = unitConsumed(unit, endedAt)
    await h.recovery.onAbandoned(abandoned(h))
    expect(sessions(h)).toMatchObject([
      { cause: 'killed', died_at: endedAt - 20, victim: { pid: 901, comm: 'bash' } },
    ])
  })

  it('reads no marker for another scope', async () => {
    h.pane = null
    h.marker = { marker: { state: 'started' }, at: T0 - 3600_000 }
    const other = 'tmux-spawn-someone-else.scope'
    h.journal = unitConsumed(other, h.clock.now - 1_000)
    await h.recovery.onAbandoned(abandoned(h, { scopeUnit: other }))
    expect(sessions(h)).toEqual([])
  })

  it('dates a killed agent by its exit marker, or says about when only detection is known', async () => {
    const exitedAt = T0 - 40_000
    h.marker = { marker: { state: 'exit', status: 137 }, at: exitedAt }
    await agentKilled(h)
    expect(sessions(h)).toMatchObject([{ died_at: exitedAt, died_at_approx: false }])
    const other = harness()
    await other.recovery.inspect(row(other), 'running', PANE_PID, null)
    expect(sessions(other)).toMatchObject([{ died_at: T0, died_at_approx: true }])
  })

  it('sweeps exit markers of panes no session owns once they are old', async () => {
    h.markers.set(`tmux-spawn-${h.id}.scope`, T0 - 3 * 3600_000)
    h.markers.set('tmux-spawn-gone-recent.scope', T0 + 3600_000 - 60_000)
    h.markers.set('tmux-spawn-gone-old.scope', T0)
    h.clock.now = T0 + 3600_000
    await h.recovery.tick()
    expect(new Set(h.markers.keys())).toEqual(
      new Set(['tmux-spawn-gone-recent.scope', `tmux-spawn-${h.id}.scope`]),
    )
  })

  it('forgets the record of a session that was ended', async () => {
    await agentKilled(h)
    removeWidget(h.id)
    await runDue(h)
    expect(h.respawn).not.toHaveBeenCalled()
    expect(sessions(h)).toEqual([])
  })
})
