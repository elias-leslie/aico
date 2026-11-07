import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { callSocket } from '../client'
import { HttpError, Router, sendError } from '../http'
import { Store } from '../store'
import { registerHistoryRoutes } from './api'
import { formatEvent, runHistory, shortIds } from './cli'
import { History } from './history'
import { completeEnd, readBackward, readForward } from './lines'

// Fixture transcripts are made up here: no real conversation text.
let home: string
let store: Store
let now = 0

beforeEach(() => {
  now = Date.now()
  home = mkdtempSync(join(tmpdir(), 'history-'))
  store = new Store(':memory:')
})
afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

const history = (extra: Partial<ConstructorParameters<typeof History>[1]> = {}) =>
  new History(store.db, {
    homes: [home],
    now: () => now,
    skip: [/(?<![a-z0-9])neri(?![a-z0-9])/i],
    ...extra,
  })

const jsonl = (...records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

function claudeFile(dir: string, id: string, body: string): string {
  const folder = join(home, '.claude', 'projects', dir)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, `${id}.jsonl`)
  writeFileSync(path, body)
  return path
}

const usage = (input: number, cacheRead: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 10,
  output_tokens: output,
})

const claudeSession = (cwd = '/work/demo') =>
  jsonl(
    { type: 'mode', sessionId: 's1' },
    {
      type: 'user',
      cwd,
      timestamp: '2026-11-04T10:00:00Z',
      message: { role: 'user', content: 'make a file' },
    },
    {
      type: 'assistant',
      timestamp: '2026-11-04T10:00:05Z',
      message: {
        id: 'm1',
        model: 'claude-test-1',
        stop_reason: null,
        usage: usage(5, 100, 2),
        content: [{ type: 'text', text: 'ok' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-11-04T10:00:06Z',
      message: {
        id: 'm1',
        model: 'claude-test-1',
        stop_reason: 'tool_use',
        usage: usage(5, 100, 30),
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/work/demo/a.txt' } }],
      },
    },
    {
      type: 'user',
      timestamp: '2026-11-04T10:00:07Z',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-11-04T10:00:09Z',
      message: {
        id: 'm2',
        model: 'claude-test-1',
        stop_reason: 'end_turn',
        usage: usage(7, 120, 4),
        content: [{ type: 'text', text: 'all done' }],
      },
    },
  )

describe('line readers', () => {
  it('reads whole lines forward and leaves a partial last line', () => {
    const path = join(home, 'a.jsonl')
    writeFileSync(path, 'one\ntwo\nthr')
    const seen: string[] = []
    const { end } = readForward(path, 0, 1 << 20, (line) => {
      seen.push(line.text)
      return true
    })
    expect(seen).toEqual(['one', 'two'])
    expect(end).toBe(8)
    appendFileSync(path, 'ee\n')
    const more: string[] = []
    readForward(path, end, 1 << 20, (line) => {
      more.push(line.text)
      return true
    })
    expect(more).toEqual(['three'])
  })

  it('reads backward across chunk edges, newest first', () => {
    const path = join(home, 'b.jsonl')
    const big = 'x'.repeat(700_000)
    writeFileSync(path, `first\n${big}A\n${big}B\nlast\npartial`)
    const lines: string[] = []
    const resume = readBackward(path, completeEnd(path), 64 << 20, (line) => {
      lines.push(line.text.length > 10 ? line.text.slice(-1) : line.text)
      return true
    })
    expect(lines).toEqual(['last', 'B', 'A', 'first'])
    expect(resume).toBe(0)
    const two: string[] = []
    const stopped = readBackward(path, completeEnd(path), 64 << 20, (line) => {
      two.push(line.text.slice(-1))
      return two.length < 2
    })
    expect(two).toEqual(['t', 'B'])
    expect(stopped).toBeGreaterThan(0)
  })
})

describe('Claude Code reader', () => {
  it('counts a message once, adds its growth, and keeps tool calls, files and outcome', async () => {
    claudeFile('-work-demo', 's1', claudeSession())
    await history().scan()
    const [row] = history().list()
    expect(row).toMatchObject({
      id: 'claude-code:s1',
      model: 'claude-test-1',
      project: 'demo',
      toolCalls: 1,
      filesWritten: 1,
      outcome: 'completed',
      tokens: { input: 12, cacheRead: 220, cacheWrite: 20, output: 34 },
      // The last message's whole prompt: uncached, cache read and cache write.
      contextTokens: 137,
    })
    expect(row?.startedAt).toBe(Date.parse('2026-11-04T10:00:00Z'))
    expect(row?.endedAt).toBe(Date.parse('2026-11-04T10:00:09Z'))
  })

  it('folds a subagent transcript under its session and keeps it out of the list', async () => {
    claudeFile('-work-demo', 's1', claudeSession())
    const sub = join(home, '.claude', 'projects', '-work-demo', 's1', 'subagents')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'agent-a.jsonl'), claudeSession().replaceAll('"m1"', '"sm1"'))
    const h = history()
    await h.scan()
    expect(h.list().map((s) => s.id)).toEqual(['claude-code:s1'])
    const row = h.find('s1')
    expect(row).toMatchObject({ id: 'claude-code:s1' })
    const detail = h.get(row as never)
    expect(detail.subagents).toMatchObject({ count: 1, toolCalls: 1, tokens: { output: 34 } })
  })
})

describe('Codex reader', () => {
  it('accepts hook-time ownership after retirement and maps Claude harness names to history names', async () => {
    const h = history()
    const path = claudeFile(
      'demo',
      'early',
      jsonl({ type: 'user', cwd: '/work/demo', timestamp: '2026-11-04T10:00:00Z' }),
    )
    store.db
      .prepare('INSERT INTO retired_session_ids (id, retired_at) VALUES (?, ?)')
      .run('abcd1234', now)
    h.bind('abcd1234', 'claude', 'early')
    await h.scan()
    expect(h.list()[0]).toMatchObject({
      id: 'claude-code:early',
      outcome: 'aborted',
    })
    expect(path).toContain('early.jsonl')
  })

  it('closes a transcript when its owning session ends, including a delayed scan and restart', async () => {
    const dir = join(home, '.codex', 'sessions', '2026', '11', '04')
    mkdirSync(dir, { recursive: true })
    const id = '01a19787-5491-7ac2-ab1f-147ed57e36a2'
    const path = join(dir, `rollout-2026-11-04T10-00-00-${id}.jsonl`)
    const h = history()
    h.bind('abcd1234', 'codex', id)
    h.endOwned('abcd1234')
    writeFileSync(
      path,
      jsonl(
        { type: 'session_meta', payload: { id, cwd: '/work/demo' } },
        { type: 'event_msg', payload: { type: 'task_started' } },
      ),
    )
    const restarted = history()
    await restarted.scan()
    expect(restarted.list()[0].outcome).toBe('aborted')
    appendFileSync(
      path,
      jsonl({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          channel: 'final',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      }),
    )
    await restarted.scan()
    expect(restarted.list()[0].outcome).toBe('completed')
    // The owning session finds its conversation after it ended; another session does not.
    expect(restarted.list({ session: 'abcd1234' }).map((s) => s.id)).toEqual([`codex:${id}`])
    expect(restarted.list({ session: 'ffff0000' })).toEqual([])
  })

  it('takes the last running total and finds written files in patches', async () => {
    const dir = join(home, '.codex', 'sessions', '2026', '11', '04')
    mkdirSync(dir, { recursive: true })
    const id = '01a19787-5491-7ac2-ab1f-147ed57e36a2'
    const total = (input: number, cached: number, output: number) => ({
      type: 'event_msg',
      timestamp: '2026-11-04T10:00:03Z',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
          },
          last_token_usage: { input_tokens: input / 2, cached_input_tokens: cached },
        },
      },
    })
    writeFileSync(
      join(dir, `rollout-2026-11-04T10-00-00-${id}.jsonl`),
      jsonl(
        {
          type: 'session_meta',
          timestamp: '2026-11-04T10:00:00Z',
          payload: { id, cwd: '/work/demo' },
        },
        { type: 'turn_context', payload: { model: 'codex-test' } },
        { type: 'event_msg', payload: { type: 'task_started' } },
        {
          type: 'response_item',
          timestamp: '2026-11-04T10:00:01Z',
          payload: {
            type: 'custom_tool_call',
            name: 'exec',
            input:
              '*** Begin Patch\n*** Add File: /work/demo/n.txt\n+x\n*** Update File: /work/demo/m.txt\n',
          },
        },
        total(100, 40, 5),
        total(300, 100, 20),
        {
          type: 'event_msg',
          timestamp: '2026-11-04T10:00:04Z',
          payload: { type: 'task_complete' },
        },
      ),
    )
    const h = history()
    await h.scan()
    const [row] = h.list()
    expect(row).toMatchObject({
      id: `codex:${id}`,
      model: 'codex-test',
      toolCalls: 1,
      filesWritten: 2,
      outcome: 'completed',
      tokens: { input: 200, cacheRead: 100, output: 20 },
      contextTokens: 150,
    })
  })
})

