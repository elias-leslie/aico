// Codex: ~/.codex/sessions/<year>/<month>/<day>/rollout-<time>-<thread id>.jsonl.
// Its token_count events carry the conversation's running totals, so the last
// one is the answer (input_tokens includes the cached part; the row keeps the
// uncached part and the cached part apart, as Claude Code reports them).
// Files it writes appear in apply_patch text inside its exec calls.

import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  clip,
  type Fold,
  num,
  obj,
  type Reader,
  type Reading,
  type SessionEvent,
  str,
  type TranscriptFile,
  time,
  type Usage,
} from '../types'

type State = Record<string, unknown>
type EventDraft = Omit<SessionEvent, 'offset'>

const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm
const THREAD_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

function totalOf(raw: Record<string, unknown>): Usage {
  const cached = num(raw.cached_input_tokens)
  return {
    input: Math.max(0, num(raw.input_tokens) - cached),
    cacheRead: cached,
    cacheWrite: num(raw.cache_write_input_tokens),
    output: num(raw.output_tokens),
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => str(obj(block)?.text) ?? '')
    .filter(Boolean)
    .join('\n')
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return textOf(output)
  return output === undefined ? '' : JSON.stringify(output)
}

function read(record: Record<string, unknown>, _state: State, wantEvents: boolean): Reading {
  const fold: Fold = {}
  const events: EventDraft[] = []
  const at = time(record.timestamp)
  if (at !== undefined) fold.at = at
  const type = str(record.type)
  const payload = obj(record.payload)
  if (!payload) return { fold, events }
  const kind = str(payload.type)
  if (type === 'session_meta') {
    fold.cwd = str(payload.cwd)
  } else if (type === 'turn_context') {
    fold.model = str(payload.model)
    fold.cwd ??= str(payload.cwd)
  } else if (type === 'event_msg') {
    if (kind === 'token_count') {
      const total = obj(obj(payload.info)?.total_token_usage)
      if (total) fold.usageTotal = totalOf(total)
    } else if (kind === 'task_started') fold.outcome = null
    else if (kind === 'task_complete') fold.outcome = 'completed'
    else if (kind === 'turn_aborted') fold.outcome = 'aborted'
    else if (kind === 'error') fold.outcome = 'error'
    else if (kind === 'thread_settings_applied') {
      fold.model = str(obj(payload.thread_settings)?.model)
    }
  } else if (type === 'response_item') {
    if (kind === 'message') {
      const role = str(payload.role)
      const text = textOf(payload.content)
      if (wantEvents && text && (role === 'user' || role === 'assistant')) {
        events.push({ at: at ?? null, role, kind: 'text', text: clip(text) })
      }
    } else if (kind === 'function_call' || kind === 'custom_tool_call') {
      const name = str(payload.name) ?? 'tool'
      const input = str(payload.input) ?? str(payload.arguments) ?? ''
      fold.toolCalls = 1
      const files = [...input.matchAll(PATCH_FILE)].map((m) => (m[1] ?? '').trim()).filter(Boolean)
      if (files.length) fold.files = files
      if (wantEvents) {
        events.push({
          at: at ?? null,
          role: 'assistant',
          kind: 'tool_call',
          text: clip(input, 600),
          tool: name,
        })
      }
    } else if (
      wantEvents &&
      (kind === 'function_call_output' || kind === 'custom_tool_call_output')
    ) {
      const text = outputText(payload.output)
      if (text) events.push({ at: at ?? null, role: 'tool', kind: 'tool_result', text: clip(text) })
    }
  }
  return { fold, events }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function discover(home: string): TranscriptFile[] {
  const root = join(home, '.codex', 'sessions')
  const found: TranscriptFile[] = []
  for (const year of listDir(root)) {
    for (const month of listDir(join(root, year))) {
      for (const day of listDir(join(root, year, month))) {
        for (const name of listDir(join(root, year, month, day))) {
          if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
            found.push({ path: join(root, year, month, day, name) })
          }
        }
      }
    }
  }
  return found
}

export const codexReader: Reader = {
  tool: 'codex',
  discover,
  nativeIdOf: (path) => THREAD_ID.exec(path)?.[1] ?? basename(path, '.jsonl'),
  initialState: () => ({}),
  read,
}
