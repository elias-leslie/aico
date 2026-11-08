// Session continuity across reboots.
//
// While sessions run, Tether records each one's agent resume handle (the
// Claude Code session ID or the Codex thread ID its process holds open) in
// <stateDir>/continuity.json. After a reboot, startup reconciliation finds
// those sessions' tmux servers dead; Tether then recreates each session and
// relaunches its agent with the tool's resume adapter and a short "resumed
// after reboot" prompt. The catalog keeps the identity (tool, name, project);
// the snapshot adds only what the catalog cannot know: the native resume ID.
//
// host-steward drives a planned reboot through `prepare` (list, ask agents to
// checkpoint, report readiness) and reads `status` after boot.

import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { writeFileDurable } from '@aico/shared/durable-file'
import { entryReaders } from './entry-files'
import { ADAPTERS, adapterOf } from './lifecycle/tui/registry'
import {
  type AgentObservation,
  type EntryProcess,
  FRESH_SESSION_ENV,
  nodeProcFs,
  type ProcFs,
  processTree,
  UUID_RE,
} from './proc-fs'

export const RESUME_PROMPT =
  'Tether resumed this session after a host reboot. Continue where you left off. ' +
  'Processes, servers and watchers you started before the reboot are gone; restart any you still need.'

export const CHECKPOINT_PROMPT =
  'A host reboot is pending. Checkpoint now: commit or save work in progress and write down your next step. ' +
  'Tether will resume this session after the reboot.'

export interface SnapshotSession {
  id: string
  tool: string
  /** Native resume ID, or null when none was observed (a shell, or an agent
   * that has not started a conversation yet). */
  resumeId: string | null
  observedAt: number
}

export interface ContinuitySnapshot {
  v: 1
  bootId: string
  updatedAt: number
  sessions: SnapshotSession[]
}

export interface RestoreEntry {
  id: string
  name: string | null
  tool: string
  resumed?: boolean
  reason?: string
}

export interface RestoreReport {
  v: 1
  bootId: string
  startedAt: number
  finishedAt: number | null
  restored: RestoreEntry[]
  failed: RestoreEntry[]
  pending: RestoreEntry[]
}

// --- agent observation --------------------------------------------------------

// --- entry sessions (src/lifecycle/entries.ts) ---------------------------------

/** Set by Tether on a session's entry process only: the host path of the
 * agent's home. Not passed into the entry's container by Tether. */
export const ENTRY_HOME_ENV = 'TETHER_ENTRY_HOME'
/** Set next to ENTRY_HOME_ENV: which agent runs through the entry, so its
 * state is read the way that agent writes it. A session launched before this
 * marker existed has none and is the adapter marked `entryDefault`. */
export const ENTRY_TOOL_ENV = 'TETHER_ENTRY_TOOL'
/** The tools an entry can run: the adapters with the entry capability. */
export const ENTRY_TOOLS: readonly string[] = ADAPTERS.filter(
  (adapter) => adapter.capabilities.entry,
).map((adapter) => adapter.id)
export type EntryTool = string
/** The tool an entry with no marker runs: sessions launched before the marker existed. */
const ENTRY_DEFAULT_TOOL = ADAPTERS.find((adapter) => adapter.capabilities.entryDefault)?.id

/** The id the launch line hands the agent (root-launch.ts `chooseSession`),
 * read back from the same variables: a resume only on an initial launch. */
function chosenSessionId(vars: Map<string, string>): string | null {
  const resume = vars.get('AICO_ROOT_RESUME_SESSION_ID') ?? ''
  const id =
    vars.get('AICO_ROOT_INITIAL_LAUNCH') === '1' && resume
      ? resume
      : (vars.get(FRESH_SESSION_ENV) ?? '')
  return UUID_RE.test(id) ? id : null
}