describe('Codex setup text', () => {
  it("keeps the owner's words and drops what Codex puts in the user seat itself", async () => {
    const dir = join(home, '.codex', 'sessions', '2026', '11', '05')
    mkdirSync(dir, { recursive: true })
    const id = '01a19787-5491-7ac2-ab1f-147ed57e36a3'
    const said = (role: string, text: string) => ({
      type: 'response_item',
      timestamp: '2026-11-05T10:00:01Z',
      payload: { type: 'message', role, content: [{ type: 'input_text', text }] },
    })
    writeFileSync(
      join(dir, `rollout-2026-11-05T10-00-00-${id}.jsonl`),
      jsonl(
        {
          type: 'session_meta',
          timestamp: '2026-11-05T10:00:00Z',
          payload: { id, cwd: '/work/demo' },
        },
        said('user', '<environment_context>\n  <cwd>/work/demo</cwd>\n</environment_context>'),
        said('user', '# AGENTS.md instructions for /work/demo\n\nbe brief'),
        said('user', 'fix the login bug'),
        said('assistant', 'done'),
      ),
    )
    const h = history()
    await h.scan()
    const row = h.find(`codex:${id}`)
    if (!row || row === 'ambiguous') throw new Error('missing')
    const page = h.events(row, {})
    if (page === 'gone') throw new Error('gone')
    expect(page.items.map((e) => [e.role, e.text])).toEqual([
      ['user', 'fix the login bug'],
      ['assistant', 'done'],
    ])
  })
})

