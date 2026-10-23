import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_MEMORY_POLICY, GIB, type MemoryPolicy } from '../memory-policy'
import {
  buildJobs,
  chooseVictim,
  isAgentProcess,
  type Job,
  JobGuard,
  memoryEventsPath,
  type Pane,
  type PaneCapHost,
  type Proc,
  parseHostState,
} from './job-guard'

const AGENT_NAMES = new Set(['claude', 'codex', 'pi'])
const A = 'tmux-spawn-6019d1b3-0bc2-4cc8-811f-f2a5615c140f.scope'
const B = 'tmux-spawn-7dcd5091-db97-423d-a3aa-57b784f0a0c9.scope'
const UID = 1000
const MIB = 2 ** 20

let dir: string
let proc: string
let app: string
let admission: string
let events: string
let heartbeat: string

interface FakeProc {
  pid: number
  ppid: number
  pgid?: number
  sid: number
  comm: string
  bytes: number
  adj?: number
  argv?: string[]
  start?: number
}

function addProc(scope: string, p: FakeProc): void {
  const d = join(proc, String(p.pid))
  mkdirSync(d, { recursive: true })
  const pgid = p.pgid ?? p.pid
  const fill = Array(15).fill('0').join(' ')
  writeFileSync(
    join(d, 'stat'),
    `${p.pid} (${p.comm}) S ${p.ppid} ${pgid} ${p.sid} ${fill} ${p.start ?? p.pid} 0 0\n`,
  )
  writeFileSync(
    join(d, 'status'),
    `Name:\t${p.comm}\nRssAnon:\t${p.bytes / 1024} kB\nVmSwap:\t0 kB\n`,
  )
  writeFileSync(join(d, 'oom_score_adj'), `${p.adj ?? 200}\n`)
  writeFileSync(join(d, 'cmdline'), `${(p.argv ?? [p.comm]).join('\0')}\0`)
  writeFileSync(join(d, 'comm'), `${p.comm}\n`)
  const cg = join(app, scope)
  mkdirSync(cg, { recursive: true })
  let pids = ''
  try {
    pids = readFileSync(join(cg, 'cgroup.procs'), 'utf8')
  } catch {
    pids = ''
  }
  writeFileSync(join(cg, 'cgroup.procs'), `${pids}${p.pid}\n`)
}

function paneFiles(scope: string, max = 'max', current = 0): void {
  const cg = join(app, scope)
  mkdirSync(cg, { recursive: true })
  writeFileSync(join(cg, 'memory.max'), `${max}\n`)
  writeFileSync(join(cg, 'memory.current'), `${current}\n`)
  writeFileSync(join(cg, 'memory.swap.current'), '0\n')
  writeFileSync(join(cg, 'memory.stat'), 'anon 0\n')
}

/** Pane A: shell 100, claude 101 (2 GiB), a 3 GiB python tool job, a 100 MiB job.
 * Pane B: shell 500, codex 501, a 5 GiB tool job. */
function twoPanes(): void {
  mkdirSync(join(proc, '1'), { recursive: true })
  writeFileSync(join(proc, '1', 'comm'), 'tmux: server\n')
  paneFiles(A)
  addProc(A, { pid: 100, ppid: 1, sid: 100, comm: 'bash', bytes: 4 * MIB })
  addProc(A, { pid: 101, ppid: 100, sid: 100, comm: 'claude', bytes: 2 * GIB, adj: 100 })
  addProc(A, { pid: 200, ppid: 101, sid: 200, comm: 'bash', bytes: 4 * MIB })
  addProc(A, { pid: 201, ppid: 200, sid: 200, comm: 'python3', bytes: 3 * GIB, adj: 100 })
  addProc(A, { pid: 300, ppid: 101, sid: 300, comm: 'rg', bytes: 100 * MIB })
  paneFiles(B)
  addProc(B, { pid: 500, ppid: 1, sid: 500, comm: 'bash', bytes: 4 * MIB })
  addProc(B, {
    pid: 501,
    ppid: 500,
    sid: 500,
    comm: 'node',
    bytes: GIB,
    argv: ['node', '/x/bin/codex'],
  })
  addProc(B, { pid: 600, ppid: 501, sid: 600, comm: 'cargo', bytes: 5 * GIB })
}

