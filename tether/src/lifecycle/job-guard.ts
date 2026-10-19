/**
 * Runaway agent-job guard (default instance only, every 5 s).
 *
 * Nightshift owns host memory: its memctl publishes the host's state in
 * admission.json (green, amber, red). Tether owns what happens inside the
 * agent panes, by the owner's memory policy (src/memory-policy.ts):
 *   amber or red  the fastest-growing pane gets a warning record, so its agent
 *                 hears about it (at most once per pane per 30 min)
 *   red           once memory has been critical for killAfterSeconds, the
 *                 largest agent tool job of at least killMinGib is killed (in
 *                 killOrder), at most one every killGapSeconds
 * A tool job is one tool session (a Claude Bash call is its own session) or,
 * when it shares the agent's session (Codex), the process tree under one agent
 * child; it can sit in a pane or in a run-*.scope started from one. The guard
 * never kills a pane's root shell or its agent (claude, codex): an agent that
 * is itself the biggest user is only recorded (agent-hog).
 * Each tick it also moves pane tools that inherited the agent's oom_score_adj
 * 100 back to 200, so the kernel prefers a tool over the agent.
 *
 * Records go to the shared memory event record Nightshift's readers already
 * read (~/.local/state/nightshift/memory-events.jsonl, schema v1, killer
 * "tether"); the kill record is written before the signal. The heartbeat
 * ($runtimeDir/memory-guard.json) tells Nightshift whether a job the guard
 * may stop exists (its outside-hog note waits for that) and that the guard is
 * alive. On red the guard only reads /proc and /sys.
 */

import { execFile } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { GIB, type KillOrder, type MemoryPolicy } from '../memory-policy'

export const TICK_MS = 5_000
const GROWTH_WINDOW = 12 // ticks (60 s) used to rank pane growth
const MIN_GROWTH = 256 * 2 ** 20
const NOTE_GAP_MS = 1_800_000
export const AGENT_ADJ = 100
export const TOOL_ADJ = 200
const AGENT_COMMS = new Set(['claude', 'codex'])
const AGENT_BINS = new Set(['claude', 'codex', 'codex-real'])
const CMDLINE_HEAD = 200
const CACHE_CMD_MIN = 256 * 2 ** 20
const EVENTS_MAX_BYTES = 2 * 2 ** 20
/** A pane already using this share of the cap is left uncapped by the sweep:
 * the cap would take a process from it at once. */
const CAP_HEADROOM = 5 / 6

export type HostState = 'green' | 'amber' | 'red'

export interface Proc {
  pid: number
  ppid: number
  pgid: number
  sid: number
  /** Clock ticks since boot: with the pid, the process identity. */
  starttime: number
  comm: string
  /** RssAnon + VmSwap. */
  bytes: number
  adj: number | null
  /** The pane or run-*.scope it was found in. */
  unit: string
}

export interface Pane {
  scope: string
  procs: Map<number, Proc>
  root: number | null
  agents: Set<number>
}

export interface Job {
  scope: string
  key: ['sid' | 'tree', number]
  members: Proc[]
}

export function protectedPids(pane: Pane): Set<number> {
  const out = new Set(pane.agents)
  if (pane.root !== null) out.add(pane.root)
  return out
}

export function agentBytes(pane: Pane): number {
  let total = 0
  for (const pid of pane.agents) total += pane.procs.get(pid)?.bytes ?? 0
  return total
}

export function jobBytes(job: Job): number {
  return job.members.reduce((sum, p) => sum + p.bytes, 0)
}

/** The biggest member: the process a record names. */
export function jobTop(job: Job): Proc {
  return job.members.reduce((best, p) =>
    p.bytes > best.bytes || (p.bytes === best.bytes && p.pid < best.pid) ? p : best,
  )
}

export function isAgentProcess(comm: string, argv: string[]): boolean {
  return AGENT_COMMS.has(comm) || argv.slice(0, 2).some((a) => AGENT_BINS.has(basename(a)))
}

