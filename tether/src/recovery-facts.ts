// Facts behind a crash recovery: what ended the session (systemd and kernel
// journal records), what the agent had running (the per-tool transcript
// adapter; Claude Code only, Codex has none), and the state it comes back to
// (git, leases). Everything here is pure parsing plus bounded reads, so the
// synopsis prompt and the detail file can be tested from fixtures.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CHECKPOINT_PROMPT, RESUME_PROMPT } from './continuity'

/** systemd unit results that mean the unit failed rather than stopped cleanly. */
/** Cause for a tmux server that vanished while its agent was running. tmux
 * runs as a non-main process of an ExitType=cgroup unit, so systemd records no
 * failure when it is killed; the agent seen running is the evidence. */
export const SERVER_LOST = 'lost'

const SYNOPSIS_HEAD = 'Recovery: this session crashed at '

/** Prompts Tether itself pasted: never the owner's last instruction. */
function isTetherPrompt(text: string): boolean {
  return (
    text.startsWith(SYNOPSIS_HEAD) ||
    text.startsWith(RESUME_PROMPT.slice(0, 40)) ||
    text.startsWith(CHECKPOINT_PROMPT.slice(0, 40))
  )
}

export const CRASH_RESULTS: ReadonlySet<string> = new Set([
  'oom-kill',
  'signal',
  'core-dump',
  'timeout',
  'exit-code',
])

const UNIT_RESULT_MESSAGE_ID = 'd9b373ed55a64feb8242e02dbe79a49c'
const UNIT_OOM_MESSAGE_ID = 'fe6faa94e7774663a0da52717891d8ef'

export type JournalEntry = Record<string, unknown>

/** `journalctl -o json` output, one object per line; bad lines are skipped. */
export function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as unknown
      if (entry && typeof entry === 'object') entries.push(entry as JournalEntry)
    } catch {
      // partial line
    }
  }
  return entries
}

function message(entry: JournalEntry): string {
  const value = entry.MESSAGE
  if (typeof value === 'string') return value
  // journalctl emits non-UTF-8 messages as byte arrays.
  if (Array.isArray(value)) return Buffer.from(value as number[]).toString('utf8')
  return ''
}

function entryTime(entry: JournalEntry): number {
  const micros = Number(entry.__REALTIME_TIMESTAMP)
  return Number.isFinite(micros) ? Math.floor(micros / 1000) : 0
}

export interface UnitOutcome {
  /** The failure result (`oom-kill`, `signal`, ...), or null when the unit
   * has not failed (yet). */
  result: string | null
  /** systemd logged that the kernel OOM killer killed a process of the unit. */
  oomKilledProcess: boolean
  at: number | null
  lines: string[]
}

/** The outcome of one exact unit invocation from user-manager records. */
export function unitOutcome(
  entries: JournalEntry[],
  unit: string,
  invocationId: string | null,
): UnitOutcome {
  const outcome: UnitOutcome = { result: null, oomKilledProcess: false, at: null, lines: [] }
  for (const entry of entries) {
    if (entry.USER_UNIT !== unit && entry.UNIT !== unit) continue
    const invocation = entry.USER_INVOCATION_ID ?? entry.INVOCATION_ID
    if (invocationId && invocation !== undefined && invocation !== invocationId) continue
    outcome.lines.push(`${stamp(entryTime(entry))} ${message(entry)}`)
    if (entry.MESSAGE_ID === UNIT_OOM_MESSAGE_ID) outcome.oomKilledProcess = true
    if (entry.MESSAGE_ID === UNIT_RESULT_MESSAGE_ID && typeof entry.UNIT_RESULT === 'string') {
      outcome.result = entry.UNIT_RESULT
      outcome.at = entryTime(entry)
    }
  }
  return outcome
}

export interface OomVictim {
  pid: number
  comm: string
  rssBytes: number | null
  /** `global` host out of memory; `memcg` a cgroup limit such as the pane cap. */
  constraint: 'global' | 'memcg' | 'other'
  /** The victim's cgroup path from `task_memcg=`. */
  memcg: string | null
  at: number
  lines: string[]
}