describe('Pi reader', () => {
  it('adds each message and reads write calls', async () => {
    const dir = join(home, '.pi', 'agent', 'sessions', '--work-demo--')
    mkdirSync(dir, { recursive: true })
    const id = '019ec374-785d-7a76-87bb-9ffcb174d8c5'
    const reply = (stop: string, content: unknown[], input: number) => ({
      type: 'message',
      timestamp: '2026-11-04T10:00:02Z',
      message: {
        role: 'assistant',
        model: 'pi-test',
        stopReason: stop,
        usage: { input, output: 3, cacheRead: 7, cacheWrite: 1 },
        content,
      },
    })
    writeFileSync(
      join(dir, `2026-11-04T10-00-00-000Z_${id}.jsonl`),
      jsonl(
        { type: 'session', id, cwd: '/work/demo', timestamp: '2026-11-04T10:00:00Z' },
        {
          type: 'message',
          timestamp: '2026-11-04T10:00:01Z',
          message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        },
        reply(
          'toolUse',
          [{ type: 'toolCall', name: 'write', arguments: { path: '/work/demo/p.txt' } }],
          10,
        ),
        reply('stop', [{ type: 'text', text: 'done' }], 20),
      ),
    )
    const h = history()
    await h.scan()
    expect(h.list()[0]).toMatchObject({
      id: `pi:${id}`,
      model: 'pi-test',
      toolCalls: 1,
      filesWritten: 1,
      outcome: 'completed',
      tokens: { input: 30, cacheRead: 14, cacheWrite: 2, output: 6 },
      contextTokens: 28,
    })
  })
})

