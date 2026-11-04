import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { type Migration, openDatabase, transaction } from './index'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aico-store-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const V1 = 'CREATE TABLE t (id TEXT PRIMARY KEY)'
const V2 = 'ALTER TABLE t ADD COLUMN n INTEGER NOT NULL DEFAULT 0'

describe('openDatabase', () => {
  it('creates the file 0600 in a 0700 directory, in WAL mode', () => {
    const path = join(tempDir(), 'nested', 'x.db')
    const db = openDatabase(path, [V1])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    db.close()
  })

  it('runs only the migrations a file has not had yet', () => {
    const path = join(tempDir(), 'x.db')
    const first = openDatabase(path, [V1])
    first.prepare('INSERT INTO t (id) VALUES (?)').run('a')
    first.close()
    const second = openDatabase(path, [V1, V2])
    expect(second.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    expect(second.prepare('SELECT id, n FROM t').all()).toEqual([{ id: 'a', n: 0 }])
    second.close()
    openDatabase(path, [V1, V2]).close()
  })

  it('runs a function migration over the data it reads, in the same transaction', () => {
    const path = join(tempDir(), 'x.db')
    const first = openDatabase(path, [V1])
    first.prepare('INSERT INTO t (id) VALUES (?)').run('a')
    first.close()
    const fill = (db: Parameters<Exclude<Migration, string>>[0]) => {
      db.exec(V2)
      for (const { id } of db.prepare('SELECT id FROM t').all() as { id: string }[])
        db.prepare('UPDATE t SET n = ? WHERE id = ?').run(id.length + 6, id)
    }
    const db = openDatabase(path, [V1, fill])
    expect(db.prepare('SELECT id, n FROM t').all()).toEqual([{ id: 'a', n: 7 }])
    db.close()
    expect(() =>
      openDatabase(join(tempDir(), 'y.db'), [
        V1,
        () => {
          throw new Error('no')
        },
      ]),
    ).toThrow('no')
  })

  it('refuses a file newer than the code', () => {
    const path = join(tempDir(), 'x.db')
    openDatabase(path, [V1, V2]).close()
    expect(() => openDatabase(path, [V1])).toThrow(/schema version 2, newer than this Aico \(1\)/)
  })

  it('leaves the version alone when a migration fails', () => {
    const path = join(tempDir(), 'x.db')
    openDatabase(path, [V1]).close()
    expect(() => openDatabase(path, [V1, 'ALTER TABLE missing ADD COLUMN x'])).toThrow()
    const db = openDatabase(path, [V1])
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    db.close()
  })
})

// The first migration is slow, so the others read the version while it runs; neither migration
// can run twice ("table t already exists").
const SLOW = [
  'CREATE TABLE t (i INTEGER); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000) INSERT INTO t SELECT i FROM n',
  'CREATE TABLE u (id TEXT)',
]

/** Opens `path` in another process at `startAt` (epoch ms) and prints its user_version. */
const OPENER = `
const [store, startAt, path, migrations] = process.argv.slice(1)
const { openDatabase } = await import(store)
while (Date.now() < Number(startAt)) {}
const db = openDatabase(path, JSON.parse(migrations))
console.log(db.prepare('PRAGMA user_version').get().user_version)
db.close()
`

describe('openDatabase from several processes at once', () => {
  it('migrates a fresh file exactly once', async () => {
    const path = join(tempDir(), 'x.db')
    const store = fileURLToPath(new URL('./index.ts', import.meta.url))
    const startAt = String(Date.now() + 1500)
    const run = promisify(execFile)
    const outputs = await Promise.all(
      [1, 2, 3, 4].map(() =>
        run(process.execPath, [
          '--input-type=module',
          '-e',
          OPENER,
          store,
          startAt,
          path,
          JSON.stringify(SLOW),
        ]),
      ),
    )
    expect(outputs.map(({ stdout }) => stdout.trim())).toEqual(['2', '2', '2', '2'])
  }, 20_000)
})

describe('transaction', () => {
  it('commits all of the work or none of it', () => {
    const db = openDatabase(':memory:', [V1])
    const insert = db.prepare('INSERT INTO t (id) VALUES (?)')
    transaction(db, () => insert.run('a'))
    expect(() =>
      transaction(db, () => {
        insert.run('b')
        insert.run('a')
      }),
    ).toThrow()
    expect(db.prepare('SELECT id FROM t').all()).toEqual([{ id: 'a' }])
    expect(db.isTransaction).toBe(false)
    db.close()
  })
})