const OOM_KILL_RE = /^oom-kill:(.*)$/
const KILLED_RE = /Killed process (\d+) \(([^)]*)\)(?:.*?anon-rss:(\d+)kB)?/

/** Kernel OOM kills from `journalctl -k` records. */
export function kernelOomVictims(entries: JournalEntry[]): OomVictim[] {
  const victims = new Map<number, OomVictim>()
  for (const entry of entries) {
    const text = message(entry)
    const at = entryTime(entry)
    const header = OOM_KILL_RE.exec(text)
    if (header) {
      const fields = new Map<string, string>()
      for (const part of (header[1] ?? '').split(',')) {
        const eq = part.indexOf('=')
        fields.set(eq > 0 ? part.slice(0, eq) : part, eq > 0 ? part.slice(eq + 1) : '')
      }
      const pid = Number(fields.get('pid'))
      if (!Number.isInteger(pid) || pid <= 0) continue
      const constraint = fields.get('constraint') ?? ''
      victims.set(pid, {
        pid,
        comm: fields.get('task') ?? '',
        rssBytes: victims.get(pid)?.rssBytes ?? null,
        constraint:
          constraint === 'CONSTRAINT_MEMCG'
            ? 'memcg'
            : constraint === 'CONSTRAINT_NONE' || fields.has('global_oom')
              ? 'global'
              : 'other',
        memcg: fields.get('task_memcg') || null,
        at,
        lines: [`${stamp(at)} ${text}`],
      })
      continue
    }
    const killed = KILLED_RE.exec(text)
    if (killed) {
      const pid = Number(killed[1])
      const victim = victims.get(pid)
      const rss = killed[3] ? Number(killed[3]) * 1024 : null
      if (victim) {
        victim.rssBytes = rss
        if (killed[2]) victim.comm = killed[2]
        victim.lines.push(`${stamp(at)} ${text}`)
      } else {
        victims.set(pid, {
          pid,
          comm: killed[2] ?? '',
          rssBytes: rss,
          constraint: /Memory cgroup/.test(text) ? 'memcg' : 'other',
          memcg: null,
          at,
          lines: [`${stamp(at)} ${text}`],
        })
      }
    }
  }
  return [...victims.values()].sort((a, b) => a.at - b.at)
}

/** Victims whose cgroup is the given pane scope (or below it). */
export function victimsInScope(victims: OomVictim[], scopeUnit: string): OomVictim[] {
  return victims.filter(
    (victim) =>
      victim.memcg !== null &&
      (victim.memcg.endsWith(`/${scopeUnit}`) || victim.memcg.includes(`/${scopeUnit}/`)),
  )
}

// --- Claude Code transcripts ---------------------------------------------------

export interface KilledCall {
  /** Where it ran: `main`, or the workflow lane or subagent label. */
  where: string
  agentId: string | null
  runId: string | null
  command: string
  startedAt: number | null
  /** `exit 137` style, or `in flight` when no result was ever written. */
  outcome: string
  background: boolean
  transcript: string
}

export interface WorkflowState {
  runId: string
  name: string
  scriptPath: string | null
  done: number
  inFlight: string[]
}

export interface TranscriptFacts {
  transcript: string
  lastOwner: { at: number; text: string } | null
  openMainCalls: string[]
  killed: KilledCall[]
  workflows: WorkflowState[]
  lostBackground: { id: string; output: string | null }[]
}

export interface FileReader {
  read(path: string): string | null
  list(path: string): string[]
  mtime(path: string): number | null
}

export const nodeFileReader: FileReader = {
  read: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  list: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  mtime: (path) => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return null
    }
  },
}

/** `~/.claude/projects/<project>/<sessionId>.jsonl` for a session ID. */
export function findClaudeTranscript(
  files: FileReader,
  home: string,
  sessionId: string,
): string | null {
  const root = join(home, '.claude', 'projects')
  for (const project of files.list(root)) {
    const path = join(root, project, `${sessionId}.jsonl`)
    if (files.mtime(path) !== null) return path
  }
  return null
}

