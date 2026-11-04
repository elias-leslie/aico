// The session history's shared shapes. A reader (readers/*.ts) turns one
// transcript record of one tool into a `Fold` (what the record adds to the
// session's row) and the `SessionEvent`s the transcript view shows.

export type HistoryTool = 'claude-code' | 'codex' | 'pi' | 'aico-agent'
export type Outcome = 'completed' | 'aborted' | 'error'

export interface Usage {
  /** Input tokens that were not served from the cache. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export const NO_USAGE: Usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

/** What one record adds to its session. Absent fields add nothing. */
export interface Fold {
  cwd?: string
  model?: string
  /** Epoch ms of the record, when it has one. */
  at?: number
  /** Tokens this record adds. */
  usage?: Usage
  /** The tool's running total for the whole conversation: replaces the row's. */
  usageTotal?: Usage
  toolCalls?: number
  /** Paths the record wrote. */
  files?: string[]
  /** Where the conversation stands after this record; null: a turn is running. */
  outcome?: Outcome | null
}

export type EventRole = 'user' | 'assistant' | 'tool' | 'system'
export type EventKind = 'text' | 'thinking' | 'tool_call' | 'tool_result' | 'note'

export interface SessionEvent {
  /** Byte offset of the transcript line this came from. */
  offset: number
  at: number | null
  role: EventRole
  kind: EventKind
  text: string
  tool?: string
  model?: string
}

/** One record's reading. `state` is the reader's own memory across records
 * (JSON-serializable: it is saved with the row between runs). */
export interface Reading {
  fold: Fold
  events: Omit<SessionEvent, 'offset'>[]
}

export interface Reader<S = Record<string, unknown>> {
  tool: HistoryTool
  /** Transcript files under one native home (its `.claude`, `.codex`, `.pi`). */
  discover(home: string): TranscriptFile[]
  /** The tool's own id for a transcript path, before any record is read. */
  nativeIdOf(path: string): string
  initialState(): S
  /** True for a line that holds nothing a reader uses (checked before parsing). */
  skip?(line: string): boolean
  /** Reads one parsed JSON line. `events` is false while ingesting (no text built). */
  read(record: Record<string, unknown>, state: S, wantEvents: boolean): Reading
}

export interface TranscriptFile {
  path: string
  /** The conversation this file belongs to (a subagent's transcript). */
  parentNativeId?: string
}

/** The longest text one event carries. */
export const EVENT_TEXT_MAX = 4000

export function clip(text: string, max = EVENT_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

export function obj(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function time(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value))
    return value > 1e12 ? value : value * 1000
  if (typeof value === 'string') {
    const at = Date.parse(value)
    return Number.isNaN(at) ? undefined : at
  }
  return undefined
}
