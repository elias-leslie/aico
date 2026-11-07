// `--continue-from <session>` (POST /v1/sessions `continueFrom`): a new session in another tool starts with a
// recap of the old one instead of a re-brief: the first request, the tail of its transcript (the tool's own
// file, read through the session history) and the git state of its checkout. Bounded by continue-recap.json.
// The old session is only read: nothing is ended, moved or resumed across tools.

import { execFile } from 'node:child_process'
import RECAP from './continue-recap.json'
import { adapterOf } from './lifecycle/tui/registry'
import type { History } from './sessions/history'
import type { SessionEvent } from './sessions/types'

/** The part of the session history a recap reads. */
export type RecapHistory = Pick<History, 'list' | 'find' | 'events'>

export interface RecapLimits {
  maxBytes: number
  firstPromptChars: number
  messageChars: number
  toolCallChars: number
  tailScanEvents: number
  maxMessages: number
  gitStatusLines: number
  gitLogCommits: number
  gitTimeoutMs: number
}

export const RECAP_LIMITS: RecapLimits = RECAP

/** What a continuation starts from: the recap and where the old session worked. */
export interface Continuation {
  prompt: string
  projectId: string | null
  projectRoot: string | null
  name: string | null
}

/** A refusal the create route shows as a 4xx. */
export class ContinuationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}

const cut = (text: string, max: number): string => {
  const flat = text.replace(/\s+\n/g, '\n').trim()
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
}

const toolName = (slug: string): string => adapterOf(slug)?.displayName ?? slug

function git(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/git',
      ['-C', cwd, ...args],
      { timeout: timeoutMs, maxBuffer: 1 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout) => resolve(error ? null : stdout.trim()),
    )
  })
}

/** The checkout's state in a few lines: branch and changed files, then recent commits. */
export async function gitRecap(cwd: string, limits: RecapLimits = RECAP_LIMITS): Promise<string> {
  const [status, log] = await Promise.all([
    git(cwd, ['status', '--short', '--branch'], limits.gitTimeoutMs),
    git(cwd, ['log', '--oneline', `-n${limits.gitLogCommits}`], limits.gitTimeoutMs),
  ])
  if (status === null && log === null) return 'Git state: not readable (not a repository).'
  const lines = (status ?? '').split('\n').filter(Boolean)
  const shown = lines.slice(0, limits.gitStatusLines)
  const more = lines.length - shown.length
  return [
    `git status (${cwd}):`,
    ...(shown.length ? shown : ['(clean)']),
    ...(more > 0 ? [`… and ${more} more changed files`] : []),
    ...(log ? ['Recent commits:', log] : []),
  ].join('\n')
}

/** One line per event worth telling: what each side said, and what was run. */
function eventLine(event: SessionEvent, limits: RecapLimits): string | null {
  if (event.kind === 'text' && event.role === 'user')
    return `Owner: ${cut(event.text, limits.messageChars)}`
  if (event.kind === 'text' && event.role === 'assistant')
    return `Agent: ${cut(event.text, limits.messageChars)}`
  if (event.kind === 'tool_call')
    return `Agent ran ${event.tool ?? 'a tool'}: ${cut(event.text, limits.toolCallChars)}`
  return null
}

/** The transcript's first request and its last messages, newest kept when the budget runs out. */
function transcriptRecap(
  history: RecapHistory | undefined,
  sessionId: string,
  limits: RecapLimits,
): { first: string | null; lines: string[]; note: string | null } {
  if (!history) return { first: null, lines: [], note: 'No transcript is available on this host.' }
  const owned = history.list({ session: sessionId, limit: 1 })[0]
  const row = owned ? history.find(owned.id) : undefined
  if (!row || row === 'ambiguous')
    return { first: null, lines: [], note: 'Its transcript could not be found.' }
  const head = history.events(row, { from: 0, limit: limits.tailScanEvents })
  const end = history.events(row, { limit: limits.tailScanEvents })
  if (head === 'gone' || end === 'gone')
    return { first: null, lines: [], note: 'Its transcript could not be read.' }
  const first = head.items.find((event) => event.role === 'user' && event.kind === 'text')
  const lines = end.items
    .map((event) => eventLine(event, limits))
    .filter((line): line is string => !!line)
  return {
    first: first ? cut(first.text, limits.firstPromptChars) : null,
    lines: lines.slice(-limits.maxMessages),
    note: null,
  }
}

/** The old session as the catalog has it. */
export interface RecapSource {
  tool: string
  name: string | null
  projectId: string | null
  projectRoot: string | null
}

export interface ContinueInput {
  history: RecapHistory | undefined
  /** The old session's id. */
  from: string
  source: RecapSource | undefined
  /** The slug of the tool the new session runs. */
  tool: string
}

/** The recap and placement for a session that continues `from`, or a ContinuationError. */
export async function continuation(
  input: ContinueInput,
  limits: RecapLimits = RECAP_LIMITS,
): Promise<Continuation> {
  const { source } = input
  if (!source) throw new ContinuationError(404, 'unknown_session')
  const cwd = source.projectRoot
  if (!cwd) throw new ContinuationError(400, 'continue_needs_project')
  const gitText = await gitRecap(cwd, limits)
  const head = [
    `You are picking up work from an earlier ${toolName(source.tool)} session${source.name ? ` ("${source.name}")` : ''} in ${cwd}. It stopped (usage used up or ended); you are ${toolName(input.tool)}. The files and git are as it left them. Check the git state below before editing; other agents may share this checkout.`,
  ]
  const tailEnd = [
    gitText,
    'Carry on from the last message. If the next step is unclear, ask the owner with tether ask create (one line that stands alone, options, a recommendation).',
  ].join('\n\n')
  const parts = transcriptRecap(input.history, input.from, limits)
  // What the fixed parts leave (headings and joins counted generously), spent on the newest messages first.
  const fixed =
    Buffer.byteLength([...head, parts.first ?? '', parts.note ?? '', tailEnd].join('\n\n')) + 120
  const tail: string[] = []
  let used = 0
  for (const line of [...parts.lines].reverse()) {
    used += Buffer.byteLength(line) + 1
    if (fixed + used > limits.maxBytes) break
    tail.unshift(line)
  }
  const body = [
    ...head,
    ...(parts.first ? [`First request:\n${parts.first}`] : []),
    ...(tail.length ? [`Last messages, oldest first:\n${tail.join('\n')}`] : []),
    ...(parts.note ? [parts.note] : []),
    tailEnd,
  ]
  let prompt = body.join('\n\n')
  // Whatever slipped past the budget (a long status) is cut at the end, never the middle of the tail.
  if (Buffer.byteLength(prompt) > limits.maxBytes)
    prompt = `${Buffer.from(prompt)
      .subarray(0, limits.maxBytes - 4)
      .toString('utf8')
      .replace(/�$/, '')}…`
  return {
    prompt,
    projectId: source.projectId,
    projectRoot: cwd,
    name: source.name ? cut(`Continues ${source.name}`, 80) : null,
  }
}
