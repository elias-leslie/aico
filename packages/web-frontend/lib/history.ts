// Recent sessions: how the session history (Tether's /v1/history, through /api/history) reads on screen.

/** The answer shapes below mirror @aico/tether-client's History* contracts; the page only reads them. */
export type HistoryOutcome = 'completed' | 'aborted' | 'error'

export interface HistoryTokens {
  /** The part of the input not served from the cache. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface HistorySession {
  id: string
  tool: 'claude-code' | 'codex' | 'pi'
  parentId: string | null
  project: string | null
  cwd: string | null
  model: string | null
  startedAt: number | null
  endedAt: number | null
  /** null: no final answer yet (a turn is running, or the tool stopped without one). */
  outcome: HistoryOutcome | null
  tokens: HistoryTokens
  toolCalls: number
  filesWritten: number
  /** A smoke or scratch run (the server's rule); Recent leaves it out until asked. */
  test?: boolean
}

export interface HistoryDetail extends HistorySession {
  path: string
  files: { path: string; writes: number }[]
  subagents: { count: number; tokens: HistoryTokens; toolCalls: number }
}

export interface HistoryEvent {
  offset: number
  at: number | null
  role: 'user' | 'assistant' | 'tool' | 'system'
  kind: 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'note'
  text: string
  tool?: string
  model?: string
}

export interface HistoryEventPage {
  items: HistoryEvent[]
  /** Pass as `before` for older events; null: this is the start. */
  older: number | null
  /** Pass as `from` for newer events; null: this is the end. */
  newer: number | null
  size: number
}

export const TOOLS = [
  ['claude-code', 'Claude Code'],
  ['codex', 'Codex'],
  ['pi', 'Pi'],
  ['aico-agent', 'Aico agent'],
] as const

export function toolName(tool: string): string {
  return TOOLS.find(([id]) => id === tool)?.[1] ?? tool
}

/**
 * What a row in Recent or Today is called: the running session's name when one owns the
 * conversation, else the tool and when it started. Never just the project, which would make
 * every row of one project read the same.
 */
export function sessionLabel(
  session: Pick<HistorySession, 'tool' | 'startedAt'>,
  name?: string | null,
): string {
  if (name) return name
  return session.startedAt === null
    ? toolName(session.tool)
    : `${toolName(session.tool)} · ${clock(session.startedAt)}`
}

/** A turn that last wrote this recently is taken to be still running. */
export const WORKING_MS = 2 * 60_000

export type Standing =
  | 'working'
  | 'waiting'
  | 'idle'
  | 'finished'
  | 'stopped'
  | 'failed'
  | 'quiet'

/** The running session that owns this conversation, as `/api/history/live` says. */
export type LiveState = { activity: 'working' | 'idle' | 'blocked' | 'unknown' }

/** Where a session stands. A conversation a running session still owns is
 * Working, Waiting for you or Idle, never Finished: its last turn ending is
 * not the session ending. `quiet`: no final reply and still for a while. */
export function standing(
  session: HistorySession,
  now: number,
  live?: LiveState,
): Standing {
  if (live)
    return live.activity === 'working'
      ? 'working'
      : live.activity === 'blocked'
        ? 'waiting'
        : 'idle'
  if (session.outcome === 'completed') return 'finished'
  if (session.outcome === 'aborted') return 'stopped'
  if (session.outcome === 'error') return 'failed'
  return session.endedAt !== null && now - session.endedAt < WORKING_MS
    ? 'working'
    : 'quiet'
}

export const STANDING_TEXT: Record<Standing, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
  finished: 'Finished',
  stopped: 'Stopped',
  failed: 'Failed',
  quiet: 'No final reply',
}

/** The status chip class each standing wears (status chips are shape and colour). */
export const STANDING_CHIP: Record<Standing, string> = {
  working: 'running',
  waiting: 'warn',
  idle: 'unknown',
  finished: 'ok',
  stopped: 'warn',
  failed: 'failed',
  quiet: 'unknown',
}

export function count(n: number): string {
  if (n < 10_000) return n.toLocaleString('en-US')
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** "12k in · 220k cached · 34k out": the cache read is the cheap part of the input. */
export function tokenLine(tokens: HistoryTokens): string {
  return `${count(tokens.input)} in · ${count(tokens.cacheRead)} cached · ${count(tokens.output)} out`
}

export function countOf(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** "4 min ago", "2 h ago", or the date for older ones. */
export function agoAt(ms: number | null, now: number): string {
  if (ms === null) return '—'
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

export function clock(ms: number | null): string {
  if (ms === null) return '—'
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** The folder's last two parts: enough to tell sessions apart. */
export function shortFolder(cwd: string | null): string {
  if (!cwd) return ''
  return cwd.split('/').filter(Boolean).slice(-2).join('/')
}

export function sessionHref(id: string): string {
  return `/history?session=${encodeURIComponent(id)}`
}

/** What the session said last, one line: markdown links and marks reduced to their words. */
export function plainLine(text: string): string {
  return (
    text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_#>]+/g, '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  )
}
