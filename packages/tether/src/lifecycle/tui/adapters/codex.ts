// Codex. State comes from the tail of the thread's rollout file
// (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl: task_started / task_complete,
// an unanswered request_user_input call), which the process holds open. The
// format is undocumented (docs/agent-state.md), so every reader is in this module.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentSignal } from '../../../agent-state'
import { ENTRY_SCAN_DEFAULTS, type EntryScanConfig } from '../../../config'
import { keyOf, type ModelEvent, model, parse, refusalCategory, time } from '../../../model-record'
import {
  type AgentObservation,
  type FileTail,
  nodeFileTail,
  type ProcFs,
  UUID_RE,
} from '../../../proc-fs'
import { resolveLauncher } from '../context-support'
import type { ContextStatus, TuiSpec } from '../spec'
import type { AgentProbe, TuiAdapter } from './contract'

const ROLLOUT_RE = /\/\.codex\/sessions\/.*\/rollout-[^/]*\.jsonl$/

export interface CodexRolloutFile {
  pid: number
  path: string
  /** The thread ID from session_meta; null when it is not a UUID. */
  threadId: string | null
}

/** Codex keeps its thread's rollout file open. Yields each held rollout whose
 * session_meta marks the user thread (not a subagent's): the conversation
 * `codex resume` takes. */
