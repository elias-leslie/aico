// Antigravity CLI: ~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/
// transcript_full.jsonl, one step a line. A planner step carries its own tokens, tool calls and
// reply. No line names the folder, so these rows stay out of the history list (which needs a cwd);
// a session reads its own through the conversation Tether saw in its pane.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { lastSentence, promptName, toolDoing } from '../doing'
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
} from '../types'

type EventDraft = Omit<SessionEvent, 'offset'>

const WRITERS = new Set(['write_file', 'edit_file'])
const CONVERSATION = /\/brain\/([^/]+)\/\.system_generated\//
const REQUEST = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/
/** agy's own nudges between steps look like user turns; they aren't anything anyone asked. */
const NUDGE = /^You did not call any tools\./
/** A tool step opens with its own timing lines. */
const STEP_TIMES = /^Created At: .*\nCompleted At: .*\n/

function describe(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  const first = str(args.CommandLine) ?? str(args.Path) ?? str(args.Query)
  return clip(first ?? JSON.stringify(args), 600)
}

function read(
  record: Record<string, unknown>,
  _state: Record<string, unknown>,
  wantEvents: boolean,
  textMax?: number,
): Reading {
  const fold: Fold = {}
  const events: EventDraft[] = []
  const at = time(record.created_at) ?? null
  if (at !== null) fold.at = at
  const type = str(record.type)
  const content = str(record.content) ?? ''
  if (type === 'USER_INPUT') {
    const text = REQUEST.exec(content)?.[1] ?? content
    if (NUDGE.test(text)) return { fold, events }
    fold.outcome = null
    fold.doing = null
    fold.prompt = promptName(text)
    if (wantEvents && text) events.push({ at, role: 'user', kind: 'text', text: clip(text) })
  } else if (type === 'PLANNER_RESPONSE') {
    const input = num(record.input_tokens)
    const cacheRead = num(record.cache_read_tokens)
    fold.usage = { input, cacheRead, cacheWrite: 0, output: num(record.output_tokens) }
    fold.context = input + cacheRead
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : []
    fold.outcome = calls.length ? null : 'completed'
    for (const raw of calls) {
      const call = obj(raw)
      const name = str(call?.name) ?? 'tool'
      const args = obj(call?.args)
      fold.toolCalls = (fold.toolCalls ?? 0) + 1
      const doing = toolDoing(name, {
        ...args,
        command: args?.CommandLine,
        file_path: args?.Path,
      })
      if (doing) fold.doing = doing
      const written = WRITERS.has(name) ? str(args?.Path) : undefined
      if (written) fold.files = [...(fold.files ?? []), written]
      if (wantEvents)
        events.push({ at, role: 'assistant', kind: 'tool_call', text: describe(args), tool: name })
    }
    if (content) {
      const said = lastSentence(content)
      if (said) fold.doing = said
      if (wantEvents)
        events.push({ at, role: 'assistant', kind: 'text', text: clip(content, textMax) })
    }
  } else if (type === 'GENERIC' && wantEvents) {
    const text = str(record.error) ?? content.replace(STEP_TIMES, '')
    if (text) events.push({ at, role: 'tool', kind: 'tool_result', text: clip(text) })
  }
  return { fold, events }
}

function discover(home: string): TranscriptFile[] {
  const root = join(home, '.gemini', 'antigravity-cli', 'brain')
  try {
    return readdirSync(root).map((id) => ({
      path: join(root, id, '.system_generated', 'logs', 'transcript_full.jsonl'),
    }))
  } catch {
    return []
  }
}

export const agyReader: Reader = {
  tool: 'agy',
  discover,
  nativeIdOf: (path) => CONVERSATION.exec(path)?.[1] ?? path,
  initialState: () => ({}),
  read,
}