/**
 * Find a pane's root shell and agents. An agent is a claude/codex the root
 * shell started, or an agent child of an agent in that agent's process group
 * (codex-real under codex). Codex tools run in their own process groups, so a
 * `codex exec` tool stays a tool. With no root shell every agent process is
 * protected: sparing a tool beats killing the agent.
 * `agentOf(p, seed)`: seed is true for a direct child of the root (or a
 * process whose parent is outside the pane).
 */
export function makePane(
  scope: string,
  procs: Map<number, Proc>,
  agentOf: (p: Proc, seed: boolean) => boolean,
  parentComm: (pid: number) => string,
): Pane {
  const all = [...procs.values()]
  const roots = all.filter((p) => !procs.has(p.ppid) && parentComm(p.ppid) !== 'systemd')
  const root =
    roots.length > 0
      ? roots.reduce((a, b) =>
          b.starttime < a.starttime || (b.starttime === a.starttime && b.pid < a.pid) ? b : a,
        )
      : null
  const seeds = root
    ? all.filter((p) => p.ppid === root.pid && agentOf(p, true))
    : all.filter((p) => agentOf(p, !procs.has(p.ppid)))
  const agents = new Set(seeds.map((p) => p.pid))
  const frontier = [...seeds]
  while (frontier.length > 0) {
    const parent = frontier.pop() as Proc
    for (const p of all) {
      if (
        p.ppid === parent.pid &&
        p.pgid === parent.pgid &&
        !agents.has(p.pid) &&
        agentOf(p, false)
      ) {
        agents.add(p.pid)
        frontier.push(p)
      }
    }
  }
  return { scope, procs, root: root?.pid ?? null, agents }
}

/** Group every unprotected pane process, and every run-*.scope process whose
 * parent chain reaches a pane, into tool jobs (largest first). Also returns
 * the run-scope processes that belong to no pane. */
export function buildJobs(
  panes: Map<string, Pane>,
  runs: Map<number, Proc>,
): { jobs: Job[]; outside: Proc[] } {
  const all = new Map(runs)
  const owner = new Map<number, string>()
  for (const pane of panes.values()) {
    for (const [pid, p] of pane.procs) {
      all.set(pid, p)
      owner.set(pid, pane.scope)
    }
  }
  const paneOf = (start: number): string | null => {
    let pid = start
    for (let seen = 0; all.has(pid) && seen < 64; seen++) {
      const scope = owner.get(pid)
      if (scope) return scope
      pid = (all.get(pid) as Proc).ppid
    }
    return null
  }
  const groups = new Map<string, Job>()
  const outside: Proc[] = []
  for (const [pid, p] of all) {
    const scope = paneOf(pid)
    if (scope === null) {
      outside.push(p)
      continue
    }
    const pane = panes.get(scope) as Pane
    const guarded = protectedPids(pane)
    if (guarded.has(pid)) continue
    const rootSid = pane.root !== null ? (pane.procs.get(pane.root)?.sid ?? null) : null
    let key: Job['key']
    if (p.sid !== rootSid) key = ['sid', p.sid]
    else {
      // shares the agent's session (Codex tools, MCP servers): the tree under one agent child
      let top = p
      for (;;) {
        const parent = all.get(top.ppid)
        if (!parent || guarded.has(top.ppid) || parent.sid !== rootSid) break
        top = parent
      }
      key = ['tree', top.pid]
    }
    const id = `${scope}\0${key[0]}\0${key[1]}`
    const job = groups.get(id) ?? { scope, key, members: [] }
    job.members.push(p)
    groups.set(id, job)
  }
  const jobs = [...groups.values()].sort((a, b) => jobBytes(b) - jobBytes(a) || a.key[1] - b.key[1])
  return { jobs, outside }
}

