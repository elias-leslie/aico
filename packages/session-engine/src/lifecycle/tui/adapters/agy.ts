// Antigravity (agy). It keeps its conversation in a SQLite database
// (~/.gemini/antigravity-cli/conversations/<id>.db) and a presence lock; state
// is read from the steps' status and the executor runs. A root resumes with
// `--conversation <id>`, the id read from the conversation the process holds
// open; the launch prompt goes in with `-i` (agy takes no positional prompt).
// Aico's limits and rules reach it through agy's own hooks (`aico-hook agy`,
// installed in ~/.gemini/config/hooks.json), which report nothing to Tether, and
// it has no transcript Tether follows: capabilities set to false below. Tether
// delivers to it by the gated paste.

import { DatabaseSync } from 'node:sqlite'
import type { AgentSignal } from '../../../agent-signal'
import { type ProcFs, UUID_RE } from '../../../proc-fs'
import type { ContextStatus } from '../spec'
import type { AgentProbe, TuiAdapter } from './contract'

// --- Antigravity (agy) ----------------------------------------------------------

/** agy's CortexStepStatus for a step waiting on the user (its ask_question
 * tool); enum numbers from agy 1.4.9's embedded proto descriptor, checked live.
 * PENDING 1, RUNNING 2, GENERATING 8, QUEUED 11 are going; DONE 3, CANCELED 6,
 * ERROR 7, INTERRUPTED 12 are over. Whether a turn is going is read from the
 * executor runs, not these (a step can stay RUNNING after its turn ends). */
const AGY_STEP_WAITING = 9

/** What one look at an agy conversation database finds. */
export interface AgySnapshot {
  /** The newest step's index; null before any step. */
  maxIdx: number | null
  /** Steps waiting on the user (status WAITING). */
  open: { idx: number; status: number; metadata: Uint8Array | null }[]
  /** The newest step's metadata (CortexStepMetadata). */
  lastMetadata: Uint8Array | null
  /** The newest executor run's `last_step_idx` (ExecutorMetadata field 3):
   * agy writes the row when the run ends, so it covering the newest step means
   * the turn is over. Null with no run yet. */
  executorLastStep: number | null
}

export type AgyRead = (path: string) => AgySnapshot

const AGY_CONVERSATION_RE =
  /\/\.gemini\/antigravity-cli\/(?:presence|conversations)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.(?:lock|db)$/

/** The agy process in the pane and the conversation it holds: agy keeps
 * `presence/<id>.lock` (and, while it writes, `conversations/<id>.db`) open.
 * `conversationId` is null before the first prompt, when agy has none yet. */
export function findAgyConversation(
  fs: ProcFs,
  home: string,
  pids: number[],
): { pid: number; conversationId: string | null; path: string | null } | null {
  let fresh: { pid: number; conversationId: null; path: null } | null = null
  for (const pid of pids) {
    let comm: string
    try {
      comm = fs.readFile(`/proc/${pid}/comm`).trim()
    } catch {
      continue
    }
    if (comm !== 'agy') continue
    let fds: string[]
    try {
      fds = fs.readdir(`/proc/${pid}/fd`)
    } catch {
      continue
    }
    // agy holds presence/<id>.lock for the conversation it is in; the .db only
    // while it writes. Prefer the lock, the newest-opened (highest fd) one.
    let lock: { fd: number; id: string } | null = null
    let db: { fd: number; id: string } | null = null
    for (const fd of fds) {
      let target: string
      try {
        target = fs.readlink(`/proc/${pid}/fd/${fd}`)
      } catch {
        continue
      }
      const match = AGY_CONVERSATION_RE.exec(target)
      if (!match?.[1] || !target.startsWith(`${home}/`)) continue
      const seen = { fd: Number(fd), id: match[1] }
      if (target.endsWith('.lock')) {
        if (!lock || seen.fd > lock.fd) lock = seen
      } else if (!db || seen.fd > db.fd) db = seen
    }
    const conversationId = (lock ?? db)?.id
    if (conversationId)
      return {
        pid,
        conversationId,
        path: `${home}/.gemini/antigravity-cli/conversations/${conversationId}.db`,
      }
    fresh ??= { pid, conversationId: null, path: null }
  }
  return fresh
}