function setState(state: string, nowMs: number): void {
  writeFileSync(
    admission,
    JSON.stringify({
      v: 1,
      state,
      admit: state === 'green',
      expires_at: Math.floor(nowMs / 1000) + 30,
    }),
  )
}

function guard(
  policy: Partial<MemoryPolicy> = {},
  extra: { foreground?: string; caps?: PaneCapHost } = {},
) {
  const killed: number[] = []
  const g = new JobGuard({
    uid: UID,
    procRoot: proc,
    cgroupRoot: join(dir, 'sys'),
    admissionPath: admission,
    eventsPath: events,
    heartbeatPath: heartbeat,
    agentNames: () => AGENT_NAMES,
    policy: () => ({ ...DEFAULT_MEMORY_POLICY, ...policy }),
    foreground: () => extra.foreground ?? null,
    sessionOf: () => new Map([[A, 'aaaaaaaa']]),
    kill: (_root, pid) => {
      killed.push(pid)
      return true
    },
    caps: extra.caps ?? { setCap: async () => {}, oomPolicy: async () => 'continue' },
    log: () => {},
  })
  return { g, killed }
}

function records(): Record<string, unknown>[] {
  try {
    return readFileSync(events, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-guard-'))
  proc = join(dir, 'proc')
  app = join(dir, 'sys', `user.slice/user-${UID}.slice/user@${UID}.service/app.slice`)
  admission = join(dir, 'admission.json')
  events = join(dir, 'state', 'memory-events.jsonl')
  heartbeat = join(dir, 'run', 'memory-guard.json')
  mkdirSync(app, { recursive: true })
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const T0 = 1_800_000_000_000

describe('isAgentProcess', () => {
  it('knows registry agents by comm, by argv while starting, and codex-real', () => {
    expect(isAgentProcess('pi', [], AGENT_NAMES)).toBe(true)
    expect(isAgentProcess('node', ['node', '/opt/pi/node_modules/.bin/pi'], AGENT_NAMES)).toBe(true)
    expect(isAgentProcess('codex-real', ['/opt/codex/codex-real'], AGENT_NAMES)).toBe(true)
    expect(isAgentProcess('node', ['node', '/opt/app/server.js'], AGENT_NAMES)).toBe(false)
    expect(isAgentProcess('pi', [], new Set(['claude']))).toBe(false)
  })
})

describe('kill order', () => {
  function job(scope: string, key: number, bytes: number): Job {
    const p: Proc = {
      pid: key,
      ppid: 1,
      pgid: key,
      sid: key,
      starttime: key,
      comm: 'x',
      bytes,
      adj: 200,
      unit: scope,
    }
    return { scope, key: ['sid', key], members: [p] }
  }

  it('largest takes the biggest job of at least the minimum', () => {
    const jobs = [job(A, 1, 3 * GIB), job(B, 2, 5 * GIB), job(A, 3, 100 * MIB)]
    expect(chooseVictim(jobs, GIB, 'largest')?.key[1]).toBe(2)
    expect(chooseVictim([job(A, 3, 100 * MIB)], GIB, 'largest')).toBeNull()
  })

  it('background-first spares the foreground pane while a background job is big enough', () => {
    const jobs = [job(A, 1, 3 * GIB), job(B, 2, 5 * GIB)]
    expect(chooseVictim(jobs, GIB, 'background-first', B)?.key[1]).toBe(1)
    // nothing big enough in the background: the foreground job goes
    expect(
      chooseVictim([job(B, 2, 5 * GIB), job(A, 3, 100 * MIB)], GIB, 'background-first', B)?.key[1],
    ).toBe(2)
  })
})

describe('panes and jobs', () => {
  it('never puts the root shell or the agent in a job, and groups tools by session', () => {
    twoPanes()
    const { g } = guard()
    const { panes, runs } = g.snapshot()
    const a = panes.get(A) as Pane
    expect(a.root).toBe(100)
    expect([...a.agents]).toEqual([101])
    expect([...(panes.get(B) as Pane).agents]).toEqual([501]) // codex found by argv
    const { jobs } = buildJobs(panes, runs)
    const pids = jobs.flatMap((j) => j.members.map((p) => p.pid))
    expect(pids).not.toContain(100)
    expect(pids).not.toContain(101)
    expect(pids).not.toContain(501)
    expect(
      jobs
        .find((j) => j.key[1] === 200)
        ?.members.map((p) => p.pid)
        .sort(),
    ).toEqual([200, 201])
  })
})

describe('JobGuard', () => {
  it('kills the largest tool job only after memory stayed critical, and records it first', () => {
    twoPanes()
    const { g, killed } = guard()
    setState('red', T0)
    g.tick(T0)
    expect(killed).toEqual([]) // critical for 0 s
    setState('red', T0 + 10_000)
    g.tick(T0 + 10_000)
    expect(killed).toEqual([600])
    const kill = records().find((r) => r.kind === 'kill')
    expect(kill).toMatchObject({
      v: 1,
      killer: 'tether',
      scope: B,
      pid: 600,
      class: 'tool',
      host_state: 'red',
    })
  })

  it('waits the kill gap between kills and never kills while not critical', () => {
    twoPanes()
    const { g, killed } = guard({ killGapSeconds: 30 })
    setState('green', T0)
    g.tick(T0)
    setState('red', T0 + 5_000)
    g.tick(T0 + 5_000)
    g.tick(T0 + 15_000)
    expect(killed).toEqual([600])
    g.tick(T0 + 25_000) // 10 s after the kill: inside the gap
    expect(killed).toEqual([600])
  })

  it('follows background-first with the foreground pane, and does nothing when kills are off', () => {
    twoPanes()
    const bg = guard({ killOrder: 'background-first' }, { foreground: B })
    setState('red', T0)
    bg.g.tick(T0)
    bg.g.tick(T0 + 10_000)
    expect(bg.killed).toEqual([200, 201])
    const off = guard({ killEnabled: false })
    off.g.tick(T0)
    off.g.tick(T0 + 10_000)
    expect(off.killed).toEqual([])
  })

  it('kills nothing without a fresh host verdict', () => {
    twoPanes()
    const { g, killed } = guard()
    writeFileSync(
      admission,
      JSON.stringify({ v: 1, state: 'red', expires_at: Math.floor(T0 / 1000) - 1 }),
    )
    g.tick(T0)
    g.tick(T0 + 20_000)
    expect(killed).toEqual([])
    expect(parseHostState('nope', T0)).toBeNull()
  })

  it('records an agent that is the biggest user instead of killing it', () => {
    twoPanes()
    addProc(A, { pid: 102, ppid: 101, pgid: 101, sid: 100, comm: 'claude', bytes: 8 * GIB })
    const { g, killed } = guard()
    setState('red', T0)
    g.tick(T0)
    g.tick(T0 + 10_000)
    expect(records().find((r) => r.kind === 'agent-hog')).toMatchObject({
      scope: A,
      class: 'agent',
    })
    expect(killed).not.toContain(101)
    expect(killed).not.toContain(102)
  })

  it('moves tools off the agent oom_score_adj and says in its heartbeat whether a job may be stopped', () => {
    twoPanes()
    const { g } = guard()
    setState('green', T0)
    g.tick(T0)
    expect(readFileSync(join(proc, '201', 'oom_score_adj'), 'utf8')).toBe('200')
    expect(readFileSync(join(proc, '101', 'oom_score_adj'), 'utf8').trim()).toBe('100')
    expect(JSON.parse(readFileSync(heartbeat, 'utf8'))).toMatchObject({
      v: 1,
      host_state: 'green',
      kill_candidate: false,
    })
    setState('red', T0 + 5_000)
    g.tick(T0 + 5_000)
    expect(JSON.parse(readFileSync(heartbeat, 'utf8'))).toMatchObject({
      host_state: 'red',
      kill_candidate: true,
    })
    // the owner's group reads it through the runtime dir (shared mode); the umask 0077 would have made it 0600
    expect(statSync(heartbeat).mode & 0o777).toBe(0o644)
  })

  it('appends to ~/.local/state/nightshift unless TETHER_NIGHTSHIFT_EVENTS names an absolute path', () => {
    expect(memoryEventsPath({}, '/home/u')).toBe(
      '/home/u/.local/state/nightshift/memory-events.jsonl',
    )
    expect(memoryEventsPath({ XDG_STATE_HOME: '/s' }, '/home/u')).toBe(
      '/s/nightshift/memory-events.jsonl',
    )
    expect(memoryEventsPath({ TETHER_NIGHTSHIFT_EVENTS: '/home/u/e.jsonl' }, '/home/u')).toBe(
      '/home/u/e.jsonl',
    )
    expect(memoryEventsPath({ TETHER_NIGHTSHIFT_EVENTS: 'e.jsonl' }, '/home/u')).toBe(
      '/home/u/.local/state/nightshift/memory-events.jsonl',
    )
  })
})

describe('pane caps', () => {
  function capHost(policies: Record<string, string> = {}) {
    const calls: string[] = []
    const host: PaneCapHost = {
      async setCap(scope, memory, swap) {
        calls.push(`${scope} ${memory / GIB} ${swap / GIB}`)
      },
      async oomPolicy(scope) {
        return policies[scope] ?? 'continue'
      },
    }
    return { host, calls }
  }

  it('caps an uncapped pane, keeps a hand-raised one, skips one near the cap or not on continue', async () => {
    paneFiles(A) // uncapped
    paneFiles(B, String(20 * GIB)) // raised by hand
    const C = 'tmux-spawn-88e4121b-a199-4f2d-9827-e613d8d05ee2.scope'
    paneFiles(C, 'max', 11 * GIB) // near the 12 GiB cap
    const D = 'tmux-spawn-99e4121b-a199-4f2d-9827-e613d8d05ee2.scope'
    paneFiles(D) // OOMPolicy=stop
    const { host, calls } = capHost({ [D]: 'stop' })
    const { g } = guard({}, { caps: host })
    setState('green', T0)
    g.tick(T0)
    await g.settled()
    expect(calls).toEqual([`${A} 12 2`])
  })

  it('moves panes still at the old cap when the owner changes it, never on red', async () => {
    paneFiles(A, String(12 * GIB))
    const { host, calls } = capHost()
    let policy: Partial<MemoryPolicy> = {}
    const killed: number[] = []
    const g = new JobGuard({
      uid: UID,
      procRoot: proc,
      cgroupRoot: join(dir, 'sys'),
      admissionPath: admission,
      eventsPath: events,
      heartbeatPath: heartbeat,
      agentNames: () => AGENT_NAMES,
      policy: () => ({ ...DEFAULT_MEMORY_POLICY, ...policy }),
      kill: (_r, pid) => killed.push(pid) > 0,
      caps: host,
      log: () => {},
    })
    g.capChanged({ ...DEFAULT_MEMORY_POLICY })
    policy = { paneMemoryMaxGib: 16 }
    setState('red', T0)
    g.tick(T0)
    await g.settled()
    expect(calls).toEqual([])
    setState('green', T0 + 5_000)
    g.tick(T0 + 5_000)
    await g.settled()
    expect(calls).toEqual([`${A} 16 2`])
  })
})