interface ToolUse {
  id: string
  name: string
  command: string
  at: number | null
  background: boolean
}

interface ToolResult {
  at: number | null
  text: string
}

interface ParsedTranscript {
  uses: Map<string, ToolUse>
  results: Map<string, ToolResult>
  lastOwner: { at: number; text: string } | null
  backgroundStarted: Map<string, number | null>
  notified: Set<string>
}

function toTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function oneLine(text: string, max: number): string {
  const flat = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('\n')
  return ''
}

const BACKGROUND_RE = /running in background with ID: ([A-Za-z0-9_-]+)/
const TASK_ID_RE = /<task-id>([A-Za-z0-9_-]+)<\/task-id>/g

function parseTranscript(text: string): ParsedTranscript {
  const parsed: ParsedTranscript = {
    uses: new Map(),
    results: new Map(),
    lastOwner: null,
    backgroundStarted: new Map(),
    notified: new Set(),
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const at = toTime(entry.timestamp)
    const content = (entry.message as { content?: unknown } | undefined)?.content
    if (entry.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as Record<string, unknown>[]) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
        const input = (block.input ?? {}) as Record<string, unknown>
        const command =
          typeof input.command === 'string'
            ? input.command
            : typeof input.description === 'string'
              ? input.description
              : typeof input.prompt === 'string'
                ? input.prompt
                : ''
        parsed.uses.set(block.id, {
          id: block.id,
          name: typeof block.name === 'string' ? block.name : 'tool',
          command,
          at,
          background: input.run_in_background === true,
        })
      }
    }
    if (entry.type !== 'user') continue
    if (typeof content === 'string') {
      for (const match of content.matchAll(TASK_ID_RE)) parsed.notified.add(match[1] as string)
      const human = (entry.origin as { kind?: unknown } | undefined)?.kind === 'human'
      if (
        at !== null &&
        !entry.isMeta &&
        (human || !content.startsWith('<')) &&
        !isTetherPrompt(content)
      )
        parsed.lastOwner = { at, text: content }
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as Record<string, unknown>[]) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        const text = resultText(block.content)
        parsed.results.set(block.tool_use_id, { at, text })
        const background = BACKGROUND_RE.exec(text)
        if (background) parsed.backgroundStarted.set(background[1] as string, at)
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        for (const match of block.text.matchAll(TASK_ID_RE)) parsed.notified.add(match[1] as string)
        if (
          at !== null &&
          !entry.isMeta &&
          !block.text.startsWith('<') &&
          !isTetherPrompt(block.text)
        )
          parsed.lastOwner = { at, text: block.text }
      }
    }
  }
  return parsed
}

/** Calls that ended with a kill around `diedAt` or never got a result. */
function killedCalls(
  parsed: ParsedTranscript,
  diedAt: number,
  where: string,
  ids: { agentId: string | null; runId: string | null; transcript: string },
): KilledCall[] {
  const calls: KilledCall[] = []
  for (const use of parsed.uses.values()) {
    if (use.at !== null && (use.at > diedAt + 5_000 || use.at < diedAt - 6 * 3600_000)) continue
    const result = parsed.results.get(use.id)
    let outcome: string | null = null
    if (!result) outcome = 'in flight'
    else {
      const exit = /Exit code (13[0-9]|14[0-3])\b/.exec(result.text)
      if (exit && result.at !== null && Math.abs(result.at - diedAt) <= 15_000)
        outcome = `exit ${exit[1]}`
    }
    if (!outcome) continue
    calls.push({
      where,
      ...ids,
      command: use.command || use.name,
      startedAt: use.at,
      outcome,
      background: use.background,
    })
  }
  return calls
}

function workflowLabels(files: FileReader, journal: string): Map<string, string> {
  const labels = new Map<string, string>()
  for (const line of (files.read(journal) ?? '').split('\n')) {
    try {
      const entry = JSON.parse(line) as { type?: string; agentId?: string; label?: string }
      if (entry.type === 'started' && entry.agentId && entry.label)
        labels.set(entry.agentId, entry.label)
    } catch {
      // partial line
    }
  }
  return labels
}