/**
 * The job to kill, by the owner's kill order, if it holds at least minBytes.
 *   largest           the biggest job anywhere
 *   background-first  the biggest job outside the foreground pane, if one is
 *                     big enough; else the biggest job in the foreground pane
 */
export function chooseVictim(
  jobs: Iterable<Job>,
  minBytes: number,
  order: KillOrder = 'largest',
  foreground: string | null = null,
): Job | null {
  const eligible = [...jobs].filter((j) => jobBytes(j) >= minBytes)
  const biggest = (list: Job[]) =>
    list.reduce<Job | null>(
      (best, j) =>
        best === null ||
        jobBytes(j) > jobBytes(best) ||
        (jobBytes(j) === jobBytes(best) && j.key[1] < best.key[1])
          ? j
          : best,
      null,
    )
  if (order === 'background-first' && foreground) {
    return biggest(eligible.filter((j) => j.scope !== foreground)) ?? biggest(eligible)
  }
  return biggest(eligible)
}

/** Pane whose anon memory grew most over the window, if it grew enough. */
export function fastestPane(history: Map<string, number[]>, minGrowth = MIN_GROWTH): string | null {
  let best: string | null = null
  let grown = minGrowth - 1
  for (const [name, xs] of history) {
    if (xs.length >= 2) {
      const delta = (xs.at(-1) as number) - (xs[0] as number)
      if (delta > grown) {
        best = name
        grown = delta
      }
    }
  }
  return best
}

/** Host state from Nightshift's admission.json (contract v1); null when it
 * is missing, unreadable or past expires_at: no verdict, no kill. */
export function parseHostState(text: string, nowMs: number): HostState | null {
  try {
    const doc = JSON.parse(text) as Record<string, unknown>
    if (doc.v !== 1 || typeof doc.expires_at !== 'number' || doc.expires_at * 1000 <= nowMs)
      return null
    return doc.state === 'green' || doc.state === 'amber' || doc.state === 'red' ? doc.state : null
  } catch {
    return null
  }
}

export function anonBytes(memoryStat: string): number {
  for (const line of memoryStat.split('\n')) {
    const [key, value] = line.split(' ')
    if (key === 'anon') return Number(value) || 0
  }
  return 0
}

function gib(n: number): string {
  return `${(n / GIB).toFixed(1)} GiB`
}

// --- /proc and cgroup readers ----------------------------------------------

export function readStat(
  procRoot: string,
  pid: number,
): { comm: string; ppid: number; pgid: number; sid: number; starttime: number } | null {
  try {
    const s = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8')
    const close = s.lastIndexOf(')')
    const f = s
      .slice(close + 2)
      .trim()
      .split(/\s+/)
    return {
      comm: s.slice(s.indexOf('(') + 1, close),
      ppid: Number(f[1]),
      pgid: Number(f[2]),
      sid: Number(f[3]),
      starttime: Number(f[19]),
    }
  } catch {
    return null
  }
}

export function readProc(procRoot: string, pid: number, unit: string): Proc | null {
  const st = readStat(procRoot, pid)
  if (!st) return null
  let kb = 0
  try {
    for (const line of readFileSync(join(procRoot, String(pid), 'status'), 'utf8').split('\n')) {
      const [key, rest] = line.split(':')
      if (key === 'RssAnon' || key === 'VmSwap') kb += Number.parseInt(rest?.trim() ?? '0', 10) || 0
    }
  } catch {
    // gone or unreadable: counted as zero
  }
  let adj: number | null = null
  try {
    adj = Number.parseInt(readFileSync(join(procRoot, String(pid), 'oom_score_adj'), 'utf8'), 10)
    if (Number.isNaN(adj)) adj = null
  } catch {
    adj = null
  }
  return { pid, ...st, bytes: kb * 1024, adj, unit }
}

function argvOf(procRoot: string, pid: number): string[] {
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'), 'utf8')
      .split('\0')
      .slice(0, -1)
  } catch {
    return []
  }
}