describe('following a transcript', () => {
  it('reads only what was appended, and waits for a line to finish', async () => {
    const path = claudeFile('-work-demo', 's1', claudeSession())
    const h = history()
    await h.scan()
    const before = h.list()[0]
    const more = jsonl({
      type: 'assistant',
      timestamp: '2026-11-04T10:05:00Z',
      message: {
        id: 'm3',
        model: 'claude-test-1',
        stop_reason: 'end_turn',
        usage: usage(1, 1, 1),
        content: [],
      },
    })
    appendFileSync(path, more.slice(0, 40))
    now += 60_000
    await h.scan()
    expect(h.list()[0]?.tokens).toEqual(before?.tokens)
    appendFileSync(path, more.slice(40))
    await h.scan()
    expect(h.list()[0]?.tokens).toEqual({ input: 13, cacheRead: 221, cacheWrite: 30, output: 35 })
  })

  it('finishes a file the budget cut short over the next ticks', async () => {
    const first = {
      type: 'user',
      cwd: '/work/demo',
      timestamp: '2026-11-04T10:00:00Z',
      message: { role: 'user', content: 'go' },
    }
    const lines = Array.from({ length: 12_000 }, (_, i) => ({
      type: 'assistant',
      timestamp: '2026-11-04T10:00:05Z',
      message: {
        id: `m${i}`,
        model: 'claude-test-1',
        stop_reason: 'end_turn',
        usage: usage(0, 0, 1),
        content: [{ type: 'text', text: 'x'.repeat(200) }],
      },
    }))
    const path = claudeFile('-work-demo', 's1', jsonl(first, ...lines))
    expect(statSync(path).size).toBeGreaterThan(2 << 20)
    const h = history({ budget: 1 })
    await h.scan()
    const afterOne = h.list()[0]?.tokens.output ?? 0
    expect(afterOne).toBeGreaterThan(0)
    expect(afterOne).toBeLessThan(12_000)
    for (let tick = 0; tick < 20; tick++) await h.scan()
    expect(h.list()[0]?.tokens.output).toBe(12_000)
    // Finished: a further scan leaves it alone.
    expect((await h.scan()).files).toBe(0)
  })

  it('skips a line past the size limit and counts the lines after it', async () => {
    const huge = jsonl({ type: 'user', message: { role: 'user', content: 'x'.repeat(17 << 20) } })
    const big = jsonl({ type: 'user', message: { role: 'user', content: 'y'.repeat(5 << 20) } })
    const [head, ...rest] = claudeSession().split('\n')
    const tail = rest.join('\n')
    const path = claudeFile('-work-demo', 's1', `${head}\n${huge}${big}${tail}`)
    const h = history()
    await h.scan()
    expect(h.list()[0]?.tokens).toEqual({ input: 12, cacheRead: 220, cacheWrite: 20, output: 34 })
    expect((await h.scan()).files).toBe(0)
    rmSync(path)
  })

  it('starts over when the file was rewritten', async () => {
    const path = claudeFile('-work-demo', 's1', claudeSession())
    const h = history()
    await h.scan()
    // Shorter, with different content.
    writeFileSync(path, `${claudeSession().split('\n').slice(0, 3).join('\n')}\n`)
    now += 60_000
    await h.scan()
    expect(h.list()[0]).toMatchObject({ toolCalls: 0, filesWritten: 0, tokens: { output: 2 } })
    // Same length, changed tail.
    const text = claudeSession()
    writeFileSync(path, text)
    await h.scan()
    expect(h.list()[0]?.toolCalls).toBe(1)
    writeFileSync(path, text.replace('all done', 'ALL DONE'))
    now += 60_000
    await h.scan()
    expect(h.list()[0]).toMatchObject({ toolCalls: 1, filesWritten: 1, tokens: { output: 34 } })
    truncateSync(path, 10)
    now += 60_000
    await h.scan()
    expect(store.db.prepare('SELECT output_tokens AS n FROM transcripts').get()).toEqual({ n: 0 })
  })

  it('never reads a project it must skip, by folder or by working directory', async () => {
    claudeFile('-srv-projects-neri-hunters', 'n1', claudeSession('/srv/projects/neri-hunters'))
    claudeFile('-srv-projects-x', 'n2', claudeSession('/srv/projects/neri'))
    claudeFile('-srv-projects-generic', 'g1', claudeSession('/srv/projects/generic'))
    const h = history()
    await h.scan()
    expect(h.list().map((s) => s.id)).toEqual(['claude-code:g1'])
    const ignored = store.db
      .prepare('SELECT id, input_tokens, cwd FROM transcripts WHERE ignored = 1 ORDER BY id')
      .all()
    expect(ignored).toEqual([
      { id: 'claude-code:n1', input_tokens: 0, cwd: null },
      { id: 'claude-code:n2', input_tokens: 0, cwd: null },
    ])
  })

  it('does not pick up new transcripts older than the window, but follows known ones', async () => {
    const path = claudeFile('-work-demo', 'old', claudeSession())
    now += 10 * 24 * 3600_000
    const h = history({ sinceMs: 3 * 24 * 3600_000 })
    await h.scan()
    expect(h.list()).toEqual([])
    expect(path).toBeTruthy()
  })

  it('names the project by registry root when it has one', async () => {
    claudeFile('-work-demo', 's1', claudeSession('/work/demo/sub'))
    await history({ projectOf: (cwd) => (cwd.startsWith('/work/demo') ? 'demo-id' : null) }).scan()
    expect(history().list()[0]?.project).toBe('demo-id')
  })
})