/** The pane's entry process, the first in pane order marked with the home. */
export function findEntryProcess(fs: ProcFs, pids: number[]): EntryProcess | null {
  for (const pid of pids) {
    let environ: string
    try {
      environ = fs.readFile(`/proc/${pid}/environ`)
    } catch {
      continue
    }
    const vars = new Map<string, string>()
    for (const entry of environ.split('\0')) {
      const eq = entry.indexOf('=')
      if (eq > 0) vars.set(entry.slice(0, eq), entry.slice(eq + 1))
    }
    const home = vars.get(ENTRY_HOME_ENV) ?? null
    const tool = vars.get(ENTRY_TOOL_ENV) ?? null
    if (home === null || !isAbsolute(home)) continue
    const known = ENTRY_TOOLS.includes(tool ?? ENTRY_DEFAULT_TOOL ?? '')
    return {
      pid,
      home,
      tool: known ? (tool ?? ENTRY_DEFAULT_TOOL ?? null) : null,
      chosenId: chosenSessionId(vars),
    }
  }
  return null
}

/** How an entry home is read: through the ProcFs's contained readers when it
 * has them (the host's: no read leaves the home, src/entry-files.ts), else as
 * given (a test's fake fs). null: the home is refused, read nothing. */
/** An entry session's agent: its state from the entry home, standing on the
 * entry process (the pane's agent exits when it does). Never the host home. */
function observeEntryAgent(fs: ProcFs, entry: EntryProcess): AgentObservation | null {
  const readers = entry.tool ? entryReaders(fs, entry.home) : null
  if (!readers) return null
  return adapterOf(entry.tool)?.state.observeInEntry?.(readers, entry) ?? null
}

export function observeAgent(fs: ProcFs, home: string, panePid: number): AgentObservation | null {
  const pids = processTree(fs, panePid)
  // A session that runs through an entry is read only from the entry's home.
  const entry = findEntryProcess(fs, pids)
  if (entry) return observeEntryAgent(fs, entry)
  for (const adapter of ADAPTERS) {
    const observed = adapter.state.observe?.(fs, home, pids)
    if (observed) return observed
  }
  return null
}

// --- state files ----------------------------------------------------------------

export function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  // A power cut must not leave an empty file where the record of what to bring back was.
  writeFileDurable(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

export function currentBootId(fs: ProcFs = nodeProcFs): string {
  try {
    return fs.readFile('/proc/sys/kernel/random/boot_id').trim()
  } catch {
    return 'unknown'
  }
}

/**
 * Merge a fresh observation of running sessions into the previous snapshot.
 * A running session keeps its last known resume ID when the agent is between
 * conversations. A session that is not running drops out unless `retain`
 * keeps it (one still waiting to be restored after a reboot).
 */
export function mergeSnapshot(
  previous: ContinuitySnapshot | null,
  running: { id: string; tool: string; resumeId: string | null }[],
  retain: (id: string) => boolean,
  bootId: string,
  now: number,
): ContinuitySnapshot {
  const known = new Map((previous?.sessions ?? []).map((session) => [session.id, session]))
  const sessions: SnapshotSession[] = running.map((session) => {
    const before = known.get(session.id)
    const keep = before && before.tool === session.tool ? before : null
    return {
      id: session.id,
      tool: session.tool,
      resumeId: session.resumeId ?? keep?.resumeId ?? null,
      observedAt: session.resumeId ? now : (keep?.observedAt ?? now),
    }
  })
  const listed = new Set(sessions.map((session) => session.id))
  for (const session of previous?.sessions ?? []) {
    if (!listed.has(session.id) && retain(session.id)) sessions.push(session)
  }
  return { v: 1, bootId, updatedAt: now, sessions }
}

/** The native resume ID the snapshot last saw for this session (same tool, so a session
 * that changed tools reads none), else null. */
export function snapshotResumeId(
  snapshot: ContinuitySnapshot | null,
  id: string,
  tool: string,
): string | null {
  if (snapshot?.v !== 1 || !Array.isArray(snapshot.sessions)) return null
  const seen = snapshot.sessions.find((session) => session.id === id && session.tool === tool)
  return seen?.resumeId ?? null
}

/** Sessions the snapshot saw running whose workload is gone now (status
 * `pending` after startup reconciliation found their tmux server dead). */
export function restoreCandidates(
  snapshot: ContinuitySnapshot | null,
  statusOf: (id: string) => string | null,
): SnapshotSession[] {
  if (snapshot?.v !== 1 || !Array.isArray(snapshot.sessions)) return []
  return snapshot.sessions.filter((session) => statusOf(session.id) === 'pending')
}
