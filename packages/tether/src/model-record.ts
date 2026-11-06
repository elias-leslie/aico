// What the agents' own records say about models, as plain data. The parsers
// that read each tool's transcript live in its adapter
// (src/lifecycle/tui/adapters); this leaf module has the shared event shape
// and the value checks they all use. model-switch.ts follows the events.

import type { FileTail } from './proc-facts'

/** Where one session's agent keeps its record. `agent` is the agent's pid:
 * another process in the session starts a new follow (its own launch model). */
export interface ModelSource {
  /** The adapter's `harness`. */
  tool: string
  agent: number
  tail?: FileTail
  /** The transcript, when the agent holds one fixed file open. */
  path?: string
  /** The transcript is found by conversation id and can move (a new conversation, a resume). */
  locate?: {
    sessionId: string
    fileName: string
    find(): string | null
    exists(path: string): boolean
  }
}

export type ModelEvent =
  /** The model that answered. */
  | { type: 'served'; model: string; at: number | null }
  /** The model the tool itself asks for (Codex turn context, Pi message). */
  | { type: 'requested'; model: string; at: number | null }
  /** Someone ran the tool's model picker (Claude `/model`). */
  | { type: 'chosen'; at: number | null }
  /** The picker closed without a change (Claude "Kept model as …"). */
  | { type: 'kept'; at: number | null }
  /** An owner's prompt (Claude), the start of a turn a rewind can go back to. */
  | { type: 'prompt'; uuid: string; at: number | null }
  /** A reply was refused (Claude `stop_reason: refusal`); the turn may still
   * go on (a same-model retry, a fallback). */
  | {
      type: 'refused'
      model: string | null
      category: string | null
      key: string
      at: number | null
    }
  /** The tool switched models because a request was refused. */
  | {
      type: 'refusal'
      from: string | null
      to: string
      category: string | null
      key: string
      at: number | null
    }
  /** A refusal ended the turn without a switch. */
  | {
      type: 'noFallback'
      model: string | null
      category: string | null
      key: string
      at: number | null
    }

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/
/** A refused model the record does not name. */
export const UNKNOWN_MODEL = 'unknown'
const CATEGORY = /^[a-z][a-z0-9_]{0,31}$/
export const KEY = /^[A-Za-z0-9_.:@-]{1,128}$/
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function model(value: unknown): string | null {
  return typeof value === 'string' && MODEL_ID.test(value.trim()) ? value.trim() : null
}

export function time(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function keyOf(...values: unknown[]): string | null {
  const found = values.find(
    (value): value is string => typeof value === 'string' && KEY.test(value),
  )
  return found ?? null
}

/** A refusal category as a short lowercase word (`cyber`), else null. */
export function refusalCategory(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const word = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  // Codex reroute reasons.
  if (word.replace(/_/g, '') === 'highriskcyberactivity') return 'cyber'
  return CATEGORY.test(word) ? word : null
}

export function parse(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}
