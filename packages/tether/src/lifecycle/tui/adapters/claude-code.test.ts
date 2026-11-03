import { describe, expect, it } from 'vitest'
import type { FileTail, ProcFs } from '../../../proc-fs'
import { ClaudeMainTurn, claudeCode, mainTurnRow } from './claude-code'
import { MAIN_TURN_OVER, type StateContext } from './contract'

const SESSION = '5a7741ea-e6b1-4062-853b-0d9d2e03d549'
const TRANSCRIPT = `/h/.claude/projects/-srv-p/${SESSION}.jsonl`
const STATUS = '/h/.claude/sessions/20.json'

// Row shapes as Claude Code 2.1.316 writes them to the main transcript
// (checked against a live session with background agents running).
const row = (fields: Record<string, unknown>) => JSON.stringify({ isSidechain: false, ...fields })
const prompt = row({ type: 'user', origin: { kind: 'human' }, message: { content: 'hi' } })
const toolUse = row({ type: 'assistant', message: { stop_reason: 'tool_use', content: [] } })
const toolResult = row({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
})
const reply = row({ type: 'assistant', message: { stop_reason: 'end_turn', content: [] } })
const hookSummary = row({ type: 'system', subtype: 'stop_hook_summary' })
const turnOver = (pending?: number) =>
  row({ type: 'system', subtype: 'turn_duration', pendingBackgroundAgentCount: pending })
const notice = row({
  type: 'user',
  origin: { kind: 'task-notification' },
  message: { content: '<task-notification>' },
})
const bookkeeping = [
  row({ type: 'last-prompt' }),
  row({ type: 'attachment', attachment: { type: 'output_style' } }),
  row({ type: 'api-request', params: { messages: [{ role: 'user', type: 'text' }] } }),
  row({ type: 'system', subtype: 'away_summary' }),
]
const subagent = [
  row({ type: 'assistant', isSidechain: true, message: { stop_reason: 'tool_use' } }),
  row({ type: 'user', isSidechain: true, message: { content: [] } }),
]

function setup(status: string, lines: string[], extra: Record<string, string> = {}) {
  const files: Record<string, string> = {
    [STATUS]: JSON.stringify({ pid: 20, sessionId: SESSION, status, statusUpdatedAt: 5 }),
    [TRANSCRIPT]: `${lines.join('\n')}\n`,
    ...extra,
  }
  const missing = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
  const fs: ProcFs = {
    readFile: (path) => {
      if (path in files) return files[path] as string
      throw missing(path)
    },
    readHead: (path, bytes) => {
      if (path in files) return (files[path] as string).slice(0, bytes)
      throw missing(path)
    },
    readdir: (path) => {
      const names = Object.keys(files)
        .filter((key) => key.startsWith(`${path}/`))
        .map((key) => key.slice(path.length + 1).split('/')[0] as string)
      if (!names.length) throw missing(path)
      return [...new Set(names)]
    },
    readlink: (path) => {
      throw missing(path)
    },
  }
  const tail: FileTail = {
    read(path, offset, max) {
      const bytes = Buffer.from(files[path] ?? '')
      let start = offset > bytes.length ? 0 : offset
      if (bytes.length - start > max) start = bytes.length - max
      const text = bytes.subarray(start).toString()
      const end = text.lastIndexOf('\n') + 1
      return {
        text: text.slice(0, end),
        offset: start + Buffer.byteLength(text.slice(0, end)),
        size: bytes.length,
      }
    },
    range: () => Buffer.alloc(0),
  }
  const ctx: StateContext = { fs, home: '/h', pids: [20], tail }
  return { files, ctx, probe: () => claudeCode.state.find(ctx, null) }
}

describe('Claude Code main-thread turn rows', () => {
  it('reads the turn end and activity, and nothing else', () => {
    expect(mainTurnRow(turnOver(2))).toBe('over')
    for (const line of [prompt, toolUse, toolResult, reply, notice])
      expect(mainTurnRow(line)).toBe('active')
    for (const line of [hookSummary, ...bookkeeping, ...subagent, 'not json', '{"type":"user"'])
      expect(mainTurnRow(line)).toBeNull()
  })
})

describe('Claude Code state with background agents', () => {
  it('stays plain working while the main turn runs', () => {
    for (const lines of [
      [prompt],
      [prompt, toolUse],
      [prompt, toolUse, toolResult],
      [prompt, reply, hookSummary],
      // an earlier turn's end does not count once a new turn started
      [prompt, reply, turnOver(1), notice],
      [prompt, reply, turnOver(1), notice, ...subagent, ...bookkeeping],
    ])
      expect(setup('busy', lines).probe()?.poll()).toMatchObject({ state: 'working', detail: null })
  })

  it('marks busy as main turn over once the turn ended with background agents running', () => {
    for (const lines of [
      [prompt, reply, hookSummary, turnOver(3)],
      // subagent rows and bookkeeping after the end are not main-thread activity
      [prompt, reply, turnOver(3), ...subagent, ...bookkeeping],
      [prompt, reply, turnOver(1), notice, reply, turnOver(0)],
    ])
      expect(setup('busy', lines).probe()?.poll()).toMatchObject({
        state: 'working',
        detail: MAIN_TURN_OVER,
        source: 'claude-status',
      })
  })

  it('follows the transcript as it grows', () => {
    const { files, probe } = setup('busy', [prompt, reply, turnOver(1)])
    const found = probe()
    expect(found?.poll()?.detail).toBe(MAIN_TURN_OVER)
    files[TRANSCRIPT] += `${notice}\n${toolUse}\n`
    expect(found?.poll()?.detail).toBeNull()
    files[TRANSCRIPT] += `${reply}\n${turnOver(1)}\n`
    expect(found?.poll()?.detail).toBe(MAIN_TURN_OVER)
  })

  it('keeps its place in the transcript when the pane is searched again', () => {
    const { ctx, files } = setup('busy', [prompt, reply, turnOver(1)])
    const first = claudeCode.state.find(ctx, null)
    first?.poll()
    expect(claudeCode.state.find(ctx, first)).toBe(first)
    files[TRANSCRIPT] += `${notice}\n`
    expect(claudeCode.state.find(ctx, first)?.poll()?.detail).toBeNull()
  })

  it('reads idle and waiting from the status file alone, even after a turn end', () => {
    const lines = [prompt, reply, turnOver(1)]
    expect(setup('idle', lines).probe()?.poll()).toMatchObject({ state: 'idle', detail: null })
    expect(setup('waiting', lines).probe()?.poll()).toMatchObject({ state: 'blocked' })
  })

  it('stays plain working when the transcript cannot say', () => {
    const missing = setup('busy', [])
    delete missing.files[TRANSCRIPT]
    expect(missing.probe()?.poll()).toMatchObject({ state: 'working', detail: null })
    // no turn row in the readable tail
    expect(setup('busy', bookkeeping).probe()?.poll()).toMatchObject({ detail: null })
    expect(new ClaudeMainTurn('/nope', setup('busy', []).ctx.tail).isOver()).toBe(false)
  })

  it('reads only the end of a long transcript', () => {
    const filler = row({ type: 'api-request', params: 'x'.repeat(200_000) })
    const lines = [prompt, ...Array(8).fill(filler), reply, turnOver(1)]
    expect(setup('busy', lines).probe()?.poll()?.detail).toBe(MAIN_TURN_OVER)
  })

  it('is plain data', () => {
    const signal = setup('busy', [prompt, reply, turnOver(1)])
      .probe()
      ?.poll()
    expect(JSON.parse(JSON.stringify(signal))).toEqual(signal)
  })
})