/** Unfinished workflow runs: a journal without the finished-run summary. */
function unfinishedWorkflows(files: FileReader, sessionDir: string): WorkflowState[] {
  const states: WorkflowState[] = []
  const runsDir = join(sessionDir, 'subagents', 'workflows')
  const scripts = files.list(join(sessionDir, 'workflows', 'scripts'))
  for (const runId of files.list(runsDir).sort()) {
    if (files.mtime(join(sessionDir, 'workflows', `${runId}.json`)) !== null) continue
    const journal = files.read(join(runsDir, runId, 'journal.jsonl'))
    if (journal === null) continue
    const started = new Map<string, string>()
    const finished = new Set<string>()
    for (const line of journal.split('\n')) {
      try {
        const entry = JSON.parse(line) as { type?: string; key?: string; label?: string }
        if (entry.type === 'started' && entry.key) started.set(entry.key, entry.label ?? '?')
        if (entry.type === 'result' && entry.key) finished.add(entry.key)
      } catch {
        // partial line
      }
    }
    const script = scripts.find((name) => name.endsWith(`-${runId}.js`)) ?? null
    states.push({
      runId,
      name: script ? script.slice(0, -`-${runId}.js`.length) : runId,
      scriptPath: script ? join(sessionDir, 'workflows', 'scripts', script) : null,
      done: [...started.keys()].filter((key) => finished.has(key)).length,
      inFlight: [...started.entries()].filter(([key]) => !finished.has(key)).map(([, l]) => l),
    })
  }
  return states
}

function subagentTranscripts(
  files: FileReader,
  sessionDir: string,
  since: number,
): { path: string; runId: string | null }[] {
  const found: { path: string; runId: string | null }[] = []
  const base = join(sessionDir, 'subagents')
  const consider = (dir: string, runId: string | null) => {
    for (const name of files.list(dir)) {
      if (!/^agent-[A-Za-z0-9]+\.jsonl$/.test(name)) continue
      const path = join(dir, name)
      if ((files.mtime(path) ?? 0) >= since) found.push({ path, runId })
    }
  }
  consider(base, null)
  for (const runId of files.list(join(base, 'workflows'))) {
    consider(join(base, 'workflows', runId), runId)
  }
  return found.slice(0, 400)
}

/** Claude Code adapter: facts from the main transcript, its subagents and
 * workflow journals for a session that died at `diedAt`. */
export function claudeTranscriptFacts(
  files: FileReader,
  transcript: string,
  diedAt: number,
  uid: number,
): TranscriptFacts | null {
  const text = files.read(transcript)
  if (text === null) return null
  const main = parseTranscript(text)
  const sessionId = basename(transcript, '.jsonl')
  const sessionDir = join(dirname(transcript), sessionId)
  const killed = killedCalls(main, diedAt, 'main', {
    agentId: null,
    runId: null,
    transcript,
  })
  const labels = new Map<string, Map<string, string>>()
  for (const { path, runId } of subagentTranscripts(files, sessionDir, diedAt - 6 * 3600_000)) {
    const body = files.read(path)
    if (body === null) continue
    const agentId = basename(path, '.jsonl').replace(/^agent-/, '')
    let where = agentId
    if (runId) {
      if (!labels.has(runId))
        labels.set(
          runId,
          workflowLabels(files, join(sessionDir, 'subagents', 'workflows', runId, 'journal.jsonl')),
        )
      where = `${runId} ${labels.get(runId)?.get(agentId) ?? agentId}`
    } else {
      try {
        const meta = JSON.parse(files.read(path.replace(/\.jsonl$/, '.meta.json')) ?? '{}') as {
          description?: string
        }
        if (meta.description) where = `subagent ${meta.description}`
      } catch {
        // no meta
      }
    }
    killed.push(
      ...killedCalls(parseTranscript(body), diedAt, where, { agentId, runId, transcript: path }),
    )
  }
  const openMainCalls = [...main.uses.values()]
    .filter((use) => !main.results.has(use.id) && (use.at ?? 0) <= diedAt + 5_000)
    .map((use) => `${use.name} ${use.id}`)
  const projectDir = basename(dirname(transcript))
  const lostBackground = [...main.backgroundStarted.entries()]
    .filter(([id, at]) => !main.notified.has(id) && (at ?? 0) >= diedAt - 24 * 3600_000)
    .map(([id]) => {
      const output = join(`/tmp/claude-${uid}`, projectDir, sessionId, 'tasks', `${id}.output`)
      return { id, output: files.mtime(output) !== null ? output : null }
    })
  return {
    transcript,
    lastOwner: main.lastOwner,
    openMainCalls,
    killed: killed.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
    workflows: unfinishedWorkflows(files, sessionDir),
    lostBackground,
  }
}

