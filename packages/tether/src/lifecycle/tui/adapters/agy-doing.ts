// What an agy conversation is doing right now, one line, from its database
// (~/.gemini/antigravity-cli/conversations/<id>.db). agy writes each tool call as a step
// whose payload carries the tool's name and its arguments as JSON, among them `toolAction`
// ("Running st ready"): a present-tense line agy itself wrote for the call. No model call;
// the database is opened read-only, and only again when it (or its WAL) changed.

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { maskKnownSecrets } from '@aico/shared/secrets'
import { agyRecentSteps } from './agy'

/** agy's step types: the owner's input; a tool call (written as 15 while it is planned, 132 once run). */
const STEP_USER_INPUT = 14
const STEP_TOOL_CALLS: ReadonlySet<number> = new Set([15, 132])
/** How many of the newest steps are looked at for a tool call. */
const LOOK_BACK = 8
const MAX = 120

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
const cut = (text: string): string => (text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text)

/** The JSON object that starts at `from` in `text` (strings and escapes respected), or undefined. */
function objectAt(text: string, from: number): Record<string, unknown> | undefined {
  let depth = 0
  let inString = false
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (char === '\\') index += 1
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(from, index + 1))
          return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** The line for one tool-call step payload, or null when it holds no tool call. */
export function toolCallDoing(payload: Uint8Array): string | null {
  const text = Buffer.from(payload).toString('utf8')
  const call = /call_[A-Za-z0-9_-]+/.exec(text)
  if (!call) return null
  const rest = text.slice(call.index + call[0].length)
  const name = /[a-z][a-z_]{2,40}/.exec(rest)
  const open = rest.indexOf('{')
  if (!name || open < 0) return null
  const args = objectAt(rest, open)
  const said =
    (typeof args?.toolAction === 'string' && args.toolAction) ||
    (typeof args?.toolSummary === 'string' && args.toolSummary) ||
    `Using ${name[0]}`
  return cut(maskKnownSecrets(flat(said)))
}

/** The line for a database's newest steps (newest first): the latest tool call, unless the owner
 * spoke after it (a turn that has not reached its first tool yet). */
export function stepsDoing(
  steps: { step_type: number; step_payload: Uint8Array | null }[],
): string | null {
  for (const step of steps) {
    if (step.step_type === STEP_USER_INPUT) return null
    if (STEP_TOOL_CALLS.has(step.step_type) && step.step_payload) {
      const line = toolCallDoing(step.step_payload)
      if (line) return line
    }
  }
  return null
}

function signature(path: string): string {
  const part = (file: string) => {
    try {
      const stat = statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return '-'
    }
  }
  return `${part(path)}|${part(`${path}-wal`)}`
}

const cache = new Map<string, { signature: string; doing: string | null }>()

/** What the agy conversation is doing, or null (unknown, or no tool call yet). Reads the database only
 * when its file or WAL changed since the last look. */
export function agyDoing(
  conversationId: string | null,
  home: string = homedir(),
  read: typeof agyRecentSteps = agyRecentSteps,
): string | null {
  if (!conversationId || !/^[0-9a-f-]{36}$/.test(conversationId)) return null
  const path = join(home, '.gemini', 'antigravity-cli', 'conversations', `${conversationId}.db`)
  const now = signature(path)
  const known = cache.get(path)
  if (known?.signature === now) return known.doing
  let doing: string | null = null
  try {
    doing = stepsDoing(read(path, LOOK_BACK))
  } catch {
    // agy is mid-write or has no steps yet: say nothing this time, look again next time
    return known?.doing ?? null
  }
  cache.set(path, { signature: now, doing })
  return doing
}