function varint(bytes: Uint8Array, start: number): [number, number] | null {
  let value = 0
  let scale = 1
  for (let index = start; index < bytes.length && index < start + 10; index += 1) {
    const byte = bytes[index] as number
    value += (byte & 0x7f) * scale
    if (byte < 0x80) return [value, index + 1]
    scale *= 128
  }
  return null
}

/** The top-level fields of a protobuf message: varints as numbers,
 * length-delimited fields as bytes. Fixed-width fields are skipped. */
function protoFields(bytes: Uint8Array): Map<number, number | Uint8Array> {
  const out = new Map<number, number | Uint8Array>()
  let index = 0
  while (index < bytes.length) {
    const key = varint(bytes, index)
    if (!key) break
    const [tag, next] = key
    const field = Math.floor(tag / 8)
    const wire = tag % 8
    index = next
    if (wire === 0) {
      const value = varint(bytes, index)
      if (!value) break
      out.set(field, value[0])
      index = value[1]
    } else if (wire === 2) {
      const length = varint(bytes, index)
      if (!length || length[1] + length[0] > bytes.length) break
      out.set(field, bytes.subarray(length[1], length[1] + length[0]))
      index = length[1] + length[0]
    } else if (wire === 1) index += 8
    else if (wire === 5) index += 4
    else break
  }
  return out
}

/** A google.protobuf.Timestamp field of a step's metadata, in ms. */
function agyTime(metadata: Uint8Array | null, field: number): number | null {
  if (!metadata) return null
  const stamp = protoFields(metadata).get(field)
  if (!(stamp instanceof Uint8Array)) return null
  const parts = protoFields(stamp)
  const seconds = parts.get(1)
  if (typeof seconds !== 'number' || seconds <= 0) return null
  const nanos = parts.get(2)
  return seconds * 1000 + Math.floor((typeof nanos === 'number' ? nanos : 0) / 1e6)
}

/** CortexStepMetadata: created_at 1, completed_at 8. */
const AGY_CREATED_AT = 1
const AGY_COMPLETED_AT = 8

/** agy's state from its conversation. agy writes an executor run row when a
 * turn ends; a run covering the newest step means the turn is over and agy is
 * idle, even with an older step left RUNNING (a background command, or a row
 * an interrupted turn abandoned). A step waiting on the user (its ask_question
 * tool) that is the newest or after the last run is blocked; a newest step no
 * run covers yet is working (a step going, or the model thinking between
 * steps). A conversation with no steps is agy fresh at its input. Tether runs
 * agy with --dangerously-skip-permissions, so it never waits on a permission
 * prompt. */
export function agySignal(snapshot: AgySnapshot, conversationId: string): AgentSignal {
  const base = { source: 'agy-conversation', agentSessionId: conversationId }
  if (snapshot.maxIdx === null) return { ...base, state: 'idle', detail: null, at: null }
  const covered = snapshot.executorLastStep ?? -1
  const waiting = snapshot.open.find(
    (step) =>
      step.status === AGY_STEP_WAITING && (step.idx > covered || step.idx === snapshot.maxIdx),
  )
  if (waiting)
    return {
      ...base,
      state: 'blocked',
      detail: 'input needed',
      at: agyTime(waiting.metadata, AGY_CREATED_AT),
    }
  if (covered < snapshot.maxIdx)
    return {
      ...base,
      state: 'working',
      detail: null,
      at: agyTime(snapshot.lastMetadata, AGY_CREATED_AT),
    }
  return {
    ...base,
    state: 'idle',
    detail: null,
    at:
      agyTime(snapshot.lastMetadata, AGY_COMPLETED_AT) ??
      agyTime(snapshot.lastMetadata, AGY_CREATED_AT),
  }
}