/** The killed call most likely to have caused an OOM kill: one whose command
 * names the kernel's victim, else the most recently started. */
export function likelyCulprit(calls: KilledCall[], victimComm: string | null): KilledCall | null {
  if (calls.length === 0) return null
  const comm = victimComm?.toLowerCase() ?? ''
  const named = comm ? calls.filter((call) => call.command.toLowerCase().includes(comm)) : []
  const pool = named.length ? named : calls
  return pool.reduce((latest, call) =>
    (call.startedAt ?? 0) > (latest.startedAt ?? 0) ? call : latest,
  )
}

// --- git ----------------------------------------------------------------------

export interface GitState {
  head: string
  subject: string
  committedAt: number
  modified: number
  untracked: number
  topDirs: string[]
  short: string[]
}

/** From `git log -1 --format=%h%x09%ct%x09%s` and `git status --porcelain`. */
export function parseGitState(log: string, status: string): GitState | null {
  const [head, time, ...subject] = log.trim().split('\t')
  if (!head) return null
  const short = status.split('\n').filter((line) => line.length > 3)
  const untracked = short.filter((line) => line.startsWith('??'))
  const dirs = new Map<string, number>()
  for (const line of short) {
    const path = line.slice(3).replace(/^"|"$/g, '')
    const top = path.includes('/') ? `${path.split('/')[0]}/` : path
    dirs.set(top, (dirs.get(top) ?? 0) + 1)
  }
  return {
    head,
    subject: subject.join('\t'),
    committedAt: Number(time) * 1000,
    modified: short.length - untracked.length,
    untracked: untracked.length,
    topDirs: [...dirs.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([dir]) => dir),
    short,
  }
}

// --- synopsis -----------------------------------------------------------------

export type CrashKind = 'pane-stopped' | 'agent-exited' | 'server-died'

