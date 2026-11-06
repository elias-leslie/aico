// What the pull kinds of a wait read (src/wait-kinds.ts), from each thing's
// owner, read-only: SummitFlow's job files and coordination ledger, Tether's
// own asks and hub peers. Files are read when they change (a directory
// watch), on a nudge, at every 60 s look and at start. A job whose runner
// may have died is asked of its owner's CLI (`st service result`) as an
// idle-weight transient unit, at most once a minute per job, never while
// admission is red.
//
// A `cmd` wait's watcher runs as a transient user unit `aico-wait-<ref>`
// (idle CPU weight, 512M, bounded by the wait's deadline), started only while
// admission is not red. Its ExecStopPost writes systemd's own result words to
// `<cmdDir>/<ref>.result`, so Tether reads how it ended on exit (the
// directory watch) and after a restart, whether or not the unit is still loaded.

import { execFile } from 'node:child_process'
import {
  type FSWatcher,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { CMD_UNIT_PREFIX, JOB_FINAL, type PullKind, type PullRead } from './wait-kinds'

const JOB_ID = /^[0-9a-f]{32}$/
const CMD_REF = /^[0-9a-f]{12}$/
/** A path systemd's Exec line and sh both take as it is. */
const PLAIN_PATH = /^\/[A-Za-z0-9/._-]+$/
/** A unit outlives its wait's deadline by this much: the wait times out first,
 * with the watcher's state, then stops it. */
const CMD_GRACE_SECONDS = 60
/** A probe of one job at most this often (a nudge skips it). */
const PROBE_EVERY_MS = 60_000

export interface PullReaderPaths {
  /** SummitFlow's service jobs (`<32 hex>.json`). */
  jobsDir: string
  /** Tether's own `cmd` watcher records: `<ref>.json` (what to run),
   * `<ref>.started`, `<ref>.result` (systemd's words for how it ended). */
  cmdDir: string
}

/** What a `cmd` wait runs: the waiter's own argv, in its directory. */
export interface CmdSpec {
  argv: string[]
  cwd: string
  /** The wait's deadline (ms); the unit's RuntimeMaxSec is measured to it. */
  deadline: number
}

/** Starts and stops `cmd` watcher units (systemdCmdUnits; a fake in tests). */
export interface CmdUnits {
  /** `exists`: a unit by that name is running already (started before a restart). */
  start(
    ref: string,
    spec: CmdSpec,
    resultPath: string,
    runtimeSeconds: number,
  ): Promise<'started' | 'exists' | 'failed'>
  stop(ref: string): Promise<void>
}

/** The Aico session a live harness process runs in, from a SummitFlow
 * coordination anchor (`pid:start`, /proc stat start time): its
 * `AICO_WIDGET_ID`, or null when the process is gone, reused or outside Aico. */
export function anchorWidget(
  fs: { readFile(path: string): string },
  anchor: string,
): string | null {
  const m = /^(\d{1,9}):(\d{1,20})$/.exec(anchor)
  if (!m) return null
  try {
    const stat = fs.readFile(`/proc/${m[1]}/stat`)
    if (
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[19] !== m[2]
    )
      return null
    const env = fs.readFile(`/proc/${m[1]}/environ`).split('\0')
    const widget = env
      .find((pair) => pair.startsWith('AICO_WIDGET_ID='))
      ?.slice('AICO_WIDGET_ID='.length)
    return widget && /^[0-9a-f]{8}$/.test(widget) ? widget : null
  } catch {
    return null
  }
}

export interface PullReaderDeps {
  paths: PullReaderPaths
  /** The coordination ledger document (`_coord`, src/coordination/docs.ts): its version and body. */
  ledgerDoc(): { version: number; doc: Record<string, unknown> }
  /** An ask (AskStore.get). */
  ask(id: string): { state: string; question?: string } | undefined
  /** The window title of the agent a coordination identity's anchor (`pid:start`)
   * names, or null (not a live harness in an Aico window). */
  agentTitle?(anchor: string): string | null
  /** A hub peer's state; null when this hub has no such host. */
  host(name: string): string | null
  /** Host admission is red: heavy and probing work waits. */
  admissionRed(): boolean
  /** Run the job's owner CLI: stdout, or null when it could not answer. */
  probeJob?(jobId: string): Promise<string | null>
  /** `cmd` watcher units; without it a `cmd` wait cannot start (`start-failed`). */
  cmdUnits?: CmdUnits
  /** Something a kind reads changed. */
  poke(kind: PullKind, ref?: string): void
  now(): number
  log(message: string): void
}

interface Cached<T> {
  key: string
  value: T
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

/** `st --no-compact service result <id>` as an idle-weight unit, bounded. */
export function systemdProbe(env: NodeJS.ProcessEnv): (jobId: string) => Promise<string | null> {
  env = userBusEnv(env)
  return (jobId) =>
    new Promise((resolve) => {
      if (!JOB_ID.test(jobId)) return resolve(null)
      execFile(
        'systemd-run',
        [
          '--user',
          '--wait',
          '--pipe',
          '--quiet',
          '--collect',
          '-p',
          'CPUWeight=idle',
          '-p',
          'IOWeight=10',
          '-p',
          'MemoryMax=512M',
          '-p',
          'RuntimeMaxSec=60',
          'st',
          '--no-compact',
          'service',
          'result',
          jobId,
        ],
        { env, timeout: 70_000, maxBuffer: 1 << 20 },
        (error, stdout) => resolve(error ? null : stdout),
      )
    })
}

/** `cmd` watchers as transient user units, outside Tether's cgroup. */
export function systemdCmdUnits(env: NodeJS.ProcessEnv): CmdUnits {
  env = userBusEnv(env)
  return {
    start: (ref, spec, resultPath, runtimeSeconds) =>
      new Promise((resolve) => {
        if (!CMD_REF.test(ref) || !PLAIN_PATH.test(resultPath)) return resolve('failed')
        const temp = `${resultPath}.tmp`
        // Read the named variables directly: --expand-environment=no preserves $$ for the shell.
        const record = `ExecStopPost=/bin/sh -c 'printenv SERVICE_RESULT EXIT_CODE EXIT_STATUS > ${temp}; mv ${temp} ${resultPath}'`
        execFile(
          'systemd-run',
          [
            '--user',
            '--no-ask-password',
            '--quiet',
            '--collect',
            '--expand-environment=no',
            `--unit=${CMD_UNIT_PREFIX}${ref}`,
            `--working-directory=${spec.cwd}`,
            '-p',
            'CPUWeight=idle',
            '-p',
            'IOWeight=10',
            '-p',
            'MemoryMax=512M',
            '-p',
            `RuntimeMaxSec=${runtimeSeconds}`,
            '-p',
            record,
            '--',
            ...spec.argv,
          ],
          { env, timeout: 30_000 },
          (error, _stdout, stderr) =>
            resolve(
              !error
                ? 'started'
                : /already exists|already loaded/i.test(stderr)
                  ? 'exists'
                  : 'failed',
            ),
        )
      }),
    stop: (ref) =>
      new Promise((resolve) => {
        if (!CMD_REF.test(ref)) return resolve()
        execFile(
          'systemctl',
          ['--user', '--no-ask-password', 'stop', `${CMD_UNIT_PREFIX}${ref}.service`],
          { env, timeout: 30_000 },
          () => resolve(),
        )
      }),
  }
}

function userBusEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 0}`
  return {
    ...env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
  }
}

/** systemd's words for how a unit ended (`$SERVICE_RESULT $EXIT_CODE
 * $EXIT_STATUS`), as a `cmd` reading: exit 0 succeeded, anything else failed
 * with a typed detail (exit-1, signal-TERM, timeout, oom-kill, start-failed). */
export function cmdResult(text: string): { state: 'succeeded' | 'failed'; detail: string } {
  const [result = '', code = '', status = ''] = text.trim().split(/\s+/)
  if (code === 'exited' && status === '0') return { state: 'succeeded', detail: 'exit-0' }
  const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20)
  if (result && result !== 'success' && result !== 'exit-code' && result !== 'signal')
    return { state: 'failed', detail: clean(result) || 'failed' }
  if (code === 'exited') return { state: 'failed', detail: `exit-${clean(status) || '?'}` }
  if (code === 'killed' || code === 'dumped')
    return { state: 'failed', detail: `signal-${clean(status) || '?'}` }
  return { state: 'failed', detail: 'failed' }
}

export class PullReaders {
  private ledgerCache: Cached<Map<string, Record<string, unknown>> | null> | null = null
  /** Agent id -> identity anchor, from the same ledger read. */
  private anchorsCache: Map<string, string> | null = null
  private readonly probed = new Map<string, { state: string; exit: string | null }>()
  private readonly probing = new Set<string>()
  private readonly probedAt = new Map<string, number>()
  private readonly watchers: FSWatcher[] = []
  private readonly starting = new Set<string>()
  /** Refs whose wait ended while their unit was starting: stopped and dropped
   * once the start returns. */
  private readonly ending = new Set<string>()
  private readonly deferredLogged = new Set<string>()

  constructor(private readonly deps: PullReaderDeps) {}

  /** Watch the owners' files; each change pokes the waits of its kind. A
   * directory that is missing or unreadable is only read at the 60 s look. */
  watch(): void {
    const { paths } = this.deps
    this.watchDir(paths.jobsDir, (name) => {
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (JOB_ID.test(id)) this.deps.poke('job', id)
    })
    try {
      mkdirSync(paths.cmdDir, { recursive: true, mode: 0o700 })
    } catch {
      // Unwritable: a cmd wait then refuses to arm (createCmd).
    }
    this.watchDir(paths.cmdDir, (name) => {
      const ref = name.endsWith('.result') ? name.slice(0, -7) : ''
      if (CMD_REF.test(ref)) this.deps.poke('cmd', ref)
    })
  }

  private watchDir(dir: string, changed: (name: string) => void): void {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, name) => {
        if (typeof name === 'string') changed(name)
      })
      watcher.on('error', () => watcher.close())
      this.watchers.push(watcher)
    } catch {
      // Not there (no SummitFlow) or not readable: the 60 s look reads it.
    }
  }

  stop(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close()
  }

  /** The full ref a wait keeps, or null when it names nothing known. */
  pullRef(kind: PullKind, ref: string): string | null {
    switch (kind) {
      case 'job':
        return this.jobId(ref)
      case 'reply':
        return this.ledger()?.has(ref) ? ref : null
      case 'ask':
        return this.deps.ask(ref) ? ref : null
      case 'host':
        return this.deps.host(ref) !== null ? ref : null
      case 'cmd':
        return this.cmdSpec(ref) ? ref : null
    }
  }

  read(kind: PullKind, ref: string): PullRead {
    switch (kind) {
      case 'job':
        return this.readJob(ref)
      case 'reply':
        return this.readReply(ref)
      case 'ask': {
        const ask = this.deps.ask(ref)
        return ask ? { state: ask.state, detail: null, title: ask.question ?? null } : null
      }
      case 'host': {
        const state = this.deps.host(ref)
        return state === null ? null : { state, detail: null, title: null }
      }
      case 'cmd':
        return this.readCmd(ref)
    }
  }

  /** Ask a job's owner where its file may be stale (a runner killed before it
   * wrote its end): only for a job its file says is still going. A `cmd`
   * watcher not started yet (admission was red, Tether restarted) starts. */
  refresh(kind: PullKind, ref: string, force: boolean): void {
    if (kind === 'cmd') {
      this.startCmd(ref)
      return
    }
    if (kind === 'reply' && force) this.ledgerCache = null
    if (kind !== 'job' || !this.deps.probeJob || this.probing.has(ref)) return
    const file = this.jobFile(ref)
    if (!file || JOB_FINAL.has(file.state) || this.probed.has(ref)) return
    const now = this.deps.now()
    if (!force && now - (this.probedAt.get(ref) ?? 0) < PROBE_EVERY_MS) return
    if (this.deps.admissionRed()) return
    this.probedAt.set(ref, now)
    this.probing.add(ref)
    this.deps
      .probeJob(ref)
      .then((stdout) => {
        const result = stdout ? parseJobResult(stdout) : null
        if (result && JOB_FINAL.has(result.state)) {
          this.probed.set(ref, result)
          this.deps.poke('job', ref)
        }
      })
      .catch((error) => this.deps.log(`job ${ref.slice(0, 8)} probe failed: ${error}`))
      .finally(() => this.probing.delete(ref))
    for (const [id, at] of this.probedAt) if (now - at > 24 * 3600_000) this.probedAt.delete(id)
  }

  private jobId(ref: string): string | null {
    if (JOB_ID.test(ref)) return this.jobFile(ref) ? ref : null
    let names: string[]
    try {
      names = readdirSync(this.deps.paths.jobsDir)
    } catch {
      return null
    }
    const ids = names
      .filter((name) => name.startsWith(ref) && name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter((id) => JOB_ID.test(id))
    return ids.length === 1 ? (ids[0] as string) : null
  }

  private jobFile(
    id: string,
  ): { state: string; exit: string | null; project: string | null } | null {
    try {
      const raw = readJson(join(this.deps.paths.jobsDir, `${id}.json`)) as Record<string, unknown>
      const state = str(raw.state)
      if (!state) return null
      const exit = typeof raw.exit_code === 'number' ? String(raw.exit_code) : null
      return { state, exit, project: str(raw.project) }
    } catch {
      return null
    }
  }

  private readJob(id: string): PullRead {
    try {
      statSync(join(this.deps.paths.jobsDir, `${id}.json`))
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
    }
    const file = this.jobFile(id)
    if (!file) return undefined
    const probed = JOB_FINAL.has(file.state) ? null : this.probed.get(id)
    if (JOB_FINAL.has(file.state)) this.probed.delete(id)
    return {
      state: probed?.state ?? file.state,
      detail: probed ? probed.exit : file.exit,
      title: file.project,
    }
  }

  private ledger(): Map<string, Record<string, unknown>> | null {
    let current: { version: number; doc: Record<string, unknown> }
    try {
      current = this.deps.ledgerDoc()
    } catch {
      return null
    }
    const key = String(current.version)
    if (this.ledgerCache?.key === key) return this.ledgerCache.value
    let value: Map<string, Record<string, unknown>> | null = null
    const anchors = new Map<string, string>()
    try {
      const raw = current.doc as { messages?: unknown }
      const messages = Array.isArray(raw.messages) ? raw.messages : []
      value = new Map()
      for (const message of messages) {
        if (!message || typeof message !== 'object') continue
        const id = str((message as Record<string, unknown>).id)
        // Only the typed fields: never the request's text.
        if (id) {
          const m = message as Record<string, unknown>
          value.set(id, {
            state: m.state,
            intent: m.intent,
            to: m.to,
            withdrawn: m.withdrawn,
          })
        }
      }
      // Identities: only each agent's anchor, to name a request's recipient by its window.
      const identities = (raw as { identities?: unknown }).identities
      if (identities && typeof identities === 'object') {
        for (const [agent, row] of Object.entries(identities as Record<string, unknown>)) {
          const anchor =
            row && typeof row === 'object' ? str((row as Record<string, unknown>).anchor) : null
          if (anchor) anchors.set(agent, anchor)
        }
      }
    } catch {
      value = null
    }
    this.ledgerCache = { key, value }
    this.anchorsCache = value ? anchors : null
    return value
  }

  private readReply(id: string): PullRead {
    const ledger = this.ledger()
    if (!ledger) return undefined
    const message = ledger.get(id)
    if (!message) return null
    const to = str(message.to)
    const anchor = to ? this.anchorsCache?.get(to) : undefined
    const window = anchor ? (this.deps.agentTitle?.(anchor) ?? null) : null
    const title = to && window ? `${window} (${to})` : to
    // A withdrawn request is closed without an answer.
    if (message.withdrawn) return { state: 'closed', detail: null, title }
    return {
      state: str(message.state) ?? 'open',
      detail: str(message.intent),
      title,
    }
  }

  /** Record a `cmd` wait's watcher and start it (unless admission is red:
   * then the 60 s look starts it later). Throws when the record can't be written. */
  createCmd(ref: string, spec: CmdSpec): void {
    if (!CMD_REF.test(ref)) throw new Error('bad cmd ref')
    const dir = this.deps.paths.cmdDir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const path = cmdFile(dir, ref, 'json')
    writeFileSync(`${path}.tmp`, JSON.stringify(spec), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    this.startCmd(ref)
  }

  /** The argv a `cmd` wait runs (a key's same-target check). */
  cmdArgv(ref: string): string[] | null {
    return this.cmdSpec(ref)?.argv ?? null
  }

  private cmdSpec(ref: string): CmdSpec | null {
    if (!CMD_REF.test(ref)) return null
    try {
      const raw = readJson(cmdFile(this.deps.paths.cmdDir, ref, 'json')) as Record<string, unknown>
      const argv = raw.argv
      if (!Array.isArray(argv) || !argv.length || !argv.every((part) => typeof part === 'string'))
        return null
      if (typeof raw.cwd !== 'string' || typeof raw.deadline !== 'number') return null
      return { argv: argv as string[], cwd: raw.cwd, deadline: raw.deadline }
    } catch {
      return null
    }
  }

  private exists(path: string): boolean {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  }

  private readCmd(ref: string): PullRead {
    const spec = this.cmdSpec(ref)
    if (!spec) return null
    const dir = this.deps.paths.cmdDir
    const title = spec.argv.join(' ')
    let text: string | null = null
    try {
      text = readFileSync(cmdFile(dir, ref, 'result'), 'utf8')
    } catch {
      text = null
    }
    if (text?.trim()) {
      const result = cmdResult(text)
      return { state: result.state, detail: result.detail, title }
    }
    const started = this.exists(cmdFile(dir, ref, 'started'))
    return { state: started ? 'running' : 'waiting', detail: null, title }
  }

  /** Start the watcher unit once: not while admission is red, never twice. */
  private startCmd(ref: string): void {
    const dir = this.deps.paths.cmdDir
    if (this.starting.has(ref)) return
    const spec = this.cmdSpec(ref)
    if (!spec) return
    if (this.exists(cmdFile(dir, ref, 'result')) || this.exists(cmdFile(dir, ref, 'started')))
      return
    if (this.deps.admissionRed()) {
      if (!this.deferredLogged.has(ref))
        this.deps.log(`cmd ${ref}: admission is red, start deferred`)
      this.deferredLogged.add(ref)
      return
    }
    this.deferredLogged.delete(ref)
    // Past its deadline the wait times out on this same look: start nothing.
    if (spec.deadline <= this.deps.now()) return
    const units = this.deps.cmdUnits
    this.starting.add(ref)
    const runtime = Math.max(
      1,
      Math.ceil((spec.deadline - this.deps.now()) / 1000) + CMD_GRACE_SECONDS,
    )
    const started = units
      ? units.start(ref, spec, cmdFile(dir, ref, 'result'), runtime)
      : Promise.resolve('failed' as const)
    started
      .catch((error) => {
        this.deps.log(`cmd ${ref}: start failed: ${error}`)
        return 'failed' as const
      })
      .then(async (outcome) => {
        // A start that failed or timed out may still have left a unit behind.
        if (outcome === 'failed') await units?.stop(ref).catch(() => {})
        if (this.ending.has(ref)) {
          if (outcome !== 'failed') await units?.stop(ref).catch(() => {})
          return
        }
        if (outcome === 'failed') {
          writeFileSync(cmdFile(dir, ref, 'result'), 'start-failed\n', { mode: 0o600 })
          this.deps.log(`cmd ${ref}: the unit did not start`)
        } else writeFileSync(cmdFile(dir, ref, 'started'), '', { mode: 0o600 })
      })
      .catch((error) => this.deps.log(`cmd ${ref}: start failed: ${error}`))
      .finally(() => {
        this.starting.delete(ref)
        if (this.ending.delete(ref)) this.dropCmd(ref)
        else this.deps.poke('cmd', ref)
      })
  }

  private dropCmd(ref: string): void {
    const dir = this.deps.paths.cmdDir
    for (const ending of ['json', 'started', 'result'] as const)
      rmSync(cmdFile(dir, ref, ending), { force: true })
    rmSync(`${cmdFile(dir, ref, 'result')}.tmp`, { force: true })
  }

  /** A `cmd` wait is over (fired, timed out, cancelled, its waiter ended):
   * stop its unit if it still runs and drop its files. */
  endCmd(ref: string): void {
    if (!CMD_REF.test(ref)) return
    const dir = this.deps.paths.cmdDir
    this.deferredLogged.delete(ref)
    // Its unit is starting: the start's end stops and drops it.
    if (this.starting.has(ref)) {
      this.ending.add(ref)
      return
    }
    const running =
      this.exists(cmdFile(dir, ref, 'started')) && !this.exists(cmdFile(dir, ref, 'result'))
    const drop = () => this.dropCmd(ref)
    if (running && this.deps.cmdUnits) {
      this.deps.log(`cmd ${ref}: stopping its unit`)
      this.deps.cmdUnits
        .stop(ref)
        .catch(() => {})
        .finally(drop)
    } else drop()
  }

  /** Watchers whose wait is no longer armed (a waiter that ended takes its
   * waits with it): stop and drop them. */
  sweepCmd(armed: ReadonlySet<string>): void {
    let names: string[]
    try {
      names = readdirSync(this.deps.paths.cmdDir)
    } catch {
      return
    }
    const records = new Set(names.filter((name) => name.endsWith('.json')))
    for (const name of names) {
      const ref = name.split('.')[0] ?? ''
      if (!CMD_REF.test(ref) || armed.has(ref) || this.starting.has(ref)) continue
      if (name.endsWith('.json')) this.endCmd(ref)
      // A result a slow stop wrote after its files were dropped.
      else if (!records.has(`${ref}.json`))
        rmSync(join(this.deps.paths.cmdDir, name), { force: true })
    }
  }
}

/** The `cmd` watchers' files, one set per ref. */
const cmdFile = (dir: string, ref: string, ending: 'json' | 'started' | 'result') =>
  join(dir, `${ref}.${ending}`)

/** `st --no-compact service result` output: the job's state and exit code. */
export function parseJobResult(stdout: string): { state: string; exit: string | null } | null {
  try {
    const raw = JSON.parse(stdout) as Record<string, unknown>
    const state = str(raw.state)
    if (!state) return null
    return { state, exit: typeof raw.exit_code === 'number' ? String(raw.exit_code) : null }
  } catch {
    return null
  }
}
