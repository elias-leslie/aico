import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ContinuationError,
  continuation,
  gitRecap,
  RECAP_LIMITS,
  type RecapHistory,
  type RecapLimits,
} from './continue-from'
import type { SessionEvent } from './sessions/types'

const ev = (
  role: SessionEvent['role'],
  kind: SessionEvent['kind'],
  text: string,
  tool?: string,
): SessionEvent => ({ offset: 0, at: null, role, kind, text, ...(tool ? { tool } : {}) })

function fakeHistory(events: SessionEvent[]): RecapHistory {
  return {
    list: () => [{ id: 'claude-code:abc' }] as never,
    find: () => ({ id: 'claude-code:abc' }) as never,
    events: (_row: unknown, options: { from?: number; limit?: number }) => ({
      items: options.from !== undefined ? events.slice(0, options.limit) : events,
      older: null,
      newer: null,
      size: 1,
    }),
  } as RecapHistory
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'recap-'))
  const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' })
  run('init', '-q', '-b', 'main')
  run('config', 'user.email', 't@example.invalid')
  run('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'one')
  run('add', '.')
  run('commit', '-q', '-m', 'first commit')
  writeFileSync(join(dir, 'b.txt'), 'two')
  return dir
}

const source = (cwd: string | null) => ({
  tool: 'claude-code',
  name: 'fix the build',
  projectId: 'aico',
  projectRoot: cwd,
})

describe('continue-from recap', () => {
  it('holds the first request, the last messages and the checkout state', async () => {
    const cwd = repo()
    const out = await continuation({
      history: fakeHistory([
        ev('user', 'text', 'Fix the build please'),
        ev('assistant', 'text', 'Looking at it'),
        ev('assistant', 'tool_call', 'npm test', 'Bash'),
        ev('tool', 'tool_result', 'ignored output'),
        ev('assistant', 'text', 'The fix is half done: parser.ts still fails'),
      ]),
      from: 'abcd1234',
      source: source(cwd),
      tool: 'codex',
    })
    expect(out.prompt).toContain('earlier Claude Code session ("fix the build")')
    expect(out.prompt).toContain('you are Codex')
    expect(out.prompt).toContain('First request:\nFix the build please')
    expect(out.prompt).toContain('Agent ran Bash: npm test')
    expect(out.prompt).toContain('Agent: The fix is half done: parser.ts still fails')
    expect(out.prompt).not.toContain('ignored output')
    expect(out.prompt).toContain('?? b.txt')
    expect(out.prompt).toContain('first commit')
    expect(out).toMatchObject({
      projectId: 'aico',
      projectRoot: cwd,
      name: 'Continues fix the build',
    })
  })

  it('stays inside the configured size, keeping the newest messages', async () => {
    const cwd = repo()
    const limits: RecapLimits = {
      ...RECAP_LIMITS,
      maxBytes: 1600,
      messageChars: 200,
      maxMessages: 40,
    }
    const events = Array.from({ length: 60 }, (_, i) =>
      ev(i % 2 ? 'assistant' : 'user', 'text', `message ${i} ${'x'.repeat(300)}`),
    )
    const out = await continuation(
      { history: fakeHistory(events), from: 'abcd1234', source: source(cwd), tool: 'pi' },
      limits,
    )
    expect(Buffer.byteLength(out.prompt)).toBeLessThanOrEqual(limits.maxBytes)
    expect(out.prompt).toContain('message 59')
    expect(out.prompt).not.toContain('message 20 ')
  })

  it('the shipped bound fits a fresh launch prompt', () => {
    expect(RECAP_LIMITS.maxBytes).toBeLessThanOrEqual(14 * 1024)
  })

  it('still gives the checkout when no transcript can be read', async () => {
    const cwd = repo()
    const out = await continuation({
      history: undefined,
      from: 'abcd1234',
      source: source(cwd),
      tool: 'codex',
    })
    expect(out.prompt).toContain('No transcript is available')
    expect(out.prompt).toContain('?? b.txt')
  })

  it('refuses an unknown session and one with no checkout', async () => {
    const none = continuation({
      history: undefined,
      from: 'abcd1234',
      source: undefined,
      tool: 'codex',
    })
    await expect(none).rejects.toMatchObject({ status: 404, code: 'unknown_session' })
    await expect(
      continuation({ history: undefined, from: 'abcd1234', source: source(null), tool: 'codex' }),
    ).rejects.toBeInstanceOf(ContinuationError)
  })

  it('says so when the directory is not a repository', async () => {
    expect(await gitRecap(mkdtempSync(join(tmpdir(), 'norepo-')))).toContain('not readable')
  })
})