export interface CrashFacts {
  kind: CrashKind
  /** Unit result, or `signal` for an agent that exited on a signal. */
  cause: string
  signal: number | null
  victim: OomVictim | null
  agentWasHog: boolean
  diedAt: number
  resumedAt: number
  attempt: number
  /** The owner resumed a held crash; not an automatic attempt. */
  manual?: boolean
  maxAttempts: number
  detailFile: string
  git: GitState | null
  transcript: TranscriptFacts | null
  leases: string[]
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local `YYYY-MM-DD HH:MM:SS`. */
export function stamp(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function clock(ms: number, reference: number): string {
  const full = stamp(ms)
  return full.slice(0, 10) === stamp(reference).slice(0, 10)
    ? full.slice(11, 16)
    : full.slice(0, 16)
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}min` : `${hours}h`
}

export function size(bytes: number | null): string {
  if (bytes === null) return 'unknown size'
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

function causeLine(facts: CrashFacts): string {
  const victim = facts.victim
  const where =
    victim?.constraint === 'memcg' ? 'your pane hit its memory cap' : 'the host ran out of memory'
  if (facts.kind === 'agent-exited') {
    if (victim && facts.agentWasHog)
      return `${where} and the kernel killed your own process (${victim.comm} pid ${victim.pid}, ${size(victim.rssBytes)}). The pane stayed up; Tether restarted it, which ended every process still in it`
    return `your process was killed by signal ${facts.signal ?? '?'}${victim ? ` after the kernel OOM-killed ${victim.comm} pid ${victim.pid} (${size(victim.rssBytes)})` : ''}. The pane stayed up; Tether restarted it, which ended every process still in it`
  }
  if (facts.kind === 'server-died')
    return `the tmux server holding your pane died${facts.cause === SERVER_LOST ? ' while you were running' : ` (${facts.cause})`}, which ended you, your subagents and every process you started`
  if (victim)
    return `${where}; the kernel killed ${victim.comm} pid ${victim.pid} at ${size(victim.rssBytes)} in your pane, then systemd stopped the whole pane: you, your subagents and every process you started`
  return `your pane ended with result ${facts.cause}, which stopped you, your subagents and every process you started`
}

function callLabel(call: KilledCall): string {
  return call.where === 'main' ? 'your main thread' : call.where
}

/** The resume prompt: facts only, at most `limit` bytes (2000 fits a prompt). */
export function renderSynopsis(facts: CrashFacts, limit = 2000): string {
  const t = facts.transcript
  const oom = facts.cause === 'oom-kill' || facts.victim !== null
  const culprit = t && oom ? likelyCulprit(t.killed, facts.victim?.comm ?? null) : null
  const others = (t?.killed ?? []).filter((call) => call !== culprit)
  const build = (level: number): string => {
    const lines: string[] = []
    let head =
      `${SYNOPSIS_HEAD}${clock(facts.diedAt, facts.resumedAt)} and Tether resumed it at ` +
      `${clock(facts.resumedAt, facts.resumedAt)} (down ${duration(facts.resumedAt - facts.diedAt)}). ` +
      `Cause: ${causeLine(facts)}.`
    if (culprit)
      head += ` Likely culprit: ${callLabel(culprit)} ran \`${oneLine(culprit.command, level > 2 ? 80 : 160)}\`${culprit.startedAt ? ` from ${clock(culprit.startedAt, facts.resumedAt)}` : ''}, ${culprit.outcome}.`
    if (others.length && level < 2) {
      const shown = others.slice(0, level ? 3 : 6).map((call) => callLabel(call))
      const more = others.length - shown.length
      head += ` Also killed mid-run: ${[...new Set(shown)].join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
    }
    lines.push(head)
    const state: string[] = []
    if (facts.git) {
      const g = facts.git
      state.push(
        `State: HEAD ${g.head} (${oneLine(g.subject, level > 1 ? 40 : 70)}, ${clock(g.committedAt, facts.resumedAt)}). ` +
          `Uncommitted: ${g.modified} modified, ${g.untracked} untracked${g.topDirs.length ? ` (${g.topDirs.join(', ')})` : ''}.`,
      )
    }
    if (facts.leases.length) state.push('Your leases are still held.')
    if (t?.workflows.length) {
      const flows = t.workflows
        .slice(0, level > 2 ? 1 : 3)
        .map(
          (w) =>
            `${w.runId} (${w.name}: ${w.done} done${w.inFlight.length ? `, ${level > 1 ? `${w.inFlight.length} in flight` : `in flight ${w.inFlight.slice(0, 4).join(', ')}`}` : ''})`,
        )
      state.push(`Workflows not finished: ${flows.join('; ')}.`)
    }
    if (t)
      state.push(
        `Open main-thread calls: ${t.openMainCalls.length ? t.openMainCalls.slice(0, 3).join(', ') : 'none'}.`,
      )
    state.push(`Detail: ${facts.detailFile}`)
    state.push(
      facts.manual
        ? 'Tether held this crash and the owner resumed it.'
        : `This is automatic recovery ${facts.attempt} of ${facts.maxAttempts} in 6 hours.`,
    )
    lines.push(state.join(' '))
    if (facts.agentWasHog)
      lines.push(
        'Warning: your own process was the memory hog. Save notes now, compact your context, and keep large outputs out of it. If it happens again, Tether will not resume you automatically.',
      )
    lines.push('Do first, in order:')
    let step = 1
    lines.push(
      `${step++}. Check the uncommitted work; killed jobs leave partial files. Commit what is sound, discard half-written outputs.`,
    )
    lines.push(
      oom
        ? `${step++}. Do not rerun the culprit unchanged: wrap it in systemd-run --user --scope -p MemoryMax=<cap> -p MemorySwapMax=0, run heavy jobs one at a time, or make it smaller.`
        : `${step++}. Find out what ended the session before repeating the step that was running.`,
    )
    if (t?.workflows.length)
      lines.push(
        `${step++}. Resume each unfinished workflow with Workflow({scriptPath, resumeFromRunId}); finished agent() calls return cached, in-flight ones restart. Edit the script first if a lane must change.`,
      )
    lines.push(
      `${step++}. Relaunch any server, watcher or background job you still need; none survived.`,
    )
    const owner = t?.lastOwner
    lines.push(
      `${step++}. Continue the owner's last instruction${owner ? ` (${clock(owner.at, facts.resumedAt)}: "${oneLine(owner.text, level > 1 ? 50 : 80)}")` : ''}. If the same failure recurs, stop that lane and record it in FOLLOWUPS.md instead of retrying.`,
    )
    return lines.join('\n')
  }
  for (let level = 0; level < 4; level += 1) {
    const text = build(level)
    if (Buffer.byteLength(text) <= limit) return text
  }
  const text = build(3)
  let cut = text.slice(0, limit)
  while (Buffer.byteLength(cut) > limit) cut = cut.slice(0, -1)
  return cut
}

