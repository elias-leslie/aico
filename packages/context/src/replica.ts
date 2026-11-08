// A read-only copy of the owner's context on a standby machine. The workstation writes memories, prompts,
// roles and the launch policy; the standby gets a consistent snapshot of just those tables (the delivery
// log stays local) and replaces its own with it. `aico context-sync` (packages/ops) sends the snapshot over
// the fleet link; the receiving side is `aico context replica hash|apply` (cli.ts).
//
// A standby that wrote to these tables itself (a memory saved by a session running there) is not merged:
// before the snapshot replaces them, the standby's whole file is kept next to context.db and the apply
// says so. State is context-replica.json beside context.db: its presence marks the machine as a copy.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readQuery, snapshotDatabase, transaction } from '@aico/store'
import { type Database, openContext } from './db'
import { type Memory, memoriesCreatedSince } from './memory'

/** Parents before children: apply deletes in reverse and inserts in this order. */
const REPLICATED_TABLES = [
  'memories',
  'memory_revisions',
  'prompts',
  'prompt_revisions',
  'roles',
  'role_prompts',
  'role_context_overrides',
  'launch_tools',
  'launch_providers',
  'launch_deny',
  'context_budgets',
  'project_permissions',
  'settings',
] as const

/** What stays on the machine that wrote it (the delivery log; children first). */
const LOCAL_TABLES = ['context_uses', 'context_observations', 'delivery_items', 'deliveries']

const KEEP_COPIES = 5

export interface ReplicaState {
  from: string
  hash: string
  at: string
}

export const replicaStatePath = (dbPath: string) => join(dirname(dbPath), 'context-replica.json')

export function readReplicaState(dbPath: string): ReplicaState | null {
  try {
    return JSON.parse(readFileSync(replicaStatePath(dbPath), 'utf8')) as ReplicaState
  } catch {
    return null
  }
}

/** One hash of everything that is copied, in a fixed order; equal hashes mean equal copies. */
export function replicaHash(db: Database): string {
  const hash = createHash('sha256')
  for (const table of REPLICATED_TABLES) {
    hash.update(`\n${table}\n`)
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).iterate())
      hash.update(`${JSON.stringify(row)}\n`)
  }
  return hash.digest('hex')
}

/** True when this copy holds something the machine it came from does not (a memory saved here, a count moved). */
export function changedSinceApply(db: Database, dbPath: string): boolean {
  const state = readReplicaState(dbPath)
  return state !== null && replicaHash(db) !== state.hash
}

/** The memories first saved on this copy since the last apply: what the sender takes before it overwrites them. */
export function memoriesSavedHere(db: Database, dbPath: string): Memory[] {
  const state = readReplicaState(dbPath)
  return state ? memoriesCreatedSince(db, state.at) : []
}

export function schemaVersion(db: Database): number {
  return Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
}

/** Writes a consistent snapshot of `dbPath` to `out`: the copied tables only. */
export function exportReplica(dbPath: string, out: string): void {
  snapshotDatabase(dbPath, out)
  const copy = openContext(out)
  try {
    copy.exec('PRAGMA foreign_keys = OFF')
    for (const table of LOCAL_TABLES) copy.exec(`DELETE FROM ${table}`)
    copy.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copy.exec('VACUUM')
    copy.exec('PRAGMA journal_mode = DELETE')
  } finally {
    copy.close()
  }
}

const count = (db: Database, table: string) =>
  Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n)

/**
 * Replaces the copied tables of `db` (the file at `dbPath`) with those of the snapshot file `incoming`,
 * all or nothing. Returns one line saying what happened. Refuses a snapshot from another schema version.
 */
export function applyReplica(
  db: Database,
  dbPath: string,
  incoming: string,
  from: string,
  now: Date,
): string {
  const state = readReplicaState(dbPath)
  const mine = schemaVersion(db)
  const theirs = Number(
    (readQuery(incoming, 'SELECT user_version AS v FROM pragma_user_version')[0] as { v: bigint })
      .v,
  )
  if (theirs !== mine)
    throw new Error(
      `the copy is schema ${theirs} and this machine's context.db is ${mine}; send the same Aico release first (the peer-release job does)`,
    )
  const copy = openContext(incoming)
  const hash = (() => {
    try {
      return replicaHash(copy)
    } finally {
      copy.close()
    }
  })()
  let kept = ''
  const changedHere = state
    ? replicaHash(db) !== state.hash
    : count(db, 'memories') + count(db, 'prompts') > 0
  if (changedHere) {
    const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15)
    const file = join(dirname(dbPath), `context-replica-before-${stamp}.db`)
    snapshotDatabase(dbPath, file)
    kept = file
    const old = readdirSync(dirname(dbPath))
      .filter((f) => /^context-replica-before-.*\.db$/.test(f))
      .sort()
      .slice(0, -KEEP_COPIES)
    for (const f of old) rmSync(join(dirname(dbPath), f), { force: true })
  }
  db.exec(`ATTACH DATABASE '${incoming.replaceAll("'", "''")}' AS incoming`)
  try {
    transaction(db, () => {
      for (const table of [...REPLICATED_TABLES].reverse()) db.exec(`DELETE FROM main.${table}`)
      for (const table of REPLICATED_TABLES) {
        const columns = (
          db
            .prepare(`SELECT name FROM pragma_table_info('${table}', 'main') ORDER BY cid`)
            .all() as {
            name: string
          }[]
        )
          .map((c) => c.name)
          .join(', ')
        db.exec(`INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM incoming.${table}`)
      }
    })
  } finally {
    db.exec('DETACH DATABASE incoming')
  }
  if (replicaHash(db) !== hash)
    throw new Error('the copy does not match what was sent; nothing kept')
  const next: ReplicaState = { from, hash, at: now.toISOString() }
  writeFileSync(replicaStatePath(dbPath), `${JSON.stringify(next)}\n`, { mode: 0o600 })
  const line = `copied from ${from}: ${count(db, 'memories')} memories, ${count(db, 'prompts')} prompts, ${count(db, 'roles')} roles`
  return kept ? `${line}; this machine's own changes were kept in ${basename(kept)}` : line
}