/** The newest `limit` steps of an agy conversation database (newest first), for the doing-now line. */
export function agyRecentSteps(
  path: string,
  limit: number,
): { step_type: number; step_payload: Uint8Array | null }[] {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 50 })
  try {
    return db
      .prepare('SELECT step_type, step_payload FROM steps ORDER BY idx DESC LIMIT ?')
      .all(limit) as { step_type: number; step_payload: Uint8Array | null }[]
  } finally {
    db.close()
  }
}

/** Reads an agy conversation database, read-only, one short connection per
 * look (agy writes it in WAL mode; nothing is held open between polls). */
export const nodeAgyRead: AgyRead = (path) => {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 50 })
  try {
    // One read transaction: the four looks see the same snapshot.
    db.exec('BEGIN')
    const top = db.prepare('SELECT max(idx) AS idx FROM steps').get() as { idx: number | null }
    const maxIdx = typeof top?.idx === 'number' ? top.idx : null
    const open = db
      .prepare(
        `SELECT idx, status, metadata FROM steps WHERE status = ${AGY_STEP_WAITING} ORDER BY idx`,
      )
      .all() as { idx: number; status: number; metadata: Uint8Array | null }[]
    const last =
      maxIdx === null
        ? null
        : (db.prepare('SELECT metadata FROM steps WHERE idx = ?').get(maxIdx) as
            | { metadata: Uint8Array | null }
            | undefined)
    const run = db.prepare('SELECT data FROM executor_metadata ORDER BY idx DESC LIMIT 1').get() as
      | { data: Uint8Array | null }
      | undefined
    const lastStep = run?.data ? protoFields(run.data).get(3) : undefined
    db.exec('COMMIT')
    return {
      maxIdx,
      open,
      lastMetadata: last?.metadata ?? null,
      // An executor that ended at step 0 encodes no field 3 (proto3 default).
      executorLastStep: run?.data ? (typeof lastStep === 'number' ? lastStep : 0) : null,
    }
  } finally {
    db.close()
  }
}

/** agy before its first prompt: at its input, with no conversation yet. No
 * time of its own, so it never reads as a finished turn. */
const AGY_FRESH: AgentSignal = {
  state: 'idle',
  source: 'agy-conversation',
  detail: null,
  at: null,
  agentSessionId: null,
}

/** Reader of one agy conversation. */
export class AgyConversation {
  constructor(
    readonly path: string,
    readonly conversationId: string,
    private readonly read: AgyRead = nodeAgyRead,
  ) {}

  poll(): AgentSignal | null {
    try {
      return agySignal(this.read(this.path), this.conversationId)
    } catch (error) {
      // agy holds the conversation's lock before it writes the database or its
      // tables: that is agy fresh at its input, not unknown.
      const message = error instanceof Error ? error.message : ''
      if (/unable to open database|no such table/i.test(message))
        return { ...AGY_FRESH, agentSessionId: this.conversationId }
      return null
    }
  }
}

// --- context ---------------------------------------------------------------------

/** Aico delivers agy's context at launch (delivery.ts, a file its session-start
 * hook hands over); a launch that got none has none, and the native agent continues. */
function agyContext(): Promise<ContextStatus> {
  return Promise.resolve({
    state: 'missing',
    detail:
      'Aico delivered no context at this launch (aico context delivery agy on turns it on); native agent continues',
  })
}

// --- the adapter -----------------------------------------------------------------

/** agy's process and its conversation (null before its first prompt). */
class AgyProbe implements AgentProbe {
  constructor(
    readonly pid: number,
    readonly conversation: AgyConversation | null,
    private readonly read?: AgyRead,
  ) {}

  poll(): AgentSignal | null {
    return this.conversation ? this.conversation.poll() : AGY_FRESH
  }