export interface DetailSections {
  synopsis: string
  unitLines: string[]
  kernelLines: string[]
  memctlLines: string[]
  memoryEvents: string | null
  leases: string[]
}

/** The full crash record for the resumed agent and the owner. */
export function renderDetail(facts: CrashFacts, sections: DetailSections): string {
  const out: string[] = []
  const block = (title: string, lines: string[], empty = 'none') => {
    out.push(`## ${title}`, '')
    if (lines.length === 0) out.push(empty)
    else out.push('```', ...lines, '```')
    out.push('')
  }
  out.push(`# Crash recovery, ${stamp(facts.diedAt)}`, '')
  out.push('## Prompt the agent was resumed with', '', sections.synopsis, '')
  block('Unit journal', sections.unitLines)
  block('Kernel OOM records', sections.kernelLines)
  block('Memory controller (memctl)', sections.memctlLines)
  if (sections.memoryEvents) block('nightshift memory events', sections.memoryEvents.split('\n'))
  const t = facts.transcript
  if (t) {
    out.push('## Calls in flight or killed', '')
    if (t.killed.length === 0) out.push('none')
    for (const call of t.killed)
      out.push(
        `- ${callLabel(call)}${call.agentId ? ` (agent ${call.agentId})` : ''}: \`${oneLine(call.command, 400)}\`, ${call.outcome}${call.startedAt ? `, started ${stamp(call.startedAt)}` : ''}${call.background ? ', background' : ''}. Transcript: ${call.transcript}`,
      )
    out.push('')
    out.push('## Unfinished workflows', '')
    if (t.workflows.length === 0) out.push('none')
    for (const w of t.workflows)
      out.push(
        `- ${w.runId} ${w.name}: ${w.done} done; in flight: ${w.inFlight.join(', ') || 'none'}. Script: ${w.scriptPath ?? 'not found'}`,
      )
    out.push('')
    out.push('## Background jobs that did not report back', '')
    if (t.lostBackground.length === 0) out.push('none')
    for (const job of t.lostBackground) out.push(`- ${job.id}: output ${job.output ?? 'not found'}`)
    out.push('')
    out.push(`Main transcript: ${t.transcript}`, '')
  }
  block('git status --short', facts.git?.short.slice(0, 200) ?? [], 'not a git checkout')
  block('Leases', sections.leases)
  return out.join('\n')
}
