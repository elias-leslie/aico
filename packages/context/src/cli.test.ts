import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type ContextCliIo, runContextCli } from './cli'
import { openContext } from './db'
import { putPrompt } from './prompts'

it('serves prompt JSON and saved revisions for root instruction snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-prompt-cli-'))
  try {
    const db = openContext(join(dir, 'context.db'))
    const prompt = {
      id: 1,
      slug: 'fixture',
      name: 'Fixture',
      description: 'Test',
      content: 'first text',
      kind: 'standard',
      isGlobal: false,
      bootEligible: false,
      contextPolicy: null,
      updatedAt: '2026-11-05T00:00:00Z',
    }
    putPrompt(db, prompt, 'first')
    putPrompt(db, { ...prompt, content: 'second text' }, 'edit')
    db.close()
    const lines: string[] = [],
      io: ContextCliIo = {
        dbPath: join(dir, 'context.db'),
        machine: 'test',
        statusUrl: null,
        fetch,
        now: () => new Date(),
        agentHub: {
          checkout: '/missing',
          source: () => {
            throw new Error('No Agent Hub calls')
          },
        },
        out: (s) => lines.push(s),
        err: (s) => lines.push(s),
      }
    expect(await runContextCli('prompt', ['get', 'fixture', '--json'], io)).toBe(0)
    expect(JSON.parse(lines.pop() || '{}')).toMatchObject({
      slug: 'fixture',
      content: 'second text',
    })
    expect(
      await runContextCli('prompt', ['revisions', 'fixture', '--limit', '100', '--json'], io),
    ).toBe(0)
    const revisions = JSON.parse(lines.pop() || '{}').revisions
    expect(revisions.map((r: { id: string; content: string }) => [r.id, r.content])).toEqual([
      ['0002', 'second text'],
      ['0001', 'first text'],
    ])
    expect(revisions[0].content_hash).toMatch(/^[0-9a-f]{64}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
