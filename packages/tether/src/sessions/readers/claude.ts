// Claude Code: ~/.claude/projects/<project dir>/<session id>.jsonl, and a
// subagent's <session id>/subagents/<agent>.jsonl. The format is undocumented;
// everything that reads it is here. One assistant message is written as
// several records that share `message.id` and repeat its usage, so usage is
// counted once per message (the later record of the same message only adds
// what grew).

import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { INJECTED_PROMPT, lastSentence, promptName, THINKING, toolDoing } from '../doing'
import {
  clip,
  type EventRole,
  type Fold,
  NO_USAGE,
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

interface State extends Record<string, unknown> {
  messageId: string | null
  usage: Usage
  /** A title the owner gave (`/rename`) is on the row: the generated one no longer replaces it. */
  renamed?: boolean
}

const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
type EventDraft = Omit<SessionEvent, 'offset'>

function usageOf(raw: Record<string, unknown> | undefined): Usage {
  return {
    input: num(raw?.input_tokens),
    cacheRead: num(raw?.cache_read_input_tokens),
    cacheWrite: num(raw?.cache_creation_input_tokens),
    output: num(raw?.output_tokens),
  }
}

function growth(now: Usage, before: Usage): Usage {
  return {
    input: Math.max(0, now.input - before.input),
    cacheRead: Math.max(0, now.cacheRead - before.cacheRead),
    cacheWrite: Math.max(0, now.cacheWrite - before.cacheWrite),
    output: Math.max(0, now.output - before.output),
  }
}

/** A tool call in one line: the command, the path or the first argument. */
function describeInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name
  const first =
    str(input.command) ??
    str(input.file_path) ??
    str(input.notebook_path) ??
    str(input.pattern) ??
    str(input.url) ??
    str(input.query) ??
    str(input.description) ??
    str(input.prompt)
  return clip(first ?? JSON.stringify(input), 600)
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => str(obj(block)?.text) ?? '')
    .filter(Boolean)
    .join('\n')
}

function read(record: Record<string, unknown>, state: State, wantEvents: boolean): Reading {
  const fold: Fold = {}
  const events: EventDraft[] = []
  const type = str(record.type)
  const at = time(record.timestamp)
  if (at !== undefined) fold.at = at
  const cwd = str(record.cwd)
  if (cwd) fold.cwd = cwd
  const message = obj(record.message)
  if (type === 'custom-title' || type === 'ai-title') {
    const title = str(record.customTitle) ?? str(record.aiTitle)
    if (type === 'custom-title') {
      state.renamed = Boolean(title)
      fold.title = title?.trim() || null
    } else if (!state.renamed && title) fold.title = title.trim()
    return { fold, events }
  }
  if (!message || (type !== 'user' && type !== 'assistant')) {
    if (type === 'system' && str(record.subtype) === 'compact_boundary' && wantEvents) {
      events.push({ at: at ?? null, role: 'system', kind: 'note', text: 'Conversation compacted' })
    }
    return { fold, events }
  }
  const content = message.content
  if (type === 'user') {
    fold.outcome = null
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: content }]
    for (const raw of blocks) {
      const block = obj(raw)
      if (!block) continue
      const text =
        block.type === 'tool_result' ? resultText(block.content) : (str(block.text) ?? '')
      if (block.type === 'text' && text.startsWith('[Request interrupted')) fold.outcome = 'aborted'
      if (
        block.type === 'text' &&
        text &&
        record.isMeta !== true &&
        record.isCompactSummary !== true &&
        !text.startsWith('[Request interrupted') &&
        !INJECTED_PROMPT.test(text)
      ) {
        fold.prompt ??= promptName(text)
        fold.doing = null
      }
      if (!wantEvents || !text) continue
      const result = block.type === 'tool_result'
      events.push({
        at: at ?? null,
        role: result ? 'tool' : 'user',
        kind: result ? 'tool_result' : 'text',
        text: clip(text),
      })
    }
    return { fold, events }
  }
  const model = str(message.model)
  if (model && model !== '<synthetic>') fold.model = model
  const messageId = str(message.id)
  const usage = obj(message.usage) ? usageOf(message.usage as Record<string, unknown>) : undefined
  if (usage) {
    fold.usage = messageId && messageId === state.messageId ? growth(usage, state.usage) : usage
    fold.context = usage.input + usage.cacheRead + usage.cacheWrite
    state.messageId = messageId ?? null
    state.usage = usage
  }
  const stop = str(message.stop_reason)
  if (record.isApiErrorMessage === true) fold.outcome = 'error'
  else if (stop === 'end_turn' || stop === 'stop_sequence' || stop === 'max_tokens') {
    fold.outcome = 'completed'
  } else if (stop === 'tool_use') fold.outcome = null
  const blocks = Array.isArray(content) ? content : []
  for (const raw of blocks) {
    const block = obj(raw)
    if (!block) continue
    if (block.type === 'tool_use') {
      const name = str(block.name) ?? 'tool'
      const input = obj(block.input)
      fold.toolCalls = (fold.toolCalls ?? 0) + 1
      const doing = toolDoing(name, input)
      if (doing) fold.doing = doing
      if (WRITERS.has(name)) {
        const path = str(input?.file_path) ?? str(input?.notebook_path)
        if (path) fold.files = [...(fold.files ?? []), path]
      }
      if (wantEvents) {
        events.push({
          at: at ?? null,
          role: 'assistant',
          kind: 'tool_call',
          text: describeInput(name, input),
          tool: name,
          model,
        })
      }
    } else if (block.type === 'text' || block.type === 'thinking') {
      const text = str(block.text) ?? str(block.thinking)
      if (block.type === 'text') {
        const said = text ? lastSentence(text) : undefined
        if (said) fold.doing = said
      } else fold.doing ??= THINKING
      if (wantEvents && text) {
        events.push({
          at: at ?? null,
          role: 'assistant' as EventRole,
          kind: block.type === 'thinking' ? 'thinking' : 'text',
          text: clip(text),
          model,
        })
      }
    }
  }
  return { fold, events }
}

function discover(home: string): TranscriptFile[] {
  const root = join(home, '.claude', 'projects')
  const found: TranscriptFile[] = []
  for (const project of listDir(root)) {
    const dir = join(root, project)
    for (const name of listDir(dir)) {
      const path = join(dir, name)
      if (name.endsWith('.jsonl')) found.push({ path })
      else if (!name.includes('.')) {
        for (const sub of listDir(join(path, 'subagents'))) {
          if (sub.endsWith('.jsonl')) {
            found.push({ path: join(path, 'subagents', sub), parentNativeId: name })
          }
        }
      }
    }
  }
  return found
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

export const claudeReader: Reader = {
  tool: 'claude-code',
  discover,
  nativeIdOf: (path) => basename(path, '.jsonl'),
  // The request dumps hold whole prompts and nothing a reader uses.
  skip: (line) => line.startsWith('{"type":"api-request'),
  initialState: () => ({ messageId: null, usage: NO_USAGE }),
  read: (record, state, wantEvents) => read(record, state as State, wantEvents),
}
