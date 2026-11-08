// What the Codex and Claude Code transcript passes share: finding the files a pass reads, where
// it resumes each one (its cursor, or its start when the file was replaced), reading only complete
// appended lines, and saving the cursors in the pass's transaction. A private file's cursor is
// keyed by a hash of its path, so the path is never stored.

import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import type { Database } from './db'

const CHUNK = 8 * 1024 * 1024

export const sha = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

/** How a private file's cursor is stored: by a hash of its path. */
export const privateKey = (path: string) => `private:${sha(path)}`

/** The first bytes' hash of a file (a rewritten file starts differently), or '' when empty. */
function headHash(path: string, size: number): string {
  if (size === 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(256, size))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return sha(buffer.subarray(0, read).toString('latin1'))
  } finally {
    closeSync(fd)
  }
}

/** The project a working directory belongs to: the first folder under a workspaces root, else its name. */
export function projectOf(cwd: string | undefined, homes: readonly string[]): string {
  if (!cwd) return 'unknown'
  const path = cwd.replace(/\/+$/, '')
  for (const prefix of ['/srv/workspaces/projects/', '/srv/workspaces/', '/srv/scratch/', ...homes])
    if (path.startsWith(prefix)) return path.slice(prefix.length).split('/', 1)[0] || 'unknown'
  return path.split('/').pop() || 'unknown'
}

/** Complete lines appended after `offset` (up to `end`), with the offset after the last one. */
export function* newLines(path: string, offset: number, end: number): Generator<[string, number]> {
  const fd = openSync(path, 'r')
  try {
    let pos = offset
    let carry = Buffer.alloc(0)
    while (pos < end) {
      const buffer = Buffer.alloc(Math.min(CHUNK, end - pos))
      const read = readSync(fd, buffer, 0, buffer.length, pos)
      if (read <= 0) break
      pos += read
      let data = Buffer.concat([carry, buffer.subarray(0, read)])
      const base = pos - data.length
      let from = 0
      for (;;) {
        const nl = data.indexOf(10, from)
        if (nl < 0) break
        yield [data.toString('utf8', from, nl), base + nl + 1]
        from = nl + 1
      }
      carry = Buffer.from(data.subarray(from))
      data = Buffer.alloc(0)
    }
  } finally {
    closeSync(fd)
  }
}

export type Found = { path: string; size: number; mtime: number }

export interface SavedCursor {
  offset: number
  state: string
}

/**
 * The transcript files a pass reads: those under the existing `roots` changed since `sinceMs`,
 * plus any file with a saved cursor (`cursorSql` lists them) that changed in size, wherever its
 * folder is (a session that runs for days appends to the folder it began in). Sets the folder
 * counts on `result`.
 */
export function gatherFiles(
  db: Database,
  rootPaths: string[],
  sinceMs: number,
  recentFiles: (root: string, sinceMs: number) => Found[],
  cursorSql: string,
  result: { roots: number; unreadable: number },
): { files: Map<string, Found>; saved: Map<string, SavedCursor> } {
  const files = new Map<string, Found>()
  const roots = rootPaths.filter((root) => existsSync(root))
  result.roots = roots.length
  for (const root of roots) {
    try {
      for (const file of recentFiles(root, sinceMs)) files.set(file.path, file)
    } catch {
      result.unreadable += 1
    }
  }
  const saved = new Map<string, SavedCursor>()
  for (const row of db.prepare(cursorSql).all() as unknown as (SavedCursor & { path: string })[]) {
    saved.set(row.path, row)
    if (row.path.startsWith('private:') || files.has(row.path)) continue
    if (!roots.some((root) => row.path.startsWith(`${root}/`))) continue
    try {
      const stat = statSync(row.path)
      if (stat.size !== row.offset)
        files.set(row.path, { path: row.path, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      // gone
    }
  }
  return { files, saved }
}

/**
 * Where a pass resumes a file: its saved state and offset, or a fresh start when the file shrank
 * or its first bytes changed (it was replaced), after `takeBack` undoes what each of the old
 * file's rollups added. Null when its first bytes cannot be read now: left for a later pass.
 */
export function resumeFile<
  S extends { private?: boolean; head?: string; rolls?: Record<string, number[]> },
>(
  file: Found,
  prior: SavedCursor | undefined,
  isPrivate: (path: string) => boolean,
  takeBack: (key: string, rolled: NonNullable<S['rolls']>[string]) => void,
): { state: S; offset: number } | null {
  let state = (prior ? JSON.parse(prior.state) : { private: isPrivate(file.path) }) as S
  let offset = prior?.offset ?? 0
  if (prior) {
    let replaced = prior.offset > file.size
    if (!replaced && state.head) {
      try {
        replaced = headHash(file.path, file.size) !== state.head
      } catch {
        return null
      }
    }
    if (replaced) {
      for (const [key, rolled] of Object.entries(state.rolls ?? {}))
        takeBack(key, rolled as NonNullable<S['rolls']>[string])
      state = { private: state.private } as S
      offset = 0
    }
  }
  return { state, offset }
}

/**
 * Whether `file` has lines to read from `offset`. A file already read to its end only gets its first
 * bytes' hash recorded once (a cursor in `cursors`), so a later rewrite is noticed; a file with
 * new lines gets the hash if it has none yet.
 */
export function startFile<S extends { head?: string }>(
  file: Found,
  offset: number,
  state: S,
  cursors: Map<string, { offset: number; state: S }>,
): boolean {
  if (offset >= file.size) {
    if (file.size > 0 && !state.head) {
      state.head = headHash(file.path, file.size)
      cursors.set(file.path, { offset, state })
    }
    return false
  }
  state.head ??= headHash(file.path, file.size)
  return true
}

/** Saves each file's cursor; a private file's under its hashed key, dropping any row its path left. */
export function saveCursors(
  db: Database,
  cursors: Map<string, { offset: number; state: { private?: boolean } }>,
): void {
  const save = db.prepare(
    'INSERT INTO cursors (path, offset, state) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET offset = excluded.offset, state = excluded.state',
  )
  const drop = db.prepare('DELETE FROM cursors WHERE path = ?')
  for (const [path, cursor] of cursors) {
    const key = cursor.state.private ? privateKey(path) : path
    if (key !== path) drop.run(path)
    save.run(key, cursor.offset, JSON.stringify(cursor.state))
  }
}

/** The speeds a provider reports; anything else counts as standard. */
const SPEEDS = ['standard', 'fast', 'flex', 'priority']
export const speedOf = (value: unknown): string =>
  typeof value === 'string' && SPEEDS.includes(value) ? value : 'standard'

export const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

/** A parsed JSON line, or undefined when it is not JSON. Provider log shapes are their own: every field is checked where used. */
// biome-ignore lint/suspicious/noExplicitAny: provider log lines, read defensively field by field
export function parseLine(line: string): any {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}
