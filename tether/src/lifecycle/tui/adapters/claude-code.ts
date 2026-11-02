// Claude Code. State comes from ~/.claude/sessions/<pid>.json (`status`
// busy | waiting | idle), the model watch from its transcript
// (~/.claude/projects/<dir>/<sessionId>.jsonl). Both formats are undocumented
// (docs/agent-state.md), so everything that reads them is in this module.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentSignal } from '../../../agent-state'
import {
  keyOf,
  type ModelEvent,
  type ModelSource,
  model,
  parse,
  refusalCategory,
  time,
  UUID,
} from '../../../model-record'
import type { AgentObservation, FileTail, ProcFs } from '../../../proc-fs'
import { UUID_RE } from '../../../proc-fs'
import { agentHubRepo, resolveLauncher, unknownCheckout, viaShim } from '../context-support'
import type { ContextStatus, TuiSpec } from '../spec'
import type { AgentProbe, TuiAdapter } from './contract'

// --- state ------------------------------------------------------------------

export interface ClaudeSession {
  pid: number
  /** ~/.claude/sessions/<pid>.json */
  file: string
  state: Record<string, unknown>
}

function readClaudeSession(fs: ProcFs, home: string, pid: number): ClaudeSession | null {
  const file = join(home, '.claude', 'sessions', `${pid}.json`)
  try {
    const state = JSON.parse(fs.readFile(file)) as Record<string, unknown>
    return state.pid === pid ? { pid, file, state } : null
  } catch {
    return null
  }
}

/** The running background job `jobId` (`kind: bg`, under Claude's daemon):
 * in the pane's tree when this session's own daemon hosts it, else any live
 * session file that names it. */
function claudeJob(fs: ProcFs, home: string, pids: number[], jobId: string): ClaudeSession | null {
  const isJob = (session: ClaudeSession | null) =>
    session?.state.jobId === jobId && session.state.kind === 'bg'
  for (const pid of pids) {
    const session = readClaudeSession(fs, home, pid)
    if (isJob(session)) return session
  }
  let names: string[] = []
  try {
    names = fs.readdir(join(home, '.claude', 'sessions'))
  } catch {
    return null
  }
  for (const name of names) {
    const pid = /^([1-9][0-9]*)\.json$/.exec(name)?.[1]
    if (!pid || pids.includes(Number(pid))) continue
    const session = readClaudeSession(fs, home, Number(pid))
    if (!isJob(session)) continue
    try {
      fs.readFile(`/proc/${pid}/stat`)
      return session
    } catch {
      // a file left by a job that ended
    }
  }
  return null
}

/** Claude Code writes ~/.claude/sessions/<pid>.json for each interactive
 * process. Yields each pid whose file parses and names that pid (a stale file
 * left by a reused pid names another process). A session parked into a
 * background job (`parkedJobId`) stops updating its own file: the pane shows
 * the job, so the job's file stands in for it. */
export function* claudeSessions(
  fs: ProcFs,
  home: string,
  pids: number[],
): Generator<ClaudeSession> {
  const seen = new Set<number>()
  for (const pid of pids) {
    if (seen.has(pid)) continue
    let session = readClaudeSession(fs, home, pid)
    if (!session) continue
    const parked = session.state.parkedJobId
    if (typeof parked === 'string' && parked) session = claudeJob(fs, home, pids, parked) ?? session
    seen.add(session.pid)
    yield session
  }
}

function claudeFileTime(state: Record<string, unknown>): number {
  const times = [state.updatedAt, state.statusUpdatedAt, state.startedAt].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )
  return times.length ? Math.max(...times) : 0
}

/** The live Claude session file in an entry home. Its pid is the container's,
 * so it cannot be matched against the pane's processes: one agent runs per
 * home, so it is the interactive file updated last (a stale file left by an
 * earlier process is older). A session parked into a background job is
 * represented by that job's file, as in `claudeSessions`. */
