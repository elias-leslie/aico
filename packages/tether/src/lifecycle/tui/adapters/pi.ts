// Pi. Tether starts Pi under a conversation id it picks (`--session-id`,
// TETHER_AGENT_SESSION_ID), so Pi's session file
// (~/.pi/agent/sessions/--<cwd>--/<time>_<id>.jsonl) is found by that id. State
// is the last message in it; the model watch reads the same file.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentSignal } from '../../../agent-state'
import { ENTRY_SCAN_DEFAULTS, type EntryScanConfig } from '../../../config'
import { type ModelEvent, model, parse, time } from '../../../model-record'
import {
  type FileTail,
  nodeFileTail,
  observeChosenSession,
  type ProcFs,
  UUID_RE,
} from '../../../proc-fs'
import { agentHubRepo, unknownCheckout } from '../context-support'
import type { ContextStatus } from '../spec'
import type { AgentProbe, TuiAdapter } from './contract'

const PI_MAX_STEP_BYTES = 4 * 1024 * 1024

// --- Pi ---------------------------------------------------------------------

/** Assistant stop reasons that end Pi's turn (pi-ai StopReason; pi-agent-core's
 * loop ends on these unless the reply holds tool calls). `toolUse`, and the
 * `pending` / `deferred` of a reply still being fetched, run on. */
const PI_TURN_ENDS = new Set(['stop', 'length', 'error', 'aborted'])
/** First read of an existing session file: the state is its last message. */
const PI_TAIL_BYTES = 512 * 1024

/** Pi's session file for the conversation Tether chose at launch
 * (TETHER_AGENT_SESSION_ID, `pi --session-id`): <home>/.pi/agent/sessions/
 * --<cwd>--/<time>_<id>.jsonl. `path` is null until Pi writes it, after the
 * first prompt. A `/new` inside Pi starts a file under another ID, which is
 * not followed. */
export function findPiSession(
  fs: ProcFs,
  home: string,
  pids: number[],
): { pid: number; sessionId: string; path: string | null } | null {
  const chosen = observeChosenSession(fs, pids)
  if (!chosen) return null
  return {
    pid: chosen.pid,
    sessionId: chosen.resumeId,
    path: piSessionFile(fs, home, chosen.resumeId),
  }
}

/** Incremental reader of one Pi session file. Pi appends each message when it
 * completes: a user prompt or tool result means the turn goes on (a long model
 * call writes nothing until it ends), an assistant reply that ends the turn
 * means idle. Pi asks the user nothing structured (Tether runs it with
 * --approve), so it is never blocked. */
export class PiSession {
  private offset = 0
  private started = false
  private working: boolean | null = null
  private at: number | null = null

  constructor(
    readonly path: string,
    readonly sessionId: string,
    readonly tail: FileTail = nodeFileTail,
  ) {}

  apply(line: string): void {
    let item: {
      type?: string
      timestamp?: string
      message?: { role?: string; stopReason?: string; content?: unknown }
    }
    try {
      item = JSON.parse(line)
    } catch {
      return
    }
    if (item?.type !== 'message' || !item.message) return
    const { role, stopReason, content } = item.message
    let working: boolean
    if (role === 'user' || role === 'toolResult') working = true
    else if (role === 'assistant' && typeof stopReason === 'string') {
      // A reply cut off by the token limit still fails its tool calls and runs on.
      const calls =
        Array.isArray(content) &&
        content.some((part) => (part as { type?: unknown })?.type === 'toolCall')
      working = !PI_TURN_ENDS.has(stopReason) || (stopReason === 'length' && calls)
    } else return
    this.working = working
    const at = item.timestamp ? Date.parse(item.timestamp) : Number.NaN
    if (Number.isFinite(at)) this.at = at
  }

  poll(): AgentSignal | null {
    try {
      if (!this.started) {
        const probe = this.tail.read(this.path, 0, PI_TAIL_BYTES)
        const lines = probe.text.split('\n')
        // A tail that starts mid-file begins with a partial line.
        if (probe.offset - Buffer.byteLength(probe.text) > 0) lines.shift()
        for (const line of lines) if (line) this.apply(line)
        this.offset = probe.offset
        this.started = true
      } else {
        const chunk = this.tail.read(this.path, this.offset, PI_MAX_STEP_BYTES)
        this.offset = chunk.offset
        for (const line of chunk.text.split('\n')) if (line) this.apply(line)
      }
    } catch {
      return null
    }
    if (this.working === null) return null
    return {
      state: this.working ? 'working' : 'idle',
      source: 'pi-session',
      detail: null,
      at: this.at,
      agentSessionId: this.sessionId,
    }
  }
}

/** Pi's session file for conversation `id` under `home`:
 * `.pi/agent/sessions/--<cwd>--/<time>_<id>.jsonl`, matched by its exact
 * suffix (Pi names the file after the id `--session-id` gave it). null until
 * Pi writes it (after its first prompt). At most `limit` cwd directories are
 * looked in. */
