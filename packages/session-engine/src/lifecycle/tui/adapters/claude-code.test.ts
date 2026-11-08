import { describe, expect, it } from 'vitest'
import type { FileTail, ProcFs } from '../../../proc-fs'
import { ClaudeMainTurn, claudeCode, mainThreadRow, mainTurnRow } from './claude-code'
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
// A tool call and its result by id; Claude Code writes one assistant row per content block.
const call = (id: string, name = 'Bash') =>
  row({
    type: 'assistant',
    message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: {} }] },
  })
const result = (id: string) =>
  row({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  })
const interrupted = row({
  type: 'user',
  message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
})
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

  it('reads idle from the status file alone, even after a turn end', () => {
    expect(
      setup('idle', [prompt, reply, turnOver(1)])
        .probe()
        ?.poll(),
    ).toMatchObject({
      state: 'idle',
      detail: null,
    })
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

describe('Claude Code waiting needs a tool call without its result', () => {
  const poll = (lines: string[]) => setup('waiting', lines).probe()?.poll()

  it('is blocked for a permission prompt or a question: the tool call has no result yet', () => {
    expect(poll([prompt, call('a'), result('a'), call('b')])).toMatchObject({
      state: 'blocked',
      source: 'claude-status',
    })
    expect(poll([prompt, call('q', 'AskUserQuestion')])).toMatchObject({ state: 'blocked' })
    // two calls at once, one answered: the other still waits
    expect(poll([prompt, call('a'), call('b'), result('a')])).toMatchObject({ state: 'blocked' })
  })

  it('is idle when the turn ended with background agents running: the 19:24 session that was not asking', () => {
    // Real rows around 19:24:12 on 7 Nov: Agent launched in the background, a reply, the turn
    // end counting four agents, then the status file said waiting.
    const lines = [
      prompt,
      call('agent', 'Agent'),
      result('agent'),
      reply,
      hookSummary,
      turnOver(4),
      ...subagent,
      ...bookkeeping,
    ]
    expect(poll(lines)).toMatchObject({ state: 'idle', detail: null, source: 'claude-status' })
  })

  it('is working when a dialog is open mid-turn with nothing waiting for a result', () => {
    expect(poll([prompt, call('a'), result('a')])).toMatchObject({ state: 'working' })
    expect(poll([prompt])).toMatchObject({ state: 'working' })
  })

  it('forgets calls an interrupt, a new prompt or the turn end left without a result', () => {
    expect(poll([prompt, call('a'), interrupted])).toMatchObject({ state: 'working' })
    expect(poll([prompt, call('a'), prompt])).toMatchObject({ state: 'working' })
    expect(poll([prompt, call('a'), reply, turnOver(0)])).toMatchObject({ state: 'idle' })
  })

  it('follows the transcript: blocked while the call waits, off once it is answered', () => {
    const { files, probe } = setup('waiting', [prompt, call('a')])
    const found = probe()
    expect(found?.poll()?.state).toBe('blocked')
    files[TRANSCRIPT] += `${result('a')}\n`
    expect(found?.poll()?.state).toBe('working')
    files[TRANSCRIPT] += `${call('b')}\n`
    expect(found?.poll()?.state).toBe('blocked')
  })

  it('keeps the status file waiting when the transcript cannot say', () => {
    const missing = setup('waiting', [])
    delete missing.files[TRANSCRIPT]
    expect(missing.probe()?.poll()).toMatchObject({ state: 'blocked' })
  })

  it('reads tool calls and results off main-thread rows only', () => {
    expect(mainThreadRow(call('a'))).toMatchObject({ opened: ['a'], closed: [], reset: false })
    expect(mainThreadRow(result('a'))).toMatchObject({ opened: [], closed: ['a'], reset: false })
    expect(mainThreadRow(prompt)).toMatchObject({ reset: true })
    expect(mainThreadRow(turnOver(1))).toMatchObject({ turn: 'over', reset: true })
    expect(mainThreadRow(row({ type: 'assistant', isSidechain: true, message: {} }))).toBeNull()
  })
})