export function entryClaudeSession(fs: ProcFs, home: string): ClaudeSession | null {
  const dir = join(home, '.claude', 'sessions')
  let names: string[] = []
  try {
    names = fs.readdir(dir)
  } catch {
    return null
  }
  const sessions: ClaudeSession[] = []
  for (const name of names) {
    const pid = /^([1-9][0-9]*)\.json$/.exec(name)?.[1]
    if (!pid) continue
    const session = readClaudeSession(fs, home, Number(pid))
    if (session) sessions.push(session)
  }
  let best: ClaudeSession | null = null
  for (const session of sessions) {
    if (session.state.kind === 'bg') continue
    if (!best || claudeFileTime(session.state) > claudeFileTime(best.state)) best = session
  }
  const parked = best?.state.parkedJobId
  if (best && typeof parked === 'string' && parked)
    return sessions.find((job) => job.state.jobId === parked && job.state.kind === 'bg') ?? best
  return best
}

// --- Claude Code ------------------------------------------------------------

export interface ClaudeProcess {
  pid: number
  file: string
}

/** The Claude Code process in a pane's process tree, by its session file. */
export function findClaude(fs: ProcFs, home: string, pids: number[]): ClaudeProcess | null {
  for (const { pid, file } of claudeSessions(fs, home, pids)) return { pid, file }
  return null
}

/** Claude's status: busy → working, waiting → blocked, idle or shell → idle. */
export function claudeSignal(text: string): AgentSignal | null {
  let state: Record<string, unknown>
  try {
    state = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof state !== 'object' || state === null) return null
  const at = typeof state.statusUpdatedAt === 'number' ? state.statusUpdatedAt : null
  const agentSessionId =
    typeof state.sessionId === 'string' && UUID_RE.test(state.sessionId) ? state.sessionId : null
  const base = { source: 'claude-status', at, agentSessionId }
  switch (state.status) {
    case 'busy':
      return { ...base, state: 'working', detail: null }
    case 'waiting':
      return {
        ...base,
        state: 'blocked',
        detail: typeof state.waitingFor === 'string' ? state.waitingFor : 'waiting',
      }
    case 'idle':
    case 'shell':
      return { ...base, state: 'idle', detail: null }
    default:
      return null
  }
}

/** The first Claude Code session in `pids` with a resumable session ID. */
export function observeClaude(fs: ProcFs, home: string, pids: number[]): AgentObservation | null {
  for (const { pid, state } of claudeSessions(fs, home, pids)) {
    if (typeof state.sessionId !== 'string' || !UUID_RE.test(state.sessionId)) continue
    return {
      pid,
      resumeId: state.sessionId,
      idle: state.status !== 'busy',
      blocked: state.status === 'waiting',
    }
  }
  return null
}

// --- model watch ------------------------------------------------------------

const CLAUDE_HINT =
  /"type":\s*"(?:assistant|user)"|model_refusal|command-name>\/model<|stdout>Kept model as/

/** The marker Claude Code writes as a user row when a turn is interrupted
 * (`[Request interrupted by user]`, `… for tool use]`): not a prompt, and
 * not in the rewind list. */
const INTERRUPTED = /^\[Request interrupted by user\b/

/** An owner's prompt: a user row with text, not a tool result, meta row,
 * compact summary, interrupt marker or a row Claude Code itself made (an
 * `origin` other than `human`, such as a background task's notice). */
function isPrompt(row: Record<string, unknown>): boolean {
  if (
    row.isMeta === true ||
    row.isCompactSummary === true ||
    row.isVisibleInTranscriptOnly === true
  )
    return false
  const origin = (row.origin as { kind?: unknown } | undefined)?.kind
  if (origin !== undefined && origin !== 'human') return false
  const content = (row.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string')
    return !content.startsWith('<') && content.trim() !== '' && !INTERRUPTED.test(content)
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (part) =>
        (part as { type?: unknown })?.type === 'text' ||
        (part as { type?: unknown })?.type === 'image',
    ) &&
    !content.every(
      (part) =>
        (part as { type?: unknown })?.type === 'text' &&
        INTERRUPTED.test(String((part as { text?: unknown }).text ?? '')),
    )
  )
}