function cmdlineHead(procRoot: string, pid: number): string | null {
  return argvOf(procRoot, pid).join(' ').slice(0, CMDLINE_HEAD) || null
}

function commOf(procRoot: string, pid: number): string {
  try {
    return readFileSync(join(procRoot, String(pid), 'comm'), 'utf8').trim()
  } catch {
    return ''
  }
}

function cgroupPids(dir: string): number[] {
  const out: number[] = []
  const pending = [dir]
  while (pending.length > 0) {
    const d = pending.pop() as string
    try {
      for (const x of readFileSync(join(d, 'cgroup.procs'), 'utf8').split('\n')) {
        const pid = Number(x)
        if (Number.isInteger(pid) && pid > 0) out.push(pid)
      }
      for (const entry of readdirSync(d, { withFileTypes: true }))
        if (entry.isDirectory()) pending.push(join(d, entry.name))
    } catch {
      // the cgroup went away mid-walk
    }
  }
  return out
}

function readNumber(path: string): number | null {
  try {
    const text = readFileSync(path, 'utf8').trim()
    if (text === 'max') return Number.POSITIVE_INFINITY
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/** SIGKILL pid only if it is still the process that started at starttime.
 * Node has no pidfd API, so the window between check and signal is a few
 * microseconds; a pid reused inside it is practically impossible (pid_max). */
export function killIfSame(procRoot: string, pid: number, starttime: number): boolean {
  const st = readStat(procRoot, pid)
  if (!st || st.starttime !== starttime) return false
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

function setAdj(procRoot: string, p: Proc, value: number): boolean {
  const st = readStat(procRoot, p.pid)
  if (!st || st.starttime !== p.starttime) return false
  try {
    writeFileSync(join(procRoot, String(p.pid), 'oom_score_adj'), String(value))
    return true
  } catch {
    return false
  }
}

/** The shared memory event record (Nightshift memevents.py, schema v1) this
 * Tether appends to: ~/.local/state/nightshift/memory-events.jsonl, or the
 * absolute path in TETHER_NIGHTSHIFT_EVENTS (a Tether running as another user
 * than Nightshift's keeps its own file where Nightshift can read it). */
export function memoryEventsPath(env: NodeJS.ProcessEnv, home: string): string {
  if (env.TETHER_NIGHTSHIFT_EVENTS?.startsWith('/')) return env.TETHER_NIGHTSHIFT_EVENTS
  return join(
    env.XDG_STATE_HOME || join(home, '.local', 'state'),
    'nightshift',
    'memory-events.jsonl',
  )
}

const EVENT_FIELDS = [
  'ts',
  'kind',
  'killer',
  'scope',
  'tether_session_id',
  'pid',
  'starttime',
  'comm',
  'cmdline_head',
  'bytes',
  'class',
  'host_state',
] as const

export function appendMemoryEvent(
  path: string,
  record: Record<string, unknown>,
  maxBytes = EVENTS_MAX_BYTES,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 })
  try {
    if (statSync(path).size >= maxBytes) renameSync(path, `${path}.1`)
  } catch {
    // no file yet
  }
  appendFileSync(path, `${JSON.stringify(record)}\n`)
}

function writeAtomic(path: string, doc: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.${basename(path)}.tmp`)
  writeFileSync(tmp, JSON.stringify(doc))
  chmodSync(tmp, 0o644) // numbers only; the dir's own mode says who can reach it (shared mode: the owner's group)
  renameSync(tmp, path)
}

// --- pane caps -------------------------------------------------------------

export interface PaneCapHost {
  /** systemctl --user set-property --runtime <scope> MemoryMax= MemorySwapMax= */
  setCap(scope: string, memoryMax: number, swapMax: number): Promise<void>
  /** The pane scope's OOMPolicy, null when unknown or gone. */
  oomPolicy(scope: string): Promise<string | null>
}

const exec = promisify(execFile)

export const systemdPaneCapHost: PaneCapHost = {
  async setCap(scope, memoryMax, swapMax) {
    await exec(
      'systemctl',
      [
        '--user',
        'set-property',
        '--runtime',
        scope,
        `MemoryMax=${memoryMax}`,
        `MemorySwapMax=${swapMax}`,
      ],
      { timeout: 10_000 },
    )
  },
  async oomPolicy(scope) {
    try {
      const { stdout } = await exec(
        'systemctl',
        ['--user', 'show', '-p', 'OOMPolicy', '--value', '--', scope],
        { timeout: 5_000 },
      )
      return stdout.trim() || null
    } catch {
      return null
    }
  },
}

// --- the guard -------------------------------------------------------------

export interface JobGuardOptions {
  uid: number
  procRoot?: string
  cgroupRoot?: string
  /** Nightshift's admission.json; null means no host verdict ever. */
  admissionPath: string | null
  eventsPath: string
  heartbeatPath: string
  policy: () => MemoryPolicy
  /** The pane scope the owner is looking at (background-first). */
  foreground?: () => string | null
  /** Pane scope -> Tether session id, for records. */
  sessionOf?: () => Map<string, string>
  kill?: (procRoot: string, pid: number, starttime: number) => boolean
  caps?: PaneCapHost
  /** Proofs: read, warn about, re-adjust, cap and kill nothing outside these panes. */
  onlyScopes?: Iterable<string>
  log?: (message: string) => void
}

export class JobGuard {
  private readonly procRoot: string
  private readonly app: string
  private readonly only: Set<string> | null
  private readonly kill: (procRoot: string, pid: number, starttime: number) => boolean
  private readonly caps: PaneCapHost
  private readonly log: (message: string) => void
  state: HostState | null = null
  criticalSince: number | null = null
  lastKill = Number.NEGATIVE_INFINITY
  private history = new Map<string, number[]>()
  private noted = new Map<string, number>()
  private agentCache = new Map<string, boolean>()
  private cmdCache = new Map<number, { starttime: number; cmd: string | null }>()
  private policyCache = new Map<string, string | null>()
  private capping: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | null = null
  /** Previous cap, set when the owner changes it: panes still at it move. */
  private previousCap: { memory: number; swap: number } | null = null

  constructor(private readonly options: JobGuardOptions) {
    this.procRoot = options.procRoot ?? '/proc'
    const cg = options.cgroupRoot ?? '/sys/fs/cgroup'
    this.app = join(
      cg,
      `user.slice/user-${options.uid}.slice/user@${options.uid}.service/app.slice`,
    )
    this.only = options.onlyScopes ? new Set(options.onlyScopes) : null
    this.kill = options.kill ?? killIfSame
    this.caps = options.caps ?? systemdPaneCapHost
    this.log = options.log ?? ((m) => console.log(`[tether:memory-guard] ${m}`))
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.tick(Date.now())
      } catch (error) {
        this.log(`tick failed: ${(error as Error).message}`)
      }
    }, TICK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The owner changed the cap: panes still at the old one get the new one. */
  capChanged(previous: MemoryPolicy): void {
    this.previousCap = {
      memory: previous.paneMemoryMaxGib * GIB,
      swap: previous.paneSwapMaxGib * GIB,
    }
  }

  private allowed(scope: string): boolean {
    return this.only === null || this.only.has(scope)
  }

  private paneNames(): string[] {
    try {
      return readdirSync(this.app).filter(
        (n) => n.startsWith('tmux-spawn-') && n.endsWith('.scope') && this.allowed(n),
      )
    } catch {
      return []
    }
  }

  private agentOf = (p: Proc, seed: boolean): boolean => {
    const key = `${p.pid}:${p.starttime}`
    const cached = this.agentCache.get(key)
    if (cached !== undefined) return cached
    let verdict: boolean
    if (AGENT_COMMS.has(p.comm)) verdict = true
    else if (this.state === 'red' && !seed)
      return false // asked again once memory is not critical
    else verdict = isAgentProcess(p.comm, argvOf(this.procRoot, p.pid))
    this.agentCache.set(key, verdict)
    return verdict
  }

  snapshot(): { panes: Map<string, Pane>; runs: Map<number, Proc> } {
    const panes = new Map<string, Pane>()
    const seen = new Set<string>()
    for (const name of this.paneNames()) {
      const procs = new Map<number, Proc>()
      for (const pid of cgroupPids(join(this.app, name))) {
        const p = readProc(this.procRoot, pid, name)
        if (p) {
          procs.set(pid, p)
          seen.add(`${pid}:${p.starttime}`)
        }
      }
      panes.set(
        name,
        makePane(name, procs, this.agentOf, (pid) => commOf(this.procRoot, pid)),
      )
    }
    for (const key of this.agentCache.keys()) if (!seen.has(key)) this.agentCache.delete(key)
    const runs = new Map<number, Proc>()
    try {
      for (const name of readdirSync(this.app)) {
        if (!name.startsWith('run-') || !name.endsWith('.scope')) continue
        for (const pid of cgroupPids(join(this.app, name))) {
          const p = readProc(this.procRoot, pid, name)
          if (p) runs.set(pid, p)
        }
      }
    } catch {
      // no app.slice
    }
    return { panes, runs }
  }

  private cmdline(p: Proc, readNow: boolean): string | null {
    const old = this.cmdCache.get(p.pid)
    if (old && old.starttime === p.starttime && old.cmd !== null) return old.cmd
    if (!readNow || this.state === 'red') return null
    const cmd = cmdlineHead(this.procRoot, p.pid)
    this.cmdCache.set(p.pid, { starttime: p.starttime, cmd })
    return cmd
  }

  private procFields(p: Proc, cls: string): Record<string, unknown> {
    return {
      pid: p.pid,
      starttime: p.starttime,
      comm: p.comm,
      cmdline_head: this.cmdline(p, true),
      class: cls,
    }
  }

  private emit(kind: string, now: number, fields: Record<string, unknown>): void {
    const scope = typeof fields.scope === 'string' ? fields.scope : null
    const record: Record<string, unknown> = { v: 1 }
    for (const key of EVENT_FIELDS) record[key] = null
    Object.assign(record, fields, {
      ts: Math.round(now) / 1000,
      kind,
      host_state: this.state,
      tether_session_id: scope ? (this.options.sessionOf?.().get(scope) ?? null) : null,
    })
    try {
      appendMemoryEvent(this.options.eventsPath, record)
    } catch (error) {
      this.log(`could not write the memory event record: ${(error as Error).message}`)
    }
  }

  private due(kind: string, scope: string, now: number): boolean {
    const key = `${kind}\0${scope}`
    if (now - (this.noted.get(key) ?? Number.NEGATIVE_INFINITY) < NOTE_GAP_MS) return false
    this.noted.set(key, now)
    return true
  }

  private readState(now: number): HostState | null {
    if (!this.options.admissionPath) return null
    try {
      return parseHostState(readFileSync(this.options.admissionPath, 'utf8'), now)
    } catch {
      return null
    }
  }

  tick(now: number): Record<string, unknown> {
    const policy = this.options.policy()
    this.state = this.readState(now)
    if (this.state === 'red') this.criticalSince ??= now
    else this.criticalSince = null
    const { panes, runs } = this.snapshot()
    const { jobs } = buildJobs(panes, runs)
    for (const name of panes.keys()) {
      const anon = anonBytes(readFileSafe(join(this.app, name, 'memory.stat')))
      const xs = this.history.get(name) ?? []
      xs.push(anon)
      this.history.set(name, xs.slice(-GROWTH_WINDOW))
    }
    for (const name of [...this.history.keys()]) if (!panes.has(name)) this.history.delete(name)
    this.restoreAdj(jobs)
    if (this.state === 'amber' || this.state === 'red') this.warn(now, panes, jobs)
    let candidate: Job | null = null
    if (this.state === 'red') candidate = this.actRed(now, policy, panes, jobs)
    else this.sweepCaps(policy, panes)
    if (this.state !== 'red') this.primeCmdlines(panes, jobs)
    const doc = this.heartbeat(now, policy, candidate)
    try {
      writeAtomic(this.options.heartbeatPath, doc)
    } catch (error) {
      this.log(`could not write the heartbeat: ${(error as Error).message}`)
    }
    return doc
  }

  private restoreAdj(jobs: Job[]): void {
    for (const job of jobs) {
      if (!this.allowed(job.scope)) continue
      for (const p of job.members) if (p.adj === AGENT_ADJ) setAdj(this.procRoot, p, TOOL_ADJ)
    }
  }

  private warn(now: number, panes: Map<string, Pane>, jobs: Job[]): void {
    const top = fastestPane(this.history)
    if (top === null || !panes.has(top) || !this.due('warning', top, now)) return
    const pane = panes.get(top) as Pane
    const job = jobs.find((j) => j.scope === top)
    if (job) {
      this.emit('warning', now, {
        scope: top,
        bytes: jobBytes(job),
        members: job.members.length,
        ...this.procFields(jobTop(job), 'tool'),
      })
    } else if (pane.agents.size > 0) {
      this.emit('warning', now, {
        scope: top,
        bytes: agentBytes(pane),
        ...this.procFields(firstAgent(pane), 'agent'),
      })
    } else {
      this.emit('warning', now, {
        scope: top,
        bytes: this.history.get(top)?.at(-1) ?? null,
        class: 'container',
      })
    }
  }

  /** Returns the job it would kill (or killed), for the heartbeat. */
  private actRed(
    now: number,
    policy: MemoryPolicy,
    panes: Map<string, Pane>,
    jobs: Job[],
  ): Job | null {
    const minBytes = policy.killMinGib * GIB
    const victim = chooseVictim(
      jobs.filter((j) => this.allowed(j.scope)),
      minBytes,
      policy.killOrder,
      this.options.foreground?.() ?? null,
    )
    const ripe = now - (this.criticalSince ?? now) >= policy.killAfterSeconds * 1000 - TICK_MS / 2
    if (!policy.killEnabled || !ripe || now - this.lastKill < policy.killGapSeconds * 1000)
      return victim
    let hog: Pane | null = null
    for (const pane of panes.values()) if (!hog || agentBytes(pane) > agentBytes(hog)) hog = pane
    if (
      hog &&
      agentBytes(hog) >= minBytes &&
      agentBytes(hog) > (victim ? jobBytes(victim) : 0) &&
      this.due('agent-hog', hog.scope, now)
    ) {
      this.emit('agent-hog', now, {
        scope: hog.scope,
        bytes: agentBytes(hog),
        ...this.procFields(firstAgent(hog), 'agent'),
      })
      this.log(
        `memory critical; the agent in ${hog.scope} is the biggest user (${gib(agentBytes(hog))}), not killed`,
      )
    }
    if (victim) this.killJob(now, victim)
    return victim
  }

  killJob(now: number, job: Job): number {
    if (!this.allowed(job.scope)) return 0
    this.lastKill = now
    const top = jobTop(job)
    this.emit('kill', now, {
      killer: 'tether',
      scope: job.scope,
      bytes: jobBytes(job),
      members: job.members.length,
      ...this.procFields(top, 'tool'),
    })
    const done = new Set<number>()
    for (const p of job.members) if (this.kill(this.procRoot, p.pid, p.starttime)) done.add(p.pid)
    // once more, for processes the job forked meanwhile
    const { panes, runs } = this.snapshot()
    for (const again of buildJobs(panes, runs).jobs) {
      if (again.scope !== job.scope || again.key[0] !== job.key[0] || again.key[1] !== job.key[1])
        continue
      for (const p of again.members)
        if (!done.has(p.pid) && this.kill(this.procRoot, p.pid, p.starttime)) done.add(p.pid)
    }
    this.log(
      `memory critical; killed the tool job of ${top.comm} (pid ${top.pid}): ${done.size} processes, ${gib(jobBytes(job))}, in ${job.scope}`,
    )
    return done.size
  }

  /** Every pane at no cap (or at the cap the owner just replaced) gets the
   * owner's cap at runtime, unless it is not on OOMPolicy=continue (a cap
   * would stop the whole pane) or already near the cap. Never on red. */
  private sweepCaps(policy: MemoryPolicy, panes: Map<string, Pane>): void {
    const memory = policy.paneMemoryMaxGib * GIB
    const swap = policy.paneSwapMaxGib * GIB
    const previous = this.previousCap
    const targets: string[] = []
    for (const name of panes.keys()) {
      const max = readNumber(join(this.app, name, 'memory.max'))
      if (max === null || max === memory) continue
      if (max !== Number.POSITIVE_INFINITY && max !== previous?.memory) continue // raised by hand: kept
      const use =
        (readNumber(join(this.app, name, 'memory.current')) ?? 0) +
        (readNumber(join(this.app, name, 'memory.swap.current')) ?? 0)
      if (use >= memory * CAP_HEADROOM) continue
      targets.push(name)
    }
    for (const name of this.policyCache.keys()) if (!panes.has(name)) this.policyCache.delete(name)
    if (targets.length === 0) return
    this.capping = this.capping.then(async () => {
      for (const scope of targets) {
        if (!this.policyCache.has(scope))
          this.policyCache.set(scope, await this.caps.oomPolicy(scope))
        if (this.policyCache.get(scope) !== 'continue') continue
        try {
          await this.caps.setCap(scope, memory, swap)
          this.log(`capped ${scope} at ${gib(memory)} + ${gib(swap)} swap`)
        } catch (error) {
          this.log(`could not cap ${scope}: ${(error as Error).message}`)
        }
      }
    })
  }

  /** Wait for queued cap changes (tests). */
  settled(): Promise<void> {
    return this.capping
  }

  /** Cache command lines while memory is not critical, for the processes a
   * record on red may name (agents, and tools of 256 MiB or more): on red a
   * read can stall on a thrashing process. */
  private primeCmdlines(panes: Map<string, Pane>, jobs: Job[]): void {
    const keep = new Set<number>()
    for (const pane of panes.values())
      for (const pid of pane.agents) {
        const p = pane.procs.get(pid)
        if (p) {
          keep.add(pid)
          this.cmdline(p, true)
        }
      }
    for (const job of jobs)
      for (const p of job.members) {
        keep.add(p.pid)
        this.cmdline(p, p.bytes >= CACHE_CMD_MIN)
      }
    for (const pid of this.cmdCache.keys()) if (!keep.has(pid)) this.cmdCache.delete(pid)
  }

  private heartbeat(
    now: number,
    policy: MemoryPolicy,
    candidate: Job | null,
  ): Record<string, unknown> {
    return {
      v: 1,
      ts: Math.floor(now / 1000),
      pid: process.pid,
      host_state: this.state,
      critical_since: this.criticalSince ? Math.floor(this.criticalSince / 1000) : null,
      last_kill_at: Number.isFinite(this.lastKill) ? Math.floor(this.lastKill / 1000) : null,
      kill_enabled: policy.killEnabled,
      // a tool job the guard may stop exists: Nightshift's outside-hog waits for it
      kill_candidate: candidate !== null && policy.killEnabled,
    }
  }
}

function firstAgent(pane: Pane): Proc {
  let best: Proc | null = null
  for (const pid of pane.agents) {
    const p = pane.procs.get(pid)
    if (p && (!best || p.starttime < best.starttime)) best = p
  }
  return best as Proc
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
