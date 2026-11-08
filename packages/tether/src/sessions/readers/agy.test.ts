import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { agyReader } from './agy'

const read = (record: Record<string, unknown>) => agyReader.read(record, {}, true)
const home = mkdtempSync(join(tmpdir(), 'agy-reader-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('reading an Antigravity conversation', () => {
  it('finds each conversation by its id', () => {
    const logs = join(home, '.gemini/antigravity-cli/brain/abc/.system_generated/logs')
    mkdirSync(logs, { recursive: true })
    writeFileSync(join(logs, 'transcript_full.jsonl'), '')
    const [file] = agyReader.discover(home)
    expect(file?.path).toBe(join(logs, 'transcript_full.jsonl'))
    expect(agyReader.nativeIdOf(file?.path ?? '')).toBe('abc')
    expect(agyReader.discover(join(home, 'nowhere'))).toEqual([])
  })

  it('takes what was asked out of its wrapping', () => {
    const { fold, events } = read({
      type: 'USER_INPUT',
      created_at: '2026-11-08T17:04:07Z',
      content:
        '<USER_REQUEST>\nFix the test\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>',
    })
    expect(fold.prompt).toBe('Fix the test')
    expect(fold.outcome).toBeNull()
    expect(events[0]).toMatchObject({ role: 'user', kind: 'text', text: 'Fix the test' })
  })

  it("doesn't count agy's own nudge as a request", () => {
    const { fold, events } = read({
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\nYou did not call any tools. You should continue\n</USER_REQUEST>',
    })
    expect(fold.prompt).toBeUndefined()
    expect(events).toEqual([])
  })

  it('keeps a finished reply, its tokens and how full the conversation is', () => {
    const { fold, events } = read({
      type: 'PLANNER_RESPONSE',
      input_tokens: 2352,
      cache_read_tokens: 7467,
      output_tokens: 14,
      content: 'Fixed it. The test passes.',
    })
    expect(fold.context).toBe(9819)
    expect(fold.usage).toEqual({ input: 2352, cacheRead: 7467, cacheWrite: 0, output: 14 })
    expect(fold.outcome).toBe('completed')
    expect(events).toEqual([
      { at: null, role: 'assistant', kind: 'text', text: 'Fixed it. The test passes.' },
    ])
  })

  it('reads tool calls: a turn still going, and the files it wrote', () => {
    const { fold, events } = read({
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        { name: 'run_command', args: { CommandLine: 'ls -la' } },
        { name: 'write_file', args: { Path: '/p/a.txt', Content: 'x' } },
      ],
    })
    expect(fold.outcome).toBeNull()
    expect(fold.toolCalls).toBe(2)
    expect(fold.files).toEqual(['/p/a.txt'])
    expect(events.map((event) => event.text)).toEqual(['ls -la', '/p/a.txt'])
  })

  it('shows a refused step as its error', () => {
    const { events } = read({
      type: 'GENERIC',
      status: 'ERROR',
      error: "tool call denied by pre-tool hook: Refused by Aico's limits",
      content: 'Created At: a\nCompleted At: b\nEncountered error',
    })
    expect(events[0]).toMatchObject({ role: 'tool', kind: 'tool_result' })
    expect(events[0]?.text).toContain('denied by pre-tool hook')
  })
})