/** One Claude Code transcript row. Sidechain rows (subagents run their own
 * models) say nothing about the session; a `<synthetic>` row (an error Claude
 * Code wrote itself) names no model. */
export function claudeModelEvents(line: string): ModelEvent[] {
  if (!CLAUDE_HINT.test(line)) return []
  const row = parse(line)
  if (!row || row.isSidechain === true) return []
  const at = time(row.timestamp)
  if (row.type === 'system' && row.subtype === 'model_refusal_fallback') {
    const to = model(row.fallbackModel)
    if (!to) return []
    return [
      {
        type: 'refusal',
        from: model(row.originalModel),
        to,
        category: refusalCategory(row.apiRefusalCategory),
        key: keyOf(row.requestId, row.uuid, row.timestamp) ?? `at-${at ?? 0}`,
        at,
      },
    ]
  }
  if (row.type === 'system' && row.subtype === 'model_refusal_no_fallback')
    return [
      {
        type: 'noFallback',
        model: model(row.originalModel),
        category: refusalCategory(row.apiRefusalCategory),
        key: keyOf(row.requestId, row.uuid, row.timestamp) ?? `at-${at ?? 0}`,
        at,
      },
    ]
  if (
    row.type === 'system' &&
    row.subtype === 'local_command' &&
    typeof row.content === 'string' &&
    row.content.includes('<command-name>/model</command-name>')
  )
    return [{ type: 'chosen', at }]
  if (
    row.type === 'system' &&
    row.subtype === 'local_command' &&
    typeof row.content === 'string' &&
    row.content.startsWith('<local-command-stdout>Kept model as ')
  )
    return [{ type: 'kept', at }]
  if (row.type === 'user') {
    return typeof row.uuid === 'string' && UUID.test(row.uuid) && isPrompt(row)
      ? [{ type: 'prompt', uuid: row.uuid, at }]
      : []
  }
  if (row.type === 'assistant') {
    const message = row.message as Record<string, unknown> | undefined
    const served = model(message?.model)
    if (message?.stop_reason === 'refusal') {
      const details = message.stop_details as { category?: unknown } | undefined
      return [
        {
          type: 'refused',
          model: served,
          category: refusalCategory(details?.category),
          key: keyOf(row.requestId, row.uuid, message.id, row.timestamp) ?? `at-${at ?? 0}`,
          at,
        },
      ]
    }
    return served ? [{ type: 'served', model: served, at }] : []
  }
  return []
}

function exists(fs: ProcFs, path: string): boolean {
  return fs.mtimeMs ? fs.mtimeMs(path) !== null : readable(fs, path)
}

/** `<home>/.claude/projects/<dir>/<sessionId>.jsonl`, the first that exists. */
export function claudeTranscriptPath(fs: ProcFs, home: string, sessionId: string): string | null {
  if (!UUID.test(sessionId)) return null
  const root = join(home, '.claude', 'projects')
  let dirs: string[]
  try {
    dirs = fs.readdir(root)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const path = join(root, dir, `${sessionId}.jsonl`)
    if (exists(fs, path)) return path
  }
  return null
}

function readable(fs: ProcFs, path: string): boolean {
  try {
    fs.readHead(path, 1)
    return true
  } catch {
    return false
  }
}

/** The text of the owner's prompt `uuid` in a Claude transcript, and the
 * first line of each owner's prompt after it, oldest first (what a rewind
 * walks past in the window's list). */
