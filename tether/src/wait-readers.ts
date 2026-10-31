// What the pull kinds of a wait read (src/wait-kinds.ts), from each thing's
// owner, read-only: SummitFlow's job files and coordination ledger, Agent
// Hub runs as Tether follows them, Tether's own asks and hub peers, and
// Nightshift's tap answers. Files are read when they change (a directory
// watch), on a nudge, at every 60 s look and at start. A job whose runner
// may have died is asked of its owner's CLI (`st service result`) as an
// idle-weight transient unit, at most once a minute per job, never while
// admission is red.

import { execFile } from 'node:child_process'
import { type FSWatcher, readdirSync, readFileSync, statSync, watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { JOB_FINAL, type PullKind, type PullRead } from './wait-kinds'

const JOB_ID = /^[0-9a-f]{32}$/
const TAP_ID = /^[0-9a-f]{32}$/
/** A probe of one job at most this often (a nudge skips it). */
const PROBE_EVERY_MS = 60_000

export interface PullReaderPaths {
  /** SummitFlow's service jobs (`<32 hex>.json`). */
  jobsDir: string
  /** SummitFlow's coordination ledger (`_coord.json`). */
  ledger: string
  /** Nightshift's tap answers (`<32 hex>.resp.json`): owner taps, agent requests. */
  tapDirs: readonly string[]
}

export interface PullReaderDeps {
  paths: PullReaderPaths
  /** A run Tether follows (RunTracker.runState). */
  run(runId: string): { state: string | null; launcherId: string | null } | undefined
  /** An ask (AskStore.get). */
  ask(id: string): { state: string } | undefined
  /** A hub peer's state; null when this hub has no such host. */
  host(name: string): string | null
  /** Nightshift admission is red: heavy and probing work waits. */
  admissionRed(): boolean
  /** Run the job's owner CLI: stdout, or null when it could not answer. */
  probeJob?(jobId: string): Promise<string | null>
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

export class PullReaders {
  private ledgerCache: Cached<Map<string, Record<string, unknown>> | null> | null = null
  private readonly probed = new Map<string, { state: string; exit: string | null }>()
  private readonly probing = new Set<string>()
  private readonly probedAt = new Map<string, number>()
  private readonly watchers: FSWatcher[] = []

  constructor(private readonly deps: PullReaderDeps) {}

  /** Watch the owners' files; each change pokes the waits of its kind. A
   * directory that is missing or unreadable is only read at the 60 s look. */
  watch(): void {
    const { paths } = this.deps
    this.watchDir(paths.jobsDir, (name) => {
      const id = name.endsWith('.json') ? name.slice(0, -5) : ''
      if (JOB_ID.test(id)) this.deps.poke('job', id)
    })
    this.watchDir(dirname(paths.ledger), (name) => {
      if (name === basename(paths.ledger)) this.deps.poke('reply')
    })
    for (const dir of paths.tapDirs)
      this.watchDir(dir, (name) => {
        const id = name.endsWith('.resp.json') ? name.slice(0, -10) : ''
        if (TAP_ID.test(id)) this.deps.poke('tap', id)
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
      // Not there (no SummitFlow, no Nightshift) or not readable: the 60 s look reads it.
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
      case 'run':
        return this.deps.run(ref) ? ref : null
      case 'ask':
        return this.deps.ask(ref) ? ref : null
      case 'host':
        return this.deps.host(ref) !== null ? ref : null
      case 'tap':
        return TAP_ID.test(ref) ? ref : null
    }
  }

  read(kind: PullKind, ref: string): PullRead {
    switch (kind) {
      case 'job':
        return this.readJob(ref)
      case 'reply':
        return this.readReply(ref)
      case 'run': {
        const run = this.deps.run(ref)
        if (run === undefined) return undefined
        return run.state === null ? null : { state: run.state, detail: null, title: null }
      }
      case 'ask': {
        const ask = this.deps.ask(ref)
        return ask ? { state: ask.state, detail: null, title: null } : null
      }
      case 'host': {
        const state = this.deps.host(ref)
        return state === null ? null : { state, detail: null, title: null }
      }
      case 'tap':
        return this.readTap(ref)
    }
  }

  /** Ask a job's owner where its file may be stale (a runner killed before it
   * wrote its end): only for a job its file says is still going. */
  refresh(kind: PullKind, ref: string, force: boolean): void {
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
    const path = this.deps.paths.ledger
    let key: string
    try {
      const stat = statSync(path)
      key = `${stat.mtimeMs}:${stat.size}`
    } catch {
      return null
    }
    if (this.ledgerCache?.key === key) return this.ledgerCache.value
    let value: Map<string, Record<string, unknown>> | null = null
    try {
      const raw = readJson(path) as { messages?: unknown }
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
    } catch {
      value = null
    }
    this.ledgerCache = { key, value }
    return value
  }

  private readReply(id: string): PullRead {
    const ledger = this.ledger()
    if (!ledger) return undefined
    const message = ledger.get(id)
    if (!message) return null
    const to = str(message.to)
    // A withdrawn request is closed without an answer.
    if (message.withdrawn) return { state: 'closed', detail: null, title: to }
    return {
      state: str(message.state) ?? 'open',
      detail: str(message.intent),
      title: to,
    }
  }

  private readTap(id: string): PullRead {
    for (const dir of this.deps.paths.tapDirs) {
      let raw: Record<string, unknown>
      try {
        raw = readJson(join(dir, `${id}.resp.json`)) as Record<string, unknown>
      } catch {
        continue
      }
      const outcome = str(raw.outcome)
      if (outcome) return { state: outcome, detail: null, title: null }
    }
    // Not answered yet, or not taken in yet: never "gone".
    return undefined
  }
}

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