describe('events', () => {
  it('pages back from the end and forward from an offset', async () => {
    claudeFile('-work-demo', 's1', claudeSession())
    const h = history()
    await h.scan()
    const row = h.find('s1')
    if (!row || row === 'ambiguous') throw new Error('missing')
    const last = h.events(row, { limit: 2 })
    if (last === 'gone') throw new Error('gone')
    expect(last.items.map((e) => [e.role, e.kind, e.text])).toEqual([
      ['tool', 'tool_result', 'done'],
      ['assistant', 'text', 'all done'],
    ])
    expect(last.older).not.toBeNull()
    const older = h.events(row, { limit: 2, before: last.older as number })
    if (older === 'gone') throw new Error('gone')
    expect(older.items.map((e) => e.kind)).toEqual(['text', 'tool_call'])
    const first = h.events(row, { limit: 2, from: 0 })
    if (first === 'gone') throw new Error('gone')
    expect(first.items.map((e) => e.text)).toEqual(['make a file', 'ok'])
    expect(first.newer).not.toBeNull()
    const rest = h.events(row, { limit: 50, from: first.newer as number })
    if (rest === 'gone') throw new Error('gone')
    expect(rest.items.map((e) => e.kind)).toEqual(['tool_call', 'tool_result', 'text'])
    expect(rest.newer).toBeNull()
    rmSync(row.path)
    expect(h.events(row, {})).toBe('gone')
  })
})