export function claudePromptAt(
  transcript: string,
  uuid: string,
): { text: string; after: string[] } | null {
  if (!UUID.test(uuid)) return null
  let text: string | null = null
  const after: string[] = []
  for (const line of transcript.split('\n')) {
    if (!line.includes('"user"')) continue
    const row = parse(line)
    if (row?.type !== 'user' || row.isSidechain === true || !isPrompt(row)) continue
    const content = (row.message as { content?: unknown }).content
    const body =
      typeof content === 'string'
        ? content
        : (content as { type?: string; text?: unknown }[])
            .map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : ''))
            .join('\n')
    if (text === null) {
      if (row.uuid === uuid) text = body
    } else after.push(body.split('\n').find((l) => l.trim()) ?? '')
  }
  return text === null ? null : { text, after }
}

// --- context ---------------------------------------------------------------------

/** Claude Code: the source-linked launcher exposes exact canonical context as
 * one immutable additional-directory CLAUDE.md without replacing Claude's
 * native prompt. Claude preloads it for parent and spawned agents. Native
 * SessionStart/SubagentStart hooks bind that artifact to real IDs and warn on
 * degraded delivery; they do not block native launch or inject a second copy. */
async function claudeSessionStart(spec: TuiSpec): Promise<ContextStatus> {
  const settings = join(homedir(), '.claude', 'settings.json')
  const client = join(homedir(), '.local', 'bin', 'agent-hub-context-client')
  const repo = agentHubRepo()
  if (!repo) return unknownCheckout('AGENT_HUB_REPO', 'agent-hub')
  const expectedLauncher = join(repo, 'integrations', 'context-delivery', 'claude', 'launcher')
  if (!existsSync(settings) || !existsSync(client)) {
    return {
      state: 'missing',
      detail: `${settings} or ${client} absent — canonical context installation is incomplete`,
    }
  }
  const command = spec.command[0]
  const resolvedLauncher = command ? await resolveLauncher(command, spec) : null
  if (!resolvedLauncher) {
    return {
      state: 'missing',
      detail: `${command || 'Claude command'} not on the managed pane PATH — canonical context launcher unavailable; native Claude continues`,
    }
  }
  const { path: launcher, shim } = resolvedLauncher
  try {
    const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
    }
    // The shared settings.json spells the client home-relative so every user's sessions bind.
    const expectedCommands = [
      `${client} bind --surface claude_code`,
      '"$HOME"/.local/bin/agent-hub-context-client bind --surface claude_code',
    ]
    const hasHook = (event: string): boolean =>
      parsed.hooks?.[event]?.some((group) =>
        group.hooks?.some((hook) => expectedCommands.includes(hook.command ?? '')),
      ) ?? false
    const resolved = realpathSync(launcher)
    const canonicalLauncher = resolved === expectedLauncher
    const launcherBody = readFileSync(launcher, 'utf8')
    const additive =
      launcherBody.includes('CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD') &&
      launcherBody.includes('"--add-dir"') &&
      launcherBody.includes('CLAUDE.md')
    if (canonicalLauncher && additive && hasHook('SessionStart') && hasHook('SubagentStart')) {
      return {
        state: 'available',
        detail: `${viaShim(shim)}${launcher} reaches the canonical additive Claude launcher with native session binding hooks installed; model receipt is unverified`,
      }
    }
  } catch {
    // Fall through to the single degraded result below.
  }
  return {
    state: 'missing',
    detail: `${viaShim(shim)}${launcher} or Claude native hooks are drifted from canonical Agent Hub sources`,
  }
}

// --- the adapter -----------------------------------------------------------------

/** Where the model watch finds this conversation's transcript: by id, since a
 * new conversation or a resume moves it. */
export function claudeModelSource(
  agent: number,
  sessionId: string,
  fs: ProcFs,
  home: string,
  tail?: FileTail,
): ModelSource {
  return {
    tool: 'claude',
    agent,
    locate: {
      sessionId,
      fileName: `${sessionId}.jsonl`,
      find: () => claudeTranscriptPath(fs, home, sessionId),
      exists: (path) => exists(fs, path),
    },
    ...(tail ? { tail } : {}),
  }
}

