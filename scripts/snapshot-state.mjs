#!/usr/bin/env node
// Consistent copies of this host's SQLite stores for the host's backup, which tars files and cannot read a live
// WAL database. VACUUM INTO writes a clean, checkpointed copy; the copy is checked, then renamed over the last one,
// so a bad run leaves the previous snapshot in place. Run by aico-state-snapshot.timer.
//
//   node scripts/snapshot-state.mjs      -> ~/.local/state/aico-snapshot/{notes.db,web.db,tether.db,hosts.json}
//
// AICO_DATA_DIR / AICO_WEB_DB / AICO_SNAPSHOT_DIR move the folders (defaults as in web/server/src/config.ts).
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const env = process.env
const home = env.HOME || homedir()
const state = env.XDG_STATE_HOME || join(home, '.local', 'state')
const webDb = env.AICO_WEB_DB || join(state, 'aico', 'web.db')
const dataDir = resolve(env.AICO_DATA_DIR?.trim() || dirname(webDb))
const tetherDir = join(state, 'tether', 'default')
const out = env.AICO_SNAPSHOT_DIR || join(state, 'aico-snapshot')

const sources = [
  ['notes.db', join(dataDir, 'notes.db')],
  ['web.db', webDb],
  ['tether.db', join(tetherDir, 'tether.db')],
]

mkdirSync(out, { recursive: true, mode: 0o700 })
let failed = false
for (const [name, from] of sources) {
  if (!existsSync(from)) continue // a host without that store has nothing to keep
  const tmp = join(out, `${name}.tmp`)
  rmSync(tmp, { force: true })
  try {
    const db = new DatabaseSync(from)
    try {
      db.exec('PRAGMA busy_timeout = 10000')
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`)
    } finally {
      db.close()
    }
    const copy = new DatabaseSync(tmp)
    try {
      const rows = copy.prepare('PRAGMA integrity_check').all()
      if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok')
        throw new Error('integrity_check failed')
    } finally {
      copy.close()
    }
    renameSync(tmp, join(out, name))
  } catch (error) {
    rmSync(tmp, { force: true })
    console.error(`snapshot ${name}: ${error instanceof Error ? error.message : error}`)
    failed = true
  }
}
// The link map is a small file, not a database.
const hosts = join(home, '.config', 'tether', 'hosts.json')
if (existsSync(hosts)) copyFileSync(hosts, join(out, 'hosts.json'))
process.exit(failed ? 1 : 0)