export function piSessionFile(
  fs: ProcFs,
  home: string,
  id: string,
  limit = Number.POSITIVE_INFINITY,
): string | null {
  if (!UUID_RE.test(id)) return null
  const root = `${home}/.pi/agent/sessions`
  const suffix = `_${id}.jsonl`
  let dirs: string[]
  try {
    dirs = fs.readdir(root)
  } catch {
    return null
  }
  for (const dir of dirs.slice(0, limit)) {
    if (dir.startsWith('.') || dir.includes('/')) continue
    let names: string[]
    try {
      names = fs.readdir(`${root}/${dir}`)
    } catch {
      continue
    }
    const name = names.find((entry) => entry.endsWith(suffix) && !entry.includes('/'))
    if (!name) continue
    const path = `${root}/${dir}/${name}`
    // An entry home's readers open it to time it: a link or anything that is
    // not a regular file inside the home has no time and is not this session.
    if (fs.mtimeMs && fs.mtimeMs(path) === null) continue
    return path
  }
  return null
}

/** An entry session's Pi conversation: the id Tether chose for this launch
 * (never one found by scanning) and its session file in the entry home. */
export function entryPiSession(
  fs: ProcFs,
  home: string,
  chosenId: string | null,
  scan: EntryScanConfig = ENTRY_SCAN_DEFAULTS,
): { sessionId: string; path: string | null } | null {
  if (!chosenId) return null
  return { sessionId: chosenId, path: piSessionFile(fs, home, chosenId, scan.rolloutScan) }
}

// --- model watch ------------------------------------------------------------

/** One Pi session line: an assistant message names the model asked for
 * (`provider/model`) and, when the provider says, the one that answered. */
export function piModelEvents(line: string): ModelEvent[] {
  if (!line.includes('"assistant"')) return []
  const row = parse(line)
  const message = row?.message as Record<string, unknown> | undefined
  if (row?.type !== 'message' || message?.role !== 'assistant') return []
  const at = time(row.timestamp)
  const asked = model(message.model)
  if (!asked) return []
  const provider = typeof message.provider === 'string' ? message.provider : null
  const full = (id: string) => (provider && !id.includes('/') ? `${provider}/${id}` : id)
  const served = model(message.responseModel) ?? asked
  return [
    { type: 'requested', model: full(asked), at },
    { type: 'served', model: full(served), at },
  ]
}

// --- context ---------------------------------------------------------------------

/** SummitFlow's deployed Pi coordination extension: `$ST_PI_COORD_EXTENSION`,
 * else the current SummitFlow release under ~/.summitflow. */
function stCoordSource(): string {
  return (
    process.env.ST_PI_COORD_EXTENSION ||
    join(
      homedir(),
      '.summitflow/services/projects/summitflow/current/source/scripts/lib/pi-coord-extension.ts',
    )
  )
}

/** Null when ~/.pi/agent/extensions/st-coord.ts resolves to SummitFlow's
 * current extension, else what drifted. Installing it is SummitFlow's job. */
function stCoordDrift(): string | null {
  const link = join(homedir(), '.pi', 'agent', 'extensions', 'st-coord.ts')
  try {
    return realpathSync(link) === realpathSync(stCoordSource())
      ? null
      : `${link} does not resolve to SummitFlow's current ${stCoordSource()}`
  } catch {
    return `${link} or ${stCoordSource()} is missing`
  }
}

/** Pi loads source-controlled extensions from ~/.pi/agent/extensions. Verify
 * that the active entry resolves to Agent Hub's canonical adapter source and
 * that the adapter preserves Pi's native system prompt before appending the
 * delivered contract, and that SummitFlow's coordination extension has not
 * drifted from its current release. */
function piExtension(): ContextStatus {
  const extension = join(homedir(), '.pi', 'agent', 'extensions', 'agent-hub.ts')
  const repo = agentHubRepo()
  if (!repo) return unknownCheckout('AGENT_HUB_REPO', 'agent-hub')
  const expected = join(repo, 'integrations', 'context-delivery', 'pi', 'agent-hub.ts')
  if (!existsSync(extension)) {
    return {
      state: 'missing',
      detail: `${extension} absent — canonical context installation is incomplete`,
    }
  }
  try {
    const body = readFileSync(extension, 'utf8')
    const canonical = realpathSync(extension) === expected
    const additive =
      body.includes('pi.on("input"') &&
      body.includes('action: "continue"') &&
      body.includes('before_agent_start') &&
      body.includes('event.systemPrompt') &&
      body.includes('contract.rendered') &&
      body.includes('AH: DEGRADED')
    if (!canonical || !additive) {
      return {
        state: 'missing',
        detail: `${extension} is drifted or does not preserve Pi's native system prompt`,
      }
    }
    const drift = stCoordDrift()
    return drift
      ? { state: 'missing', detail: `${drift}; native Pi continues` }
      : {
          state: 'available',
          detail: `${extension}: canonical additive Agent Hub extension installed and st-coord.ts current; model receipt is unverified`,
        }
  } catch {
    return { state: 'missing', detail: `${extension} is unreadable — cannot verify context` }
  }
}