export function* codexUserRollouts(fs: ProcFs, pids: number[]): Generator<CodexRolloutFile> {
  for (const pid of pids) {
    let fds: string[] = []
    try {
      fds = fs.readdir(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    for (const fd of fds) {
      let target: string
      try {
        target = fs.readlink(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      if (!ROLLOUT_RE.test(target)) continue
      const user = codexUserThread(fs, target)
      if (user) yield { pid, path: target, threadId: user.threadId }
    }
  }
}

/** A rollout's session_meta when it marks the user thread (not a subagent's);
 * null for a subagent's or an unreadable or partial rollout. */
function codexUserThread(fs: ProcFs, path: string): { threadId: string | null } | null {
  try {
    const first = fs.readHead(path, 1024 * 1024).split('\n', 1)[0] as string
    const meta = JSON.parse(first) as { type?: string; payload?: Record<string, unknown> }
    const payload = meta.payload ?? {}
    if (meta.type !== 'session_meta' || payload.parent_thread_id) return null
    if (payload.thread_source !== undefined && payload.thread_source !== 'user') return null
    return {
      threadId: typeof payload.id === 'string' && UUID_RE.test(payload.id) ? payload.id : null,
    }
  } catch {
    return null
  }
}

/** The user thread's rollout in an entry home's `.codex/sessions`
 * (YYYY/MM/DD/rollout-*.jsonl). Codex in the container holds it open, but
 * its fds are not this host's to read, and one agent runs per home: so it is
 * the user thread's rollout written last (a subagent's is skipped; a resumed
 * thread appends to its own older file, which is then the newest). */
export function entryCodexRollout(
  fs: ProcFs,
  home: string,
  scan: EntryScanConfig = ENTRY_SCAN_DEFAULTS,
): { path: string; threadId: string | null } | null {
  const root = join(home, '.codex', 'sessions')
  const files: string[] = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = fs.readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (files.length >= scan.rolloutScan) return
      if (name.startsWith('.') || name.includes('/')) continue
      const path = `${dir}/${name}`
      if (depth === 3) {
        if (/^rollout-[^/]*\.jsonl$/.test(name)) files.push(path)
      } else if (/^[0-9]{2,4}$/.test(name)) walk(path, depth + 1)
    }
  }
  walk(root, 0)
  const when = new Map(files.map((path) => [path, fs.mtimeMs?.(path) ?? null]))
  // Newest first by write time; by name (creation time) without it.
  files.sort((a, b) => (when.get(b) ?? 0) - (when.get(a) ?? 0) || (a < b ? 1 : a > b ? -1 : 0))
  for (const path of files.slice(0, scan.rolloutOpen)) {
    if (fs.mtimeMs && when.get(path) === null) continue
    const user = codexUserThread(fs, path)
    if (user) return { path, threadId: user.threadId }
  }
  return null
}

// --- Codex ------------------------------------------------------------------

/** Tools whose call waits for the user's answer. */
const CODEX_QUESTION_TOOLS = new Set(['request_user_input'])
/** Approval prompts, if a Codex build ever records them in the rollout. */
const CODEX_APPROVAL_EVENTS = new Set([
  'exec_approval_request',
  'apply_patch_approval_request',
  'request_permissions',
])
/** Approval policies under which an escalated sandbox request waits for the
 * user (Codex records no event while its approval prompt is open). */
const CODEX_ASKING_POLICIES = new Set(['on-request', 'untrusted', 'on-failure'])
const ESCALATED = /sandbox_permissions\W+require_escalated/
/** First read of an existing rollout: enough tail for the current turn. */
const ROLLOUT_TAIL_BYTES = 512 * 1024
const ROLLOUT_MAX_STEP_BYTES = 4 * 1024 * 1024
/** A long turn's start can sit far before the tail: the first read walks back
 * this far at most, step by step, to find the latest turn boundary. */
const ROLLOUT_SCAN_STEP_BYTES = 1024 * 1024
const ROLLOUT_SCAN_MAX_BYTES = 256 * 1024 * 1024
const TURN_BOUNDARIES = new Set(['task_started', 'task_complete', 'turn_aborted'])
const MAYBE_BOUNDARY = /"(task_started|task_complete|turn_aborted)"/

/** The line is a turn start or end (not a tool output quoting one). */
function isTurnBoundary(line: string): boolean {
  if (!MAYBE_BOUNDARY.test(line)) return false
  try {
    const item = JSON.parse(line)
    return item?.type === 'event_msg' && TURN_BOUNDARIES.has(item.payload?.type)
  } catch {
    return false
  }
}

/** The user thread's rollout (not a subagent's) a Codex process holds open:
 * the first with a UUID thread ID, the thread reboot continuity resumes
 * (observeCodex), else the first user rollout so its state still shows. */
export function findCodexRollout(fs: ProcFs, pids: number[]): CodexRolloutFile | null {
  let fallback: CodexRolloutFile | null = null
  for (const rollout of codexUserRollouts(fs, pids)) {
    if (rollout.threadId) return rollout
    fallback ??= rollout
  }
  return fallback
}

/** Folds rollout lines into the thread's turn state. */
export class CodexTurn {
  private active = false
  private approval = false
  private readonly questions = new Set<string>()
  /** Escalated tool calls the user must approve, until their output. */
  private readonly escalations = new Set<string>()
  /** The turn's policy routes escalation requests to the user. */
  private asksUser = false
  /** Timestamp of the last line that changed the state. */
  at: number | null = null
  /** Turn starts and ends seen. */
  boundaries = 0

  constructor(readonly threadId: string | null = null) {}

  apply(line: string): void {
    let item: { timestamp?: string; type?: string; payload?: Record<string, unknown> }
    try {
      item = JSON.parse(line)
    } catch {
      return
    }
    const payload = item.payload ?? {}
    const kind = payload.type
    const at = item.timestamp ? Date.parse(item.timestamp) : Number.NaN
    const stamp = () => {
      if (Number.isFinite(at)) this.at = at
    }
    if (item.type === 'turn_context') {
      this.asksUser =
        typeof payload.approval_policy === 'string' &&
        CODEX_ASKING_POLICIES.has(payload.approval_policy) &&
        (payload.approvals_reviewer === undefined || payload.approvals_reviewer === 'user')
      return
    }
    if (item.type === 'event_msg') {
      if (typeof kind === 'string' && TURN_BOUNDARIES.has(kind)) {
        this.boundaries += 1
        this.active = kind === 'task_started'
        this.approval = false
        this.questions.clear()
        this.escalations.clear()
        stamp()
      } else if (typeof kind === 'string' && CODEX_APPROVAL_EVENTS.has(kind)) {
        this.approval = true
        stamp()
      } else if (this.approval && kind !== 'token_count') {
        // Anything the turn does next means the approval was answered.
        this.approval = false
        stamp()
      }
      return
    }
    if (item.type !== 'response_item') return
    const callId = typeof payload.call_id === 'string' ? payload.call_id : null
    if (
      (kind === 'function_call' || kind === 'custom_tool_call') &&
      callId &&
      typeof payload.name === 'string' &&
      CODEX_QUESTION_TOOLS.has(payload.name)
    ) {
      this.questions.add(callId)
      stamp()
    } else if (
      (kind === 'function_call' || kind === 'custom_tool_call') &&
      callId &&
      this.asksUser &&
      ESCALATED.test(String(payload.arguments ?? payload.input ?? ''))
    ) {
      this.escalations.add(callId)
      stamp()
    } else if (
      (kind === 'function_call_output' || kind === 'custom_tool_call_output') &&
      callId &&
      (this.questions.delete(callId) || this.escalations.delete(callId))
    ) {
      stamp()
    } else if (this.approval) {
      this.approval = false
      stamp()
    }
  }

  signal(): AgentSignal {
    const base = { source: 'codex-rollout', at: this.at, agentSessionId: this.threadId }
    if (this.active && this.questions.size > 0)
      return { ...base, state: 'blocked', detail: 'input needed' }
    if (this.active && (this.approval || this.escalations.size > 0))
      return { ...base, state: 'blocked', detail: 'permission prompt' }
    return { ...base, state: this.active ? 'working' : 'idle', detail: null }
  }
}

/** Incremental reader of one rollout file. */
export class CodexRollout {
  private offset = 0
  private readonly turn: CodexTurn
  private started = false
  /** Set when the first read found no turn boundary it could trust: the state
   * stays unknown until the next one is appended. */
  private blindUntil: number | null = null

  constructor(
    readonly path: string,
    threadId: string | null,
    readonly tail: FileTail = nodeFileTail,
  ) {
    this.turn = new CodexTurn(threadId)
  }

  poll(): AgentSignal | null {
    let chunk: { text: string; offset: number }
    try {
      if (!this.started) {
        const probe = this.tail.read(this.path, 0, ROLLOUT_TAIL_BYTES)
        let lines = probe.text.split('\n')
        let start = probe.offset - Buffer.byteLength(probe.text)
        // A tail that starts mid-file begins with a partial line.
        if (start > 0) start += Buffer.byteLength(lines.shift() ?? '') + 1
        if (start > 0 && !lines.some(isTurnBoundary)) {
          // The turn began before the tail: without its start it reads as idle.
          const earlier = this.fromLastBoundary(start)
          if (earlier) lines = [...earlier, ...lines]
          else this.blindUntil = this.turn.boundaries
        }
        for (const line of lines) if (line) this.turn.apply(line)
        this.offset = probe.offset
        this.started = true
        return this.signal()
      }
      chunk = this.tail.read(this.path, this.offset, ROLLOUT_MAX_STEP_BYTES)
    } catch {
      return null
    }
    this.offset = chunk.offset
    for (const line of chunk.text.split('\n')) if (line) this.turn.apply(line)
    return this.signal()
  }

  private signal(): AgentSignal | null {
    if (this.blindUntil !== null && this.turn.boundaries === this.blindUntil) return null
    this.blindUntil = null
    return this.turn.signal()
  }

  /** Complete lines from the latest turn boundary before `end` (a line start)
   * to the end of the step that holds it; [] when the file has none, null when
   * the scan gave up (the state is then unknown, never a guessed idle). */
  private fromLastBoundary(end: number): string[] | null {
    let carry = Buffer.alloc(0)
    for (let at = end; at > 0; ) {
      if (end - at >= ROLLOUT_SCAN_MAX_BYTES) return null
      const start = Math.max(0, at - ROLLOUT_SCAN_STEP_BYTES)
      let chunk = Buffer.concat([this.tail.range(this.path, start, at), carry])
      at = start
      if (start > 0) {
        // Up to the first newline is the end of a line that starts earlier.
        const newline = chunk.indexOf(10)
        if (newline < 0) {
          carry = chunk
          continue
        }
        carry = chunk.subarray(0, newline + 1)
        chunk = chunk.subarray(newline + 1)
      }
      const lines = chunk.toString('utf8').split('\n')
      for (let i = lines.length - 1; i >= 0; i--)
        if (isTurnBoundary(lines[i] as string)) return lines.slice(i)
    }
    return []
  }
}

/** The first Codex user thread in `pids` with a resumable thread ID. */
export function observeCodex(fs: ProcFs, pids: number[]): AgentObservation | null {
  for (const { pid, threadId } of codexUserRollouts(fs, pids)) {
    if (threadId) return { pid, resumeId: threadId, idle: null, blocked: false }
  }
  return null
}

// --- model watch ------------------------------------------------------------

/** One Codex rollout line. */
export function codexModelEvents(line: string): ModelEvent[] {
  if (!line.includes('"turn_context"') && !line.includes('model_reroute')) return []
  const row = parse(line)
  const payload = row?.payload as Record<string, unknown> | undefined
  if (!row || !payload) return []
  const at = time(row.timestamp)
  if (row.type === 'turn_context') {
    const asked = model(payload.model)
    return asked ? [{ type: 'requested', model: asked, at }] : []
  }
  if (row.type === 'event_msg' && payload.type === 'model_reroute') {
    const to = model(payload.to_model ?? payload.toModel)
    if (!to) return []
    return [
      {
        type: 'refusal',
        from: model(payload.from_model ?? payload.fromModel),
        to,
        category: refusalCategory(payload.reason),
        key: `reroute-${keyOf(payload.turn_id, payload.turnId) ?? at ?? 0}`,
        at,
      },
    ]
  }
  return []
}

// --- context ---------------------------------------------------------------------

/** Codex: on fresh threads the source-linked launcher places exact canonical
 * bytes in additive developer_instructions; native hook output is not used
 * because Codex spills larger hook context to a truncated preview. Native hooks
 * bind that fresh immutable delivery to real IDs. Resume/fork deliberately make
 * no fresh delivery or binding claim because Codex restores saved thread
 * context. Ask Codex's app-server for the effective hook registry too. */
async function codexHooks(spec: TuiSpec): Promise<ContextStatus> {
  const resolvedLauncher = await resolveLauncher('codex', spec)
  if (!resolvedLauncher) {
    return {
      state: 'missing',
      detail:
        'codex not on the managed pane PATH — canonical context launcher unavailable; native Codex continues',
    }
  }
  const { path: launcher } = resolvedLauncher

  return new Promise((resolve) => {
    const child = spawn(launcher, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (status: ContextStatus): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(status)
    }
    const inspectLines = (): void => {
      for (;;) {
        const newline = stdout.indexOf('\n')
        if (newline < 0) return
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (!line) continue
        let response: {
          id?: number
          result?: { data?: Array<{ hooks?: Array<Record<string, unknown>> }> }
        }
        try {
          response = JSON.parse(line) as typeof response
        } catch {
          continue
        }
        if (response.id !== 1) continue
        const hooks = response.result?.data?.[0]?.hooks ?? []
        const expectedCommands = [
          `${join(homedir(), '.local', 'bin', 'aico-hook')} codex`,
          '$HOME/.local/bin/aico-hook codex',
          '"$HOME"/.local/bin/aico-hook codex',
        ]
        const unhealthy = ['sessionStart', 'subagentStart'].filter(
          (eventName) =>
            !hooks.some(
              (hook) =>
                hook.eventName === eventName &&
                expectedCommands.includes(String(hook.command ?? '')) &&
                hook.enabled === true &&
                hook.trustStatus === 'trusted',
            ),
        )
        finish(
          unhealthy.length === 0
            ? {
                state: 'available',
                detail: `${launcher} has the trusted Aico native context hooks installed; model receipt is unverified`,
              }
            : {
                state: 'missing',
                detail: `Codex Aico hooks missing/untrusted: ${unhealthy.join(', ')}`,
              },
        )
        return
      }
    }
    const timer = setTimeout(
      () =>
        finish({
          state: 'missing',
          detail: `codex app-server hook check timed out: ${stderr.trim() || 'no response'}`,
        }),
      5000,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      inspectLines()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ state: 'missing', detail: `codex app-server hook check failed: ${error.message}` })
    })
    child.on('close', () => {
      if (!settled) {
        finish({
          state: 'missing',
          detail: `codex app-server closed before hook state: ${stderr.trim() || 'no response'}`,
        })
      }
    })
    child.stdin.write(
      [
        JSON.stringify({
          method: 'initialize',
          id: 0,
          params: { clientInfo: { name: 'aico', title: 'Aico', version: '0.1.1' } },
        }),
        JSON.stringify({ method: 'initialized', params: {} }),
        JSON.stringify({ method: 'hooks/list', id: 1, params: { cwds: [process.cwd()] } }),
        '',
      ].join('\n'),
    )
  })
}

