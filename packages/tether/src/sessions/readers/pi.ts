// Pi: ~/.pi/agent/sessions/<cwd, slashes as dashes>/<time>_<session id>.jsonl.
// Each assistant message carries its own usage, so totals add up.

import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { INJECTED_PROMPT, lastSentence, promptName, THINKING, toolDoing } from '../doing'
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
  textOf,
  time,
} from '../types'

type State = Record<string, unknown>
type EventDraft = Omit<SessionEvent, 'offset'>

const WRITERS = new Set(['write', 'edit'])
const SESSION_ID = /_([0-9a-f-]{36})\.jsonl$/

function describe(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  const first = str(args.command) ?? str(args.path) ?? str(args.file_path) ?? str(args.query)
  return clip(first ?? JSON.stringify(args), 600)
}

function read(
  record: Record<string, unknown>,
  _state: State,
  wantEvents: boolean,
  textMax?: number,
): Reading {
  const fold: Fold = {}
  const events: EventDraft[] = []
  const at = time(record.timestamp)
  if (at !== undefined) fold.at = at
  const type = str(record.type)
  if (type === 'session') {
    fold.cwd = str(record.cwd)
  } else if (type === 'session_info') {
    fold.title = str(record.name)?.trim() || null
  } else if (type === 'model_change') {
    fold.model = str(record.modelId)
  } else if (type === 'message') {
    const message = obj(record.message)
    const role = str(message?.role)
    if (!message) return { fold, events }
    if (role === 'user') {
      fold.outcome = null
      const text = textOf(message.content)
      if (text && !INJECTED_PROMPT.test(text)) {
        fold.prompt = promptName(text)
        fold.doing = null
      }
      if (wantEvents && text)
        events.push({ at: at ?? null, role: 'user', kind: 'text', text: clip(text) })
    } else if (role === 'toolResult') {
      if (wantEvents) {
        const text = textOf(message.content)
        if (text) {
          events.push({
            at: at ?? null,
            role: 'tool',
            kind: 'tool_result',
            text: clip(text),
            tool: str(message.toolName),
          })
        }
      }
    } else if (role === 'assistant') {
      fold.model = str(message.model)
      const usage = obj(message.usage)
      if (usage) {
        fold.usage = {
          input: num(usage.input),
          cacheRead: num(usage.cacheRead),
          cacheWrite: num(usage.cacheWrite),
          output: num(usage.output),
        }
        fold.context = fold.usage.input + fold.usage.cacheRead + fold.usage.cacheWrite
      }
      const stop = str(message.stopReason)
      if (stop === 'stop' || stop === 'length') fold.outcome = 'completed'
      else if (stop === 'error') fold.outcome = 'error'
      else if (stop === 'aborted') fold.outcome = 'aborted'
      else if (stop === 'toolUse') fold.outcome = null
      for (const raw of Array.isArray(message.content) ? message.content : []) {
        const block = obj(raw)
        if (!block) continue
        if (block.type === 'toolCall') {
          const name = str(block.name) ?? 'tool'
          const args = obj(block.arguments)
          fold.toolCalls = (fold.toolCalls ?? 0) + 1
          const doing = toolDoing(name, args)
          if (doing) fold.doing = doing
          if (WRITERS.has(name)) {
            const path = str(args?.path) ?? str(args?.file_path)
            if (path) fold.files = [...(fold.files ?? []), path]
          }
          if (wantEvents) {
            events.push({
              at: at ?? null,
              role: 'assistant',
              kind: 'tool_call',
              text: describe(args),
              tool: name,
              model: fold.model,
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
              role: 'assistant',
              kind: block.type === 'thinking' ? 'thinking' : 'text',
              text: clip(text, textMax),
              model: fold.model,
            })
          }
        }
      }
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
  const root = join(home, '.pi', 'agent', 'sessions')
  const found: TranscriptFile[] = []
  for (const dir of listDir(root)) {
    for (const name of listDir(join(root, dir))) {
      if (name.endsWith('.jsonl')) found.push({ path: join(root, dir, name) })
    }
  }
  return found
}

export const piReader: Reader = {
  tool: 'pi',
  discover,
  nativeIdOf: (path) => SESSION_ID.exec(path)?.[1] ?? basename(path, '.jsonl'),
  initialState: () => ({}),
  read,
}
