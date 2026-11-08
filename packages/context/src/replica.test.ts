import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type ContextCliIo, runContextCli } from './cli'
import { openContext } from './db'
import { addMemory, getMemories, listMemories } from './memory'
import { putPrompt } from './prompts'
import { exportReplica, readReplicaState, replicaHash } from './replica'

const NOW = new Date('2026-11-08T00:00:00Z')

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'aico-replica-'))
  const main = join(dir, 'main', 'context.db')
  const standby = join(dir, 'standby', 'context.db')
  const io = (dbPath: string, stdin?: Buffer, lines: string[] = []): ContextCliIo => ({
    dbPath,
    now: () => NOW,
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    stdin: stdin ? () => stdin : undefined,
  })
  const send = async (lines: string[] = []) => {
    const snap = join(dir, 'snap.db')
    rmSync(snap, { force: true })
    exportReplica(main, snap)
    return runContextCli(
      'context',
      ['replica', 'apply', '--from', 'workstation'],
      io(standby, readFileSync(snap), lines),
    )
  }
  return { dir, main, standby, io, send }
}

it('copies the owner context to the standby and keeps the standby delivery log local', async () => {
  const f = fixture()
  try {
    const db = openContext(f.main)
    addMemory(db, { content: 'remember this', summary: 'one' }, NOW.toISOString())
    putPrompt(
      db,
      {
        id: 1,
        slug: 'p',
        name: 'P',
        description: '',
        content: 'text',
        kind: 'standard',
        isGlobal: true,
        bootEligible: false,
        contextPolicy: null,
        updatedAt: NOW.toISOString(),
      },
      'first',
    )
    db.exec(
      "INSERT INTO deliveries (at, tool, channel, hash, bytes, budget) VALUES ('t', 'pi', 'c', 'h', 1, 1)",
    )
    db.close()
    const standby = openContext(f.standby)
    standby.exec(
      "INSERT INTO deliveries (at, tool, channel, hash, bytes, budget) VALUES ('s', 'pi', 'c', 'h', 1, 1)",
    )
    standby.close()
    const lines: string[] = []
    expect(await f.send(lines)).toBe(0)
    expect(lines.join('')).toMatch(/copied from workstation: 1 memories, 1 prompts/)
    const copy = openContext(f.standby)
    expect(listMemories(copy, {}).memories).toHaveLength(1)
    expect(
      (copy.prepare('SELECT at FROM deliveries').all() as { at: string }[]).map((r) => r.at),
    ).toEqual(['s'])
    expect(replicaHash(copy)).toBe(readReplicaState(f.standby)?.hash)
    copy.close()
    const main = openContext(f.main)
    expect(replicaHash(main)).toBe(readReplicaState(f.standby)?.hash)
    main.close()
    expect(readdirSync(join(f.dir, 'standby')).some((n) => n.includes('before'))).toBe(false)
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

it('follows later changes and deletions, and keeps what the standby wrote itself', async () => {
  const f = fixture()
  try {
    const db = openContext(f.main)
    const keep = addMemory(db, { content: 'keep' }, NOW.toISOString())
    const drop = addMemory(db, { content: 'drop' }, NOW.toISOString())
    expect(await f.send()).toBe(0)
    db.prepare('DELETE FROM memories WHERE id = ?').run(drop.id)
    expect(await f.send()).toBe(0)
    let copy = openContext(f.standby)
    expect(getMemories(copy, [keep.id]).found).toHaveLength(1)
    expect(getMemories(copy, [drop.id]).found).toHaveLength(0)
    const own = addMemory(copy, { content: 'written on the standby' }, NOW.toISOString())
    copy.close()
    const lines: string[] = []
    expect(await f.send(lines)).toBe(0)
    expect(lines.join('')).toMatch(/own changes were kept in context-replica-before-/)
    copy = openContext(f.standby)
    expect(getMemories(copy, [own.id]).found).toHaveLength(0)
    copy.close()
    const kept = readdirSync(join(f.dir, 'standby')).find((n) =>
      n.startsWith('context-replica-before-'),
    )
    expect(kept).toBeTruthy()
    const old = openContext(join(f.dir, 'standby', kept as string))
    expect(getMemories(old, [own.id]).found).toHaveLength(1)
    old.close()
    db.close()
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})

it('answers its hash, refuses another schema, and leaves a failed copy untouched', async () => {
  const f = fixture()
  try {
    const db = openContext(f.main)
    addMemory(db, { content: 'one' }, NOW.toISOString())
    db.close()
    const lines: string[] = []
    expect(
      await runContextCli('context', ['replica', 'hash'], f.io(f.standby, undefined, lines)),
    ).toBe(0)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ copy: false })
    expect(await f.send()).toBe(0)
    const again: string[] = []
    await runContextCli('context', ['replica', 'hash'], f.io(f.standby, undefined, again))
    expect(JSON.parse(again[0] as string)).toMatchObject({ copy: true })

    const snap = join(f.dir, 'snap.db')
    exportReplica(f.main, snap)
    const older = openContext(snap)
    older.exec('PRAGMA user_version = 1')
    older.close()
    const err: string[] = []
    expect(
      await runContextCli(
        'context',
        ['replica', 'apply', '--from', 'w'],
        f.io(f.standby, readFileSync(snap), err),
      ),
    ).toBe(1)
    expect(err.join('')).toMatch(/schema 1/)
    expect(
      await runContextCli(
        'context',
        ['replica', 'apply', '--from', 'w'],
        f.io(f.standby, Buffer.from('junk'), []),
      ),
    ).toBe(1)
    expect(existsSync(join(f.dir, 'standby', 'context-replica.json'))).toBe(true)
    expect(
      readdirSync(join(f.dir, 'standby')).filter((n) => n.startsWith('.context-replica-')),
    ).toEqual([])
  } finally {
    rmSync(f.dir, { recursive: true, force: true })
  }
})