// --- the adapter -----------------------------------------------------------------

/** The Codex process and its rollout, kept (with its offset) while the thread is the same. */
class CodexProbe implements AgentProbe {
  constructor(
    readonly pid: number,
    readonly rollout: CodexRollout,
  ) {}

  poll(): AgentSignal | null {
    return this.rollout.poll()
  }

  models() {
    return { tool: 'codex', agent: this.pid, path: this.rollout.path, tail: this.rollout.tail }
  }
}

function codexProbe(
  pid: number,
  codex: { path: string; threadId: string | null },
  previous: AgentProbe | null,
  tail: FileTail | undefined,
): CodexProbe {
  if (previous instanceof CodexProbe && previous.rollout.path === codex.path)
    return new CodexProbe(pid, previous.rollout)
  return new CodexProbe(pid, new CodexRollout(codex.path, codex.threadId, tail))
}

export const codex: TuiAdapter = {
  id: 'codex',
  harness: 'codex',
  executor: 'codex',
  seed: {
    slug: 'codex',
    name: 'Codex',
    argv: ['codex', '--yolo'],
    processName: 'codex',
    description: 'OpenAI Codex coding agent',
    color: '#9B8CFF',
    displayOrder: 1,
    isDefault: true,
    enabled: true,
    aliases: [],
    contextHook: 'codex-hooks',
  },
  launch: { ensureArgs: [] },
  spec: {
    resume: { sessionIdPattern: UUID_RE, arguments: ['resume', '--no-daemon'] },
    instructions: { arguments: ['-c'], key: 'developer_instructions' },
    // Lossless additive developer instructions; hook output is cut to a preview.
    contextDelivery: { kind: 'config', arguments: ['-c'], key: 'developer_instructions' },
    modelSelection: {
      model: ['--model'],
      reasoningEffort: { arguments: ['-c'], key: 'model_reasoning_effort' },
      daybreak: { arguments: ['-c'], key: 'daybreak' },
    },
  },
  capabilities: {
    root: true,
    blankSlate: true,
    instructions: true,
    entry: true,
    entryDefault: false,
    rewind: false,
    stateHooks: true,
    modelWatch: true,
    transcriptFacts: false,
    threadSubagents: true,
    nativeAdmin: true,
    agentHubContext: false,
    environmentSelection: false,
    delivery: { idlePaste: true, nextTurn: true, toolResult: true },
  },
  entryApiVersion: 19,
  state: {
    find: (ctx, previous) => {
      const rollout = findCodexRollout(ctx.fs, ctx.pids)
      return rollout ? codexProbe(rollout.pid, rollout, previous, ctx.tail) : null
    },
    findInEntry: ({ entry, readers, tail }, previous) => {
      const rollout = entryCodexRollout(readers.fs, readers.home, readers.scan)
      return rollout ? codexProbe(entry.pid, rollout, previous, readers.tail ?? tail) : null
    },
    observe: (fs, _home, pids) => observeCodex(fs, pids),
    observeInEntry: (readers, entry) => {
      const threadId = entryCodexRollout(readers.fs, readers.home, readers.scan)?.threadId
      return threadId ? { pid: entry.pid, resumeId: threadId, idle: null, blocked: false } : null
    },
  },
  context: { kind: { kind: 'codex-hooks' }, check: codexHooks },
  hooks: {
    provider: 'codex',
    rideAlong: ['UserPromptSubmit', 'PostToolUse'],
    stateReports: ['Notification', 'UserPromptSubmit', 'PermissionRequest', 'Stop'],
    installs: [
      { what: 'coord-inbox and agent-state hooks', path: '~/.codex/hooks.json' },
      { what: 'Aico context delivery', path: '~/.local/bin/aico-hook' },
    ],
  },
  login: {
    signIn: 'codex login --device-auth',
    signOut: { kind: 'command', line: 'codex logout' },
    local: { bin: 'codex', authFile: '.codex/auth.json' },
  },
  models: { events: codexModelEvents },
  sessionFile: null,
  displayName: 'Codex',
}
