import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '@aico/session-engine/store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { searchLines } from './cli'
import { codeDoing, lastSentence, patchDoing, promptName, toolDoing } from './doing'
import { History, type HistoryOptions } from './history'
import { prefilterNeedle, snippetAround } from './search'

// Fixture transcripts are made up here: no real conversation text.
let home: string
let store: Store
const now = Date.now()

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'names-'))
  store = new Store(':memory:')
})
afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

const history = (more: Partial<HistoryOptions> = {}) =>
  new History(store.db, {
    homes: [home],
    now: () => now,
    skip: [/(?<![a-z0-9])neri(?![a-z0-9])/i],
    ...more,
  })

const jsonl = (...records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`

function write(path: string[], body: string): string {
  const file = join(home, ...path)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, body)
  return file
}

const user = (text: string, at = '2026-11-04T10:00:00Z', extra: object = {}) => ({
  type: 'user',
  cwd: '/work/demo',
  timestamp: at,
  message: { role: 'user', content: text },
  ...extra,
})
const assistant = (content: unknown[], at = '2026-11-04T10:00:05Z') => ({
  type: 'assistant',
  timestamp: at,
  message: { id: `m-${at}`, model: 'claude-test-1', stop_reason: null, content },
})

async function read(files: () => void) {
  files()
  const h = history()
  await h.scan()
  return h
}

const only = (h: History) => {
  const [row] = h.list({})
  if (!row) throw new Error('no session read')
  return row
}

describe('doing-now words', () => {
  it('Codex exec: says the first tool the JavaScript calls', () => {
    expect(
      codeDoing(
        'const r = await tools.exec_command({cmd:"sleep 90 && echo \\"done\\"",yield_time_ms:30000}); text(r);',
      ),
    ).toBe('Running: sleep 90 && echo "done"')
    expect(codeDoing('const r = await tools.write_stdin({session_id:1,chars:""}); text(r);')).toBe(
      'Waiting for a command to finish',
    )
    expect(codeDoing('text(1 + 1)')).toBe('Running code')
  })

  it('words a tool call from its name and arguments', () => {
    expect(toolDoing('Bash', { command: 'npm test -- --run\nmore' })).toBe(
      'Running: npm test -- --run more',
    )
    expect(toolDoing('Edit', { file_path: '/work/demo/src/history.ts' })).toBe('Editing history.ts')
    expect(toolDoing('Write', { file_path: '/work/demo/a.txt' })).toBe('Writing a.txt')
    expect(toolDoing('read', { path: '/work/demo/b.md' })).toBe('Reading b.md')
    expect(toolDoing('Grep', { pattern: 'fold.doing' })).toBe('Searching for fold.doing')
    expect(toolDoing('WebFetch', { url: 'https://example.com/a/b' })).toBe('Reading example.com')
    expect(toolDoing('Task', { description: 'Review the diff' })).toBe(
      'Running an agent: Review the diff',
    )
    expect(toolDoing('mcp__tether__ask', {})).toBe('Using ask')
    expect(toolDoing('TodoWrite', { todos: [] })).toBeUndefined()
  })

  it('takes the last sentence of what the agent said, and names files of a patch', () => {
    expect(lastSentence('Reading the config now. Then I will update the **reader**.')).toBe(
      'Then I will update the reader.',
    )
    expect(lastSentence('```\ncode\n```')).toBeUndefined()
    expect(
      patchDoing('*** Begin Patch\n*** Update File: /w/a.ts\n*** Add File: /w/b.ts\n*** End Patch'),
    ).toBe('Editing a.ts and 1 more')
  })

  it('trims a first prompt to one short line', () => {
    const long = `Please ${'tidy the readers and the names '.repeat(6)}`
    const name = promptName(long)
    expect(name?.length).toBeLessThanOrEqual(71)
    expect(name?.endsWith('…')).toBe(true)
    expect(promptName('  fix\n\nthe   login ')).toBe('fix the login')
    expect(promptName('```\n```')).toBeUndefined()
  })
})

describe('Claude: names and doing now', () => {
  it('names a conversation by its rename, else its generated title, else its first prompt', async () => {
    const prompt = jsonl(user('Fix the login form please'))
    let h = await read(() => write(['.claude', 'projects', '-work-demo', 'a1.jsonl'], prompt))
    expect(only(h).title).toBe('Fix the login form please')
    rmSync(home, { recursive: true, force: true })
    h = await read(() =>
      write(
        ['.claude', 'projects', '-work-demo', 'a1.jsonl'],
        prompt + jsonl({ type: 'ai-title', aiTitle: 'Login form fix' }),
      ),
    )
    expect(only(h).title).toBe('Login form fix')
    rmSync(home, { recursive: true, force: true })
    h = await read(() =>
      write(
        ['.claude', 'projects', '-work-demo', 'a1.jsonl'],
        prompt +
          jsonl(
            { type: 'ai-title', aiTitle: 'Login form fix' },
            { type: 'custom-title', customTitle: 'My login work' },
            { type: 'ai-title', aiTitle: 'Generated later' },
          ),
      ),
    )
    expect(only(h).title).toBe('My login work')
  })

  it('does not take setup or meta text for the first prompt', async () => {
    const h = await read(() =>
      write(
        ['.claude', 'projects', '-work-demo', 'a2.jsonl'],
        jsonl(
          user('<command-name>/clear</command-name>'),
          user('<system-reminder>be brief</system-reminder>'),
          user('expanded skill text', undefined, { isMeta: true }),
          user('Add a dark mode toggle'),
        ),
      ),
    )
    expect(only(h).title).toBe('Add a dark mode toggle')
  })

  it('says what the agent is doing as of its last record', async () => {
    const path = ['.claude', 'projects', '-work-demo', 'a3.jsonl']
    const file = write(
      path,
      jsonl(
        user('go'),
        assistant([
          { type: 'text', text: 'First I will read the reader.' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/work/demo/claude.ts' } },
        ]),
      ),
    )
    const h = history()
    await h.scan()
    expect(only(h).doing).toBe('Reading claude.ts')
    appendFileSync(
      file,
      jsonl(
        {
          type: 'user',
          timestamp: '2026-11-04T10:00:06Z',
          message: { role: 'user', content: [{ type: 'tool_result', content: 'file text' }] },
        },
        assistant(
          [{ type: 'text', text: 'It parses fine. Now the **tests**.' }],
          '2026-11-04T10:00:08Z',
        ),
      ),
    )
    await h.scan()
    expect(only(h).doing).toBe('Now the tests.')
    appendFileSync(file, jsonl(user('next thing', '2026-11-04T10:00:09Z')))
    await h.scan()
    expect(only(h).doing).toBeNull()
  })

  it('hides a token in the doing-now line and the name', async () => {
    const token = `ghp_${'Fake0123456789abcdefghijklmnopqrstuv'}`
    const h = await read(() =>
      write(
        ['.claude', 'projects', '-work-demo', 'a4.jsonl'],
        jsonl(
          user(`use ${token} for the push`),
          assistant([
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: `curl -H "Authorization: Bearer ${token}1"` },
            },
          ]),
        ),
      ),
    )
    const row = only(h)
    expect(row.title).not.toContain('Fake0123456789')
    expect(row.doing).not.toContain('Fake0123456789')
  })
})

describe('Codex and Pi: names and doing now', () => {
  it('Codex: the thread name comes from the session index, else the first prompt; doing from the calls', async () => {
    const id = '01a1b4b5-6ff4-75a3-b7a1-bbc777d614ff'
    const h = await read(() => {
      write(
        ['.codex', 'sessions', '2026', '11', '04', `rollout-2026-11-04T10-00-00-${id}.jsonl`],
        jsonl(
          {
            timestamp: '2026-11-04T10:00:00Z',
            type: 'session_meta',
            payload: { cwd: '/work/demo' },
          },
          {
            timestamp: '2026-11-04T10:00:01Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: '<environment_context>x</environment_context>' },
              ],
            },
          },
          {
            timestamp: '2026-11-04T10:00:02Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Port the cache layer' }],
            },
          },
          {
            timestamp: '2026-11-04T10:00:03Z',
            type: 'response_item',
            payload: {
              type: 'function_call',
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: 'pytest -q' }),
            },
          },
        ),
      )
    })
    expect(only(h).title).toBe('Port the cache layer')
    expect(only(h).doing).toBe('Running: pytest -q')
    writeFileSync(
      join(home, '.codex', 'session_index.jsonl'),
      jsonl(
        { id, thread_name: 'Port the cache laye', updated_at: '2026-11-04T10:00:04Z' },
        { id, thread_name: 'Cache layer port', updated_at: '2026-11-04T10:00:09Z' },
      ),
    )
    await h.scan()
    expect(only(h).title).toBe('Cache layer port')
  })

  it('Pi: the session name wins over the first prompt, and an emptied name falls back', async () => {
    const id = '05cbf460-5866-4ad6-8d50-a16fc2b68d1a'
    const base = jsonl(
      { type: 'session', id, timestamp: '2026-11-04T10:00:00Z', cwd: '/work/demo' },
      {
        type: 'message',
        timestamp: '2026-11-04T10:00:01Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Summarise the repo' }] },
      },
      {
        type: 'message',
        timestamp: '2026-11-04T10:00:02Z',
        message: {
          role: 'assistant',
          model: 'm',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', name: 'edit', arguments: { path: '/work/demo/x.ts' } }],
        },
      },
    )
    const file = write(
      ['.pi', 'agent', 'sessions', '--work-demo--', `2026-11-04T10-00-00-000Z_${id}.jsonl`],
      base,
    )
    const h = history()
    await h.scan()
    expect(only(h).title).toBe('Summarise the repo')
    expect(only(h).doing).toBe('Editing x.ts')
    appendFileSync(
      file,
      jsonl({ type: 'session_info', timestamp: '2026-11-04T10:00:03Z', name: 'Repo tour' }),
    )
    await h.scan()
    expect(only(h).title).toBe('Repo tour')
    appendFileSync(
      file,
      jsonl({ type: 'session_info', timestamp: '2026-11-04T10:00:04Z', name: '' }),
    )
    await h.scan()
    expect(h.conversationName('nobody')).toBeUndefined()
  })
})

describe('session names for running sessions', () => {
  it('a bound session is named by its newest named conversation', async () => {
    write(
      ['.claude', 'projects', '-work-demo', 'a5.jsonl'],
      jsonl(user('Rename the tray'), { type: 'ai-title', aiTitle: 'Tray rename' }),
    )
    const h = history()
    h.bind('abcd1234', 'claude', 'a5')
    await h.scan()
    expect(h.conversationName('abcd1234')).toMatchObject({
      title: 'Tray rename',
      prompt: 'Rename the tray',
    })
  })
})

describe('history search', () => {
  const claude = (id: string, ...lines: unknown[]) =>
    write(['.claude', 'projects', '-work-demo', `${id}.jsonl`], jsonl(...lines))

  it('finds a phrase case-blind in what was said and run, newest session first', async () => {
    claude(
      's1',
      user('How do I rotate the Backup Key?'),
      assistant([{ type: 'text', text: 'Run the rotate script.' }]),
    )
    claude(
      's2',
      user('unrelated', '2026-11-05T10:00:00Z'),
      assistant(
        [{ type: 'tool_use', name: 'Bash', input: { command: 'tether rotate --backup key' } }],
        '2026-11-05T10:00:05Z',
      ),
    )
    const h = history()
    await h.scan()
    const found = await h.search('backup key')
    expect(found.covers).toEqual(['claude-code', 'codex', 'pi'])
    expect(found.items).toHaveLength(2)
    expect(found.items.map((item) => item.matches)).toEqual([1, 1])
    const hit = found.items.find((item) => item.session.id === 'claude-code:s1')?.hits[0]
    expect(hit).toMatchObject({ role: 'user', kind: 'text' })
    expect(hit?.snippet.toLowerCase()).toContain('backup key')
    expect(hit?.offset).toBe(0)
  })

  it('matches text JSON escapes (quotes, newlines, non-ASCII) and ignores tool output', async () => {
    claude('s3', user('say "hello world"\nthen café'), {
      type: 'user',
      timestamp: '2026-11-04T10:00:03Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'zebra only in output' }],
      },
    })
    const h = history()
    await h.scan()
    expect((await h.search('"hello world"')).items).toHaveLength(1)
    expect((await h.search('café')).items).toHaveLength(1)
    expect((await h.search('zebra only')).items).toHaveLength(0)
  })

  it('hides a token the way events do, stops at the limit, and never reads an ignored project', async () => {
    const token = `ghp_${'Fake0123456789abcdefghijklmnopqrstuv'}`
    claude('s4', user(`push with ${token} to remote`))
    claude('s5', user('push to remote'), user('push to remote again'))
    write(
      ['.claude', 'projects', '-work-neri', 'n1.jsonl'],
      jsonl({ ...user('push to remote'), cwd: '/work/neri' }),
    )
    const h = history()
    await h.scan()
    const found = await h.search('push', { limit: 1 })
    expect(found.items).toHaveLength(1)
    expect(found.more).toBe(true)
    const all = await h.search('push to remote')
    expect(all.items.map((item) => item.session.id)).toEqual(['claude-code:s5'])
    expect(all.items.find((item) => item.session.id === 'claude-code:s5')?.matches).toBe(2)
    const secret = await h.search('push with')
    expect(JSON.stringify(secret)).not.toContain('Fake0123456789')
  })

  it('finds a phrase that sits across a chunk edge of the file', async () => {
    const filler = 'x'.repeat(1000)
    const lines = Array.from({ length: 12_000 }, (_, i) => user(`line ${i} ${filler}`))
    claude(
      's6',
      ...lines,
      assistant([{ type: 'text', text: 'the needle phrase is here' }], '2026-11-04T11:00:00Z'),
    )
    const h = history()
    await h.scan()
    const found = await h.search('needle phrase')
    expect(found.items).toHaveLength(1)
    expect(found.items[0]?.hits[0]?.offset).toBeGreaterThan(8 << 20)
  })

  it('finds a query made only of characters the JSON line may escape, and ends', async () => {
    claude('p1', user('open https://example.test/a and then a && b <> "" \\ done'))
    claude('p2', user('nothing special here'))
    const h = history()
    await h.scan()
    for (const query of ['//', '&&', '<>', '""', '\\']) {
      const found = await h.search(query)
      expect(found.items.map((item) => item.session.id)).toEqual(['claude-code:p1'])
    }
  })

  it('matches non-ASCII letters whatever their case', async () => {
    claude('u1', user('Lister l’étendue à Genève'))
    const h = history()
    await h.scan()
    expect((await h.search('Éte')).items).toHaveLength(1)
    expect((await h.search('ÉTENDUE À')).items).toHaveLength(1)
    expect((await h.search('é')).items).toHaveLength(1)
    expect((await h.search('ète')).items).toHaveLength(0)
  })

  it('reports only the conversations it read, and stops at the byte budget', async () => {
    claude('b1', user('shared words in one', '2026-11-05T10:00:00Z'))
    claude('b2', user('shared words in two', '2026-11-04T10:00:00Z'))
    claude('b3', user('shared words in three', '2026-11-03T10:00:00Z'))
    const h = history({ searchBytes: 1 })
    await h.scan()
    const found = await h.search('shared words')
    expect(found.stop).toBe('budget')
    expect(found.more).toBe(true)
    expect(found.items).toHaveLength(1)
    expect(found.searched.sessions).toBe(1)
    expect(found.searched.since).toBe(Date.parse('2026-11-05T10:00:00Z'))
    const lines = searchLines(found).join('\n')
    expect(lines).toContain(': 1 sessions since ')
    expect(lines).toContain('read limit')
    const all = await history().search('shared words')
    expect(all.stop).toBeNull()
    expect(all.more).toBe(false)
    expect(all.searched.sessions).toBe(3)
  })

  it('stops at the time budget and when the caller gives up', async () => {
    claude('t1', user('slow words'))
    const h = history({ searchMs: 0 })
    await h.scan()
    const late = await h.search('slow words')
    expect(late).toMatchObject({ stop: 'budget', more: true, items: [] })
    expect(late.searched.sessions).toBe(0)
    const quit = new AbortController()
    quit.abort()
    const gone = await history().search('slow words', { signal: quit.signal })
    expect(gone).toMatchObject({ stop: 'cancelled', more: true })
    expect(gone.searched.sessions).toBe(0)
  })

  it('keeps the plain part of a query for the byte scan and cuts a snippet around the match', () => {
    expect(prefilterNeedle('say "hello world" now')).toBe('hello world')
    expect(prefilterNeedle('a/b')).toBe('a')
    expect(prefilterNeedle('//')).toBe('')
    expect(prefilterNeedle('Éte')).toBe('te')
    expect(snippetAround(`${'a '.repeat(100)}NEEDLE${' b'.repeat(100)}`, 'needle')).toMatch(
      /^….*needle.*…$/i,
    )
  })
})

describe('search in the terminal', () => {
  it('says what was read, then each session with its lines and how to open it', async () => {
    write(
      ['.claude', 'projects', '-work-demo', 'c1.jsonl'],
      jsonl(user('How do I rotate the backup key?'), {
        type: 'ai-title',
        aiTitle: 'Backup key rotation',
      }),
    )
    const h = history()
    await h.scan()
    const lines = searchLines(await h.search('BACKUP KEY'))
    expect(lines[0]).toMatch(/^Searched Claude Code, Codex, Pi: 1 sessions since /)
    expect(lines[0]).toContain('not searched yet')
    expect(lines.join('\n')).toMatch(/claude-code:c1 .*demo {2}Backup key rotation {2}\(1 match\)/)
    expect(lines.join('\n')).toContain('you          How do I rotate the backup key?')
    expect(lines.at(-1)).toBe('  open: aico recent events claude-code:c1 --from 0')
    expect(searchLines(await h.search('no such words')).join('\n')).toContain(
      'Nothing found for "no such words".',
    )
  })
})