  /** agy opens a conversation on its first prompt and can switch to another:
   * its own fds are cheap to look at, so look every poll. */
  follow(ctx: { fs: ProcFs; home: string }): AgentProbe {
    return agyProbe(ctx.fs, ctx.home, [this.pid], this, this.read) ?? this
  }
}

function agyProbe(
  fs: ProcFs,
  home: string,
  pids: number[],
  previous: AgentProbe | null,
  read: AgyRead | undefined,
): AgyProbe | null {
  const found = findAgyConversation(fs, home, pids)
  if (!found) return null
  if (previous instanceof AgyProbe && (previous.conversation?.path ?? null) === found.path)
    return previous.pid === found.pid
      ? previous
      : new AgyProbe(found.pid, previous.conversation, read)
  return new AgyProbe(
    found.pid,
    found.path && found.conversationId
      ? new AgyConversation(found.path, found.conversationId, read)
      : null,
    read,
  )
}

export const agy: TuiAdapter = {
  id: 'agy',
  harness: 'agy',
  seed: {
    slug: 'agy',
    name: 'Antigravity',
    argv: ['agy', '--dangerously-skip-permissions'],
    processName: 'agy',
    description: 'Google Antigravity terminal coding agent',
    color: '#3186FF',
    displayOrder: 2,
    isDefault: false,
    enabled: true,
    aliases: [],
    // The stored context_hook value (schema.ts CONTEXT_HOOKS) keeps its old name;
    // it only picks this adapter. The context is Aico's launch delivery below.
    contextHook: 'canonical-retrieval:antigravity',
  },
  launch: { ensureArgs: [] },
  // Not --add-dir: agy sorts its folders and works in the first, so a delivery folder
  // under /home took the place of a project under /srv (seen live, agy 1.5.3).
  spec: {
    resume: {
      sessionIdPattern: UUID_RE,
      arguments: ['--conversation'],
      promptArguments: ['-i'],
    },
    // No hook, no limits (agy runs a tool when its hook is missing), so such a session
    // loses the skip-permissions flag and asks before it does anything.
    contextDelivery: {
      kind: 'hook',
      file: 'AGENTS.md',
      hooks: '.gemini/config/hooks.json',
      marker: 'aico-hook agy PreToolUse',
      needsHook: ['--dangerously-skip-permissions'],
    },
    modelSelection: { model: ['--model'], reasoningEffort: { arguments: ['--effort'] } },
  },
  capabilities: {
    root: true,
    blankSlate: false,
    instructions: false,
    entry: false,
    entryDefault: false,
    rewind: false,
    stateHooks: false,
    modelWatch: false,
    transcriptFacts: false,
    threadSubagents: false,
    nativeAdmin: false,
    environmentSelection: false,
    statusLine: false,
    delivery: { idlePaste: true, nextTurn: false, toolResult: false },
  },
  entryApiVersion: null,
  state: {
    find: (ctx, previous) =>
      agyProbe(ctx.fs, ctx.home, ctx.pids, previous, ctx.seams?.agy as AgyRead | undefined),
    // Resumable once agy has opened its conversation (it holds the lock from the first prompt).
    observe: (fs, home, pids) => {
      const found = findAgyConversation(fs, home, pids)
      return found?.conversationId
        ? { pid: found.pid, resumeId: found.conversationId, idle: null, blocked: false }
        : null
    },
  },
  context: {
    kind: { kind: 'agy-agents-md' },
    check: agyContext,
  },
  hooks: {
    provider: null,
    rideAlong: [],
    stateReports: [],
    installs: [
      { what: 'Aico limits, rules and coordination', path: '~/.gemini/config/hooks.json' },
    ],
  },
  login: {
    signIn: "echo 'agy asks you to sign in when it starts.'; agy",
    signOut: { kind: 'session', line: "echo 'In agy, type /logout.'; agy" },
    local: { bin: 'agy', authFile: '.gemini/antigravity-cli/antigravity-oauth-token' },
    signInLink: { host: 'accounts.google.com' },
  },
  models: null,
  sessionFile: null,
  displayName: 'Antigravity',
}