describe('routes and command', () => {
  let server: Server
  let socket: string
  beforeEach(async () => {
    claudeFile('-work-demo', 's1', claudeSession())
    claudeFile('-work-demo', 's2', claudeSession())
    const h = history()
    await h.scan()
    const router = new Router()
    registerHistoryRoutes(router, h)
    server = createServer((req, res) => {
      router.dispatch(req, res).catch((error) => {
        sendError(res, error instanceof HttpError ? error : new HttpError(500, 'internal'))
      })
    })
    socket = join(home, 'h.sock')
    await new Promise<void>((resolve) => server.listen(socket, resolve))
  })
  afterEach(() => new Promise((resolve) => server.close(resolve)))

  const paths = () => ({ socket, instance: 'test' }) as never
  const run = async (...args: string[]) => {
    const out: string[] = []
    const err: string[] = []
    const code = await runHistory(
      { out: (t) => out.push(t), err: (t) => err.push(t) },
      paths(),
      false,
      args,
    )
    return { code, out: out.join('\n'), err: err.join('\n') }
  }

  it('lists, shows and dumps events', async () => {
    const list = await run('list')
    expect(list.code).toBe(0)
    expect(list.out.split('\n')[0]).toMatch(/^ID +LAST ACTIVITY +OUTCOME +CALLS +MODEL +PROJECT$/)
    expect(list.out).toContain('claude-code:s1')
    expect(list.out).toContain('OUTCOME: completed (it gave a final answer)')
    expect(list.out).toContain('claude-test-1')
    const show = await run('show', 's1')
    expect(show.out).toContain('tokens: in 12, cache read 220, cache write 20, out 34')
    expect(show.out).toContain('tool calls: 1   files written: 1')
    const events = await run('events', 's1', '--limit', '2')
    expect(events.out).toMatch(/assistant +all done/)
    expect(events.out).not.toMatch(/\[\d+\]/)
    const dump = await run('events', 's1', '--limit', '1', '--json')
    expect(JSON.parse(dump.out).items).toHaveLength(1)
  })

  it('answers plainly for a missing or ambiguous id', async () => {
    expect((await run('show', 'nope')).err).toBe(
      'No session nope (aico recent list shows the recent ones).',
    )
    expect((await run('show', 's')).err).toMatch(/More than one session/)
    const bogus = await run('bogus')
    expect(bogus.code).toBe(2)
    expect(bogus.err).toBe(
      "aico recent: unknown command 'bogus' (list, show or events); aico recent --help shows how",
    )
    expect(bogus.out).toBe('')
  })

  it('keeps the Aico agent runs it is pushed, with the model of each turn', async () => {
    const id = '6f20c425-600a-4119-8229-302e58fc6d17'
    const pushed = (endedAt: number | null, turns: unknown[]) => ({
      cwd: '/work/demo',
      role: 'implementation',
      startedAt: now - 5000,
      endedAt,
      outcome: endedAt === null ? null : 'completed',
      tokens: { input: 100, cacheRead: 50, cacheWrite: 0, output: 20 },
      toolCalls: 2,
      turns,
    })
    const put = (body: unknown, runId = id) =>
      callSocket(socket, 'PUT', `/v1/history/aico-agent/${runId}`, body)
    expect((await put(pushed(null, []))).body).toEqual({ kept: true })
    const turns = [
      { turn: 1, model: 'codex/gpt-6.1-sol', stop: 'error' },
      { turn: 2, model: 'opencode-go/deepseek-v4.1-flash', stop: 'stop' },
    ]
    expect((await put(pushed(now, turns))).status).toBe(200)
    const list = await run('list', '--tool', 'aico-agent')
    expect(list.out).toContain('aico-agent:6f20c425 ')
    expect(list.out).toMatch(/completed +2 /)
    const show = await run('show', '6f20c425')
    expect(show.out).toContain('model: opencode-go/deepseek-v4.1-flash   outcome: completed')
    expect(show.out).toContain('tokens: in 100, cache read 50, cache write 0, out 20')
    expect(show.out).toContain('turn 1  codex/gpt-6.1-sol  error')
    expect(show.out).toContain(`messages: aico agent show ${id}`)
    const events = await run('events', '6f20c425', '--limit', '1')
    expect(events.out).toContain('turn 2: opencode-go/deepseek-v4.1-flash (stop)')
    expect(events.out).toContain('older: --before 1')
    // A skipped project is not kept; a malformed push is refused.
    expect(
      (await put({ ...pushed(now, []), cwd: '/work/neri' }, `${id.slice(0, 35)}0`)).body,
    ).toEqual({ kept: false })
    expect((await put({ ...pushed(now, []), outcome: 'done' })).status).toBe(400)
    expect((await put({ ...pushed(now, []), extra: 1 })).status).toBe(400)
    expect((await put(pushed(now, []), 'x')).status).toBe(400)
  })

  it('formats an event as a readable line, long text cut', () => {
    const zone = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      const at = Date.parse('2026-11-04T18:53:00Z')
      expect(formatEvent({ offset: 1, at, role: 'user', kind: 'text', text: 'a\nb' })).toBe(
        'Nov 4, 1:53 PM EST   you          a b',
      )
      const call = formatEvent({
        offset: 2,
        at,
        role: 'assistant',
        kind: 'tool_call',
        tool: 'Bash',
        text: 'ls -la',
      })
      expect(call).toBe('Nov 4, 1:53 PM EST   Bash call    ls -la')
      const result = formatEvent({
        offset: 3,
        at,
        role: 'tool',
        kind: 'tool_result',
        text: `{"x":"${'y'.repeat(300)}"}`,
      })
      expect(result.endsWith('…')).toBe(true)
      expect(result.length).toBeLessThan(160)
      expect(formatEvent({ offset: 4, at: null, role: 'user', kind: 'text', text: 'hi' })).toBe(
        '-                    you          hi',
      )
    } finally {
      if (zone === undefined) delete process.env.TZ
      else process.env.TZ = zone
    }
  })

  it('shortens ids to the shortest start that stays unique, at least 8 characters', () => {
    expect(
      shortIds([
        'claude-code:beb34408-c92f-4eb7-95a9-97c4ad269f7a',
        'codex:01a1b190-b3c9-7541-a2fc-9dbafba9b6af',
        'codex:01a1b190-b3c9-7541-a2fc-0000aaaa0000',
        'pi:abc',
      ]),
    ).toEqual([
      'claude-code:beb34408',
      'codex:01a1b190-b3c9-7541-a2fc-9',
      'codex:01a1b190-b3c9-7541-a2fc-0',
      'pi:abc',
    ])
  })
})