// --- the adapter -----------------------------------------------------------------

/** Pi's process and the session file Tether chose for it, kept (with its offset) while it is the same. */
class PiProbe implements AgentProbe {
  constructor(
    readonly pid: number,
    readonly sessionId: string,
    readonly session: PiSession | null,
  ) {}

  poll(): AgentSignal | null {
    return this.session?.poll() ?? null
  }

  models() {
    return this.session
      ? { tool: 'pi', agent: this.pid, path: this.session.path, tail: this.session.tail }
      : null
  }
}

function piProbe(
  pid: number,
  pi: { sessionId: string; path: string | null },
  previous: AgentProbe | null,
  tail: FileTail | undefined,
): PiProbe {
  if (
    previous instanceof PiProbe &&
    previous.sessionId === pi.sessionId &&
    (previous.session?.path ?? null) === pi.path
  )
    return new PiProbe(pid, previous.sessionId, previous.session)
  return new PiProbe(pid, pi.sessionId, pi.path ? new PiSession(pi.path, pi.sessionId, tail) : null)
}

export const pi: TuiAdapter = {
  id: 'pi',
  harness: 'pi',
  executor: 'pi',
  seed: {
    slug: 'pi',
    name: 'Pi',
    // `--approve` removes Pi's project-trust prompt in this operator-owned workspace.
    argv: ['pi', '--approve'],
    processName: 'pi',
    description: 'Pi coding agent',
    color: '#C16A8A',
    displayOrder: 3,
    isDefault: false,
    enabled: true,
    aliases: [],
    contextHook: 'pi-extension',
  },
  launch: { ensureArgs: ['--approve'] },
  spec: {
    resume: {
      sessionIdPattern: UUID_RE,
      arguments: ['--session'],
      freshArguments: ['--session-id'],
    },
    instructions: { arguments: ['--append-system-prompt'] },
    inputLine: 'ruled',
    modelSelection: {
      model: ['--model'],
      modelProvider: ['--provider'],
      reasoningEffort: { arguments: ['--thinking'] },
      listModels: ['--list-models'],
      daybreak: { environment: true, model: 'openai/gpt-6-sol' },
    },
  },
  capabilities: {
    root: true,
    blankSlate: true,
    instructions: true,
    entry: true,
    entryDefault: false,
    rewind: false,
    stateHooks: false,
    modelWatch: true,
    transcriptFacts: false,
    threadSubagents: false,
    nativeAdmin: false,
    agentHubContext: true,
    environmentSelection: true,
    delivery: { idlePaste: true, nextTurn: true, toolResult: true },
  },
  entryApiVersion: 20,
  state: {
    find: (ctx, previous) => {
      const found = findPiSession(ctx.fs, ctx.home, ctx.pids)
      return found ? piProbe(found.pid, found, previous, ctx.tail) : null
    },
    findInEntry: ({ entry, readers, tail }, previous) => {
      // Only the conversation this launch was given, read through the home's contained tail.
      const found = entryPiSession(readers.fs, readers.home, entry.chosenId, readers.scan)
      return found ? piProbe(entry.pid, found, previous, readers.tail ?? tail) : null
    },
    observe: (fs, _home, pids) => observeChosenSession(fs, pids),
    observeInEntry: (readers, entry) => {
      // Resumable once Pi has written the conversation (as Codex's rollout).
      const found = entryPiSession(readers.fs, readers.home, entry.chosenId, readers.scan)
      return found?.path
        ? { pid: entry.pid, resumeId: found.sessionId, idle: null, blocked: false }
        : null
    },
  },
  context: {
    kind: { kind: 'pi-extension' },
    check: async () => piExtension(),
    retire: (ownershipId) =>
      new Promise((resolve) => {
        execFile(
          join(homedir(), '.local', 'bin', 'agent-hub-context-client'),
          ['retire-pi', '--surface', 'pi', '--aico-session', ownershipId],
          { timeout: 20000 },
          (error) => resolve(!error),
        )
      }),
  },
  hooks: {
    provider: 'pi',
    rideAlong: ['UserPromptSubmit', 'PostToolUse'],
    stateReports: [],
    installs: [
      { what: 'aico-due extension (ride-along lines)', path: 'integrations/pi/aico-due.ts' },
      { what: 'Agent Hub context extension', path: '~/.pi/agent/extensions/agent-hub.ts' },
      { what: 'SummitFlow coordination extension', path: '~/.pi/agent/extensions/st-coord.ts' },
    ],
  },
  login: {
    signIn: "echo 'In pi, type /login and pick a provider.'; pi",
    signOut: { kind: 'session', line: "echo 'In pi, type /logout.'; pi" },
    local: { bin: 'pi', authFile: '.pi/agent/auth.json' },
  },
  models: { events: piModelEvents },
  sessionFile: piSessionFile,
  displayName: 'Pi',
}
