import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type ContextCliIo, runContextCli } from './cli'
import { openContext } from './db'
import { addMemory, getMemories } from './memory'
import { getPrompt, putPrompt } from './prompts'

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
        now: () => new Date(),
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

it('updates a prompt and a memory as new revisions, and measures prompts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-update-cli-'))
  try {
    const path = join(dir, 'context.db')
    const db = openContext(path)
    putPrompt(
      db,
      {
        id: 1,
        slug: 'fixture',
        name: 'Fixture',
        description: 'Test',
        content: 'old',
        kind: 'standard',
        isGlobal: true,
        bootEligible: true,
        contextPolicy: null,
        updatedAt: '2026-11-05T00:00:00Z',
      },
      'first',
    )
    const memory = addMemory(db, { content: 'Use the old service.' }, '2026-11-05T00:00:00Z')
    db.close()
    const out: string[] = []
    const io: ContextCliIo = {
      dbPath: path,
      now: () => new Date('2026-11-06T00:00:00Z'),
      out: (s) => out.push(s),
      err: (s) => out.push(s),
    }
    const file = join(dir, 'new.md')
    writeFileSync(file, 'new text')
    expect(await runContextCli('prompt', ['update', 'fixture', '--content-file', file], io)).toBe(0)
    expect(await runContextCli('prompt', ['update', 'nope', '--content-file', file], io)).toBe(1)
    expect(await runContextCli('prompt', ['measure', '--json'], io)).toBe(0)
    expect(JSON.parse(out.pop() || '{}').prompts).toEqual([
      { slug: 'fixture', bytes: 8, lines: 1, tokens: expect.any(Number) },
    ])
    expect(
      await runContextCli(
        'memory',
        ['update', memory.id.slice(0, 8), 'Use Aico.', '--reason', 'retired'],
        io,
      ),
    ).toBe(0)
    const check = openContext(path)
    expect(getPrompt(check, 'fixture')).toMatchObject({ content: 'new text', version: 2 })
    expect(getMemories(check, [memory.id]).found[0]).toMatchObject({
      content: 'Use Aico.',
      version: 2,
      updatedAt: '2026-11-06T00:00:00.000Z',
    })
    expect(
      check
        .prepare('SELECT reason FROM memory_revisions WHERE memory_id = ? ORDER BY version')
        .all(memory.id),
    ).toEqual([{ reason: 'created' }, { reason: 'retired' }])
    check.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each(['memory', 'prompt', 'models', 'context'])(
  'aico %s --help shows that command only and touches no store',
  async (command) => {
    const lines: string[] = []
    const io: ContextCliIo = {
      dbPath: '/nonexistent/context.db',
      now: () => new Date(),
      out: (s) => lines.push(s),
      err: (s) => lines.push(s),
    }
    for (const flag of ['--help', '-h']) {
      expect(await runContextCli(command, [flag], io)).toBe(0)
      const text = lines.pop() ?? ''
      expect(text).toMatch(new RegExp(`^Usage: aico ${command} `))
      for (const other of ['memory', 'prompt', 'models', 'context'].filter((c) => c !== command))
        expect(text).not.toContain(`aico ${other} `)
    }
  },
)