/** One Claude Code process, read through the files of the home it runs in. */
class ClaudeProbe implements AgentProbe {
  constructor(
    readonly pid: number,
    private readonly file: string,
    private readonly fs: ProcFs,
    private readonly home: string,
    private readonly tail?: FileTail,
  ) {}

  poll(): AgentSignal | null {
    try {
      return claudeSignal(this.fs.readFile(this.file))
    } catch {
      return null
    }
  }

  models(signal: AgentSignal | null) {
    const sessionId = signal?.agentSessionId
    return sessionId ? claudeModelSource(this.pid, sessionId, this.fs, this.home, this.tail) : null
  }
}

export const claudeCode: TuiAdapter = {
  id: 'claude-code',
  harness: 'claude',
  executor: 'claude_code',
  seed: {
    slug: 'claude-code',
    name: 'Claude Code',
    argv: ['claude', '--dangerously-skip-permissions'],
    processName: 'claude',
    description: 'Anthropic Claude Code coding agent',
    color: '#D97757',
    displayOrder: 0,
    isDefault: false,
    enabled: true,
    aliases: ['claude'],
    contextHook: 'claude-session-start',
  },
  launch: { ensureArgs: [] },
  spec: {
    resume: { sessionIdPattern: UUID_RE, arguments: ['--resume'] },
    instructions: { arguments: ['--append-system-prompt'] },
    // Claude Code's documented --model and --effort (claude --help); an override
    // wins over the user's settings, which a Blank Slate session keeps.
    modelSelection: {
      model: ['--model'],
      reasoningEffort: {
        arguments: ['--effort'],
        values: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
    },
  },
  capabilities: {
    root: true,
    blankSlate: true,
    instructions: true,
    entry: true,
    entryDefault: true,
    rewind: true,
    stateHooks: true,
    modelWatch: true,
    transcriptFacts: true,
    threadSubagents: false,
    nativeAdmin: false,
    agentHubContext: false,
    environmentSelection: false,
    delivery: { idlePaste: true, nextTurn: true, toolResult: true },
  },
  entryApiVersion: 15,
  state: {
    find: (ctx) => {
      for (const { pid, file } of claudeSessions(ctx.fs, ctx.home, ctx.pids))
        return new ClaudeProbe(pid, file, ctx.fs, ctx.home)
      return null
    },
    findInEntry: ({ entry, readers }) => {
      const session = entryClaudeSession(readers.fs, readers.home)
      return session
        ? new ClaudeProbe(
            entry.pid,
            session.file,
            readers.fs,
            readers.home,
            readers.tail ?? undefined,
          )
        : null
    },
    observe: observeClaude,
    observeInEntry: (readers, entry) => {
      const state = entryClaudeSession(readers.fs, readers.home)?.state
      if (!state || typeof state.sessionId !== 'string' || !UUID_RE.test(state.sessionId))
        return null
      return {
        pid: entry.pid,
        resumeId: state.sessionId,
        idle: state.status !== 'busy',
        blocked: state.status === 'waiting',
      }
    },
  },
  context: { kind: { kind: 'claude-session-start' }, check: claudeSessionStart },
  hooks: {
    provider: 'claude_code',
    rideAlong: ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure'],
    stateReports: ['Notification', 'UserPromptSubmit', 'PermissionRequest', 'Stop'],
    installs: [
      { what: 'coord-inbox hooks (ride-along lines)', path: '~/.claude/settings.json' },
      { what: 'agent-state hook (state reports)', path: '~/.claude/hooks/agent-state.sh' },
      { what: 'Agent Hub context binding', path: '~/.local/bin/agent-hub-context-client' },
    ],
  },
  login: {
    signIn:
      'agent-hub native claude setup-token && agent-hub credential push claude-code && agent-hub install',
    signOut: { kind: 'revoke' },
    grant: true,
  },
  models: { events: claudeModelEvents, promptAt: claudePromptAt },
  sessionFile: claudeTranscriptPath,
  displayName: 'Claude Code',
}
