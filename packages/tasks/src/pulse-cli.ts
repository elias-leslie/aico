// `aico pulse [--brief] [--start] [--json]`. --start is the SessionStart hook's call: the hook payload on
// stdin picks the role, and what is shown is held back for the re-show window.

import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type ParseArgsOptionsConfig, parseArgs } from 'node:util'
import { counted, StatusStore, statusDbPath } from '@aico/status'
import { TetherClient, tetherSocketPath } from '@aico/tether-client'
import { type Database, tasksDbPathFromEnv } from './db'
import { Registry } from './projects'
import {
  BriefLedger,
  brief,
  collect,
  type Finding,
  ledgerPath,
  type Pulse,
  type PulseSources,
  render,
  roleOf,
} from './pulse'
import { roadmapBrief } from './roadmap-brief'

export interface PulseIo {
  out(line: string): void
  err(line: string): void
}

const USAGE = `Usage: aico pulse [--brief] [--json]
  (no option)  live sessions per project, leases, open handshakes and what Status says is wrong
  --brief      the startup brief for this session: the project's roadmap (Now, Next) and the Status problems it concerns, by role
  --json       the same data as JSON
Children: sessions a coordinator started; vanished ones are gone without ending.
Handshakes: messages between sessions waiting on an answer or a close (aico sessions inbox, aico sessions confirm). An ack whose sender has ended waits on nobody; it clears within 24 hours.
Lease: a session's claim on files it is editing, idle since its last activity (aico lease --help).`

function dataDir(env: NodeJS.ProcessEnv): string {
  return dirname(tasksDbPathFromEnv(env))
}

function statusFindings(env: NodeJS.ProcessEnv, now: () => number): Finding[] | null {
  const path = statusDbPath(dataDir(env))
  if (!existsSync(path)) return null
  let store: StatusStore | null = null
  try {
    store = new StatusStore(path, now)
    return store
      .read()
      .rows.filter(counted)
      .map((row) => ({
        id: row.id,
        machine: row.machine,
        what: row.what,
        meaning: row.meaning,
        project: row.project ?? null,
        shown: row.shown as Finding['shown'],
        since: row.shown_since ? Date.parse(row.shown_since) : null,
      }))
  } catch {
    return null
  } finally {
    store?.close()
  }
}

function liveSources(env: NodeJS.ProcessEnv, now = Date.now): PulseSources {
  const client = new TetherClient(tetherSocketPath(env, process.getuid?.()), 2_000)
  const orNull = async <T>(work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work()
    } catch {
      return null
    }
  }
  return {
    now,
    sessions: () => orNull(() => client.listSessions()),
    children: () => orNull(() => client.childAgents()),
    docNames: () => orNull(() => client.coordinationDocs()),
    doc: (name) => orNull(() => client.coordinationDoc(name)),
    findings: () => statusFindings(env, now),
  }
}

export async function runPulse(
  argv: string[],
  deps: {
    db: Database
    cwd: string
    env: NodeJS.ProcessEnv
    sources?: PulseSources
    stdin?: () => string
  },
  io: PulseIo,
): Promise<number> {
  const options = {
    brief: { type: 'boolean' },
    start: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } satisfies ParseArgsOptionsConfig
  let values: { brief?: boolean; start?: boolean; json?: boolean; help?: boolean }
  try {
    values = parseArgs({ args: argv, options, strict: true }).values
  } catch (error) {
    io.err(`${(error as Error).message}\n${USAGE}`)
    return 2
  }
  if (values.help) {
    io.out(USAGE)
    return 0
  }
  const sources = deps.sources ?? liveSources(deps.env)
  if (values.brief || values.start) {
    const registry = new Registry(deps.db)
    let payload: Record<string, unknown> = {}
    if (values.start) {
      try {
        payload = JSON.parse((deps.stdin ?? (() => readFileSync(0, 'utf8')))() || '{}')
      } catch {
        payload = {}
      }
    }
    const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : deps.cwd
    const here = registry.forCwd(cwd)
    const project = here?.id ?? null
    const findings = sources.findings() ?? []
    const widget = deps.env.AICO_WIDGET_ID?.trim() ?? ''
    let descriptor = null
    if (widget && findings.length > 0) {
      const sessions = await sources.sessions()
      descriptor = sessions?.find((s) => s.id === widget) ?? null
    }
    const lines = brief({
      findings,
      role: roleOf(payload, descriptor, widget !== ''),
      project,
      registry,
      now: sources.now(),
      ledger: values.start
        ? new BriefLedger(ledgerPath(statusDbPath(dataDir(deps.env))))
        : undefined,
    })
    for (const line of [...roadmapBrief(here?.root_path ?? null), ...lines]) io.out(line)
    return 0
  }
  const pulse: Pulse = await collect(sources)
  if (values.json) io.out(JSON.stringify(pulse, null, 2))
  else for (const line of render(pulse)) io.out(line)
  return 0
}
