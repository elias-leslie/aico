import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, transaction } from './index'

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
