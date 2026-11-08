// Claude Code's transcripts (~/.claude/projects/<folder>/<session>.jsonl, and the
// subagent sidechains under <session>/subagents/*.jsonl): every assistant line carries
// message.model and message.usage. Read only what was appended since the last pass (a
// cursor per file, saved in the same transaction as the rows it produced) and keep, per
// local day, model, project and speed: requests and tokens. Conversation text is never kept.
// Claude Code writes a streamed message as several lines with one message id; the cursor
// remembers what the last few ids already counted and adds only the growth, so a message
// counts once as a request and once per token. A file that shrank or starts differently is
// read again from its start and replaces what it contributed. A file in a path or working
// directory marked private contributes numbers only: its cursor is keyed by a hash of its
// path, and neither its working directory nor its session id is kept.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { transaction } from '@aico/store'
import config from '../data/usage.json' with { type: 'json' }
import type { Database } from './db'
import { localDay } from './plans'
import {
  type Found,
  gatherFiles,
  newLines,
  num,
  parseLine,
  privateKey,
  projectOf,
  resumeFile,
  saveCursors,
  speedOf,
  startFile,
} from './transcripts'

interface FileState {
  cwd?: string
  /** Only numbers are kept from this file. */
  private?: boolean
  /** Hash of the file's first bytes: a different one means the file was rewritten. */
  head?: string
  /** The newest message ids and what each has counted so far (input, cached, cache write, output). */
  seen?: Record<string, [number, number, number, number]>
  /** What this file added to the daily rows (key to requests, input, cached, cache write, output). */
  rolls?: Record<string, [number, number, number, number, number]>
}

export interface ClaudeTranscriptOptions {
  /** The transcript roots, one per native home (HOME/.claude/projects). */
  roots: string[]
  /** True for a path or working directory this collector keeps only numbers from. */
  isPrivate: (text: string) => boolean
  /** Home folders whose names stand for the project (for a working directory under them). */
  homes: readonly string[]
  now: number
  /** The first local day this package counts (YYYY-MM-DD): earlier days came from Agent Hub. */
  cutoverDay: string
}

export interface ClaudeTranscriptResult {
  files: number
  bytes: number
  requests: number
  /** Transcript folders that exist, and how many could not be read (counts only, never names). */
  roots: number
  unreadable: number
}

/** The transcript files under a root changed since `sinceMs`: session files and their subagent sidechains. */
function recentFiles(root: string, sinceMs: number): Found[] {
  const out: Found[] = []
  const add = (path: string) => {
    try {
      const stat = statSync(path)
      if (stat.mtimeMs >= sinceMs) out.push({ path, size: stat.size, mtime: stat.mtimeMs })
    } catch {
      // gone between listing and stat
    }
  }
  for (const folder of readdirSync(root, { withFileTypes: true })) {
    if (!folder.isDirectory()) continue
    const base = join(root, folder.name)
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) add(join(base, entry.name))
      else if (entry.isDirectory()) {
        const subagents = join(base, entry.name, 'subagents')
        if (!existsSync(subagents)) continue
        for (const sub of readdirSync(subagents))
          if (sub.endsWith('.jsonl')) add(join(subagents, sub))
      }
    }
  }
  return out
}

export function collectClaudeTranscripts(
  db: Database,
  options: ClaudeTranscriptOptions,
): ClaudeTranscriptResult {
  // One write transaction for the whole pass: a second collect waits here, then reads the
  // cursors the first one saved, so no line is counted twice.
  return transaction(db, () => pass(db, options))
}

function pass(db: Database, options: ClaudeTranscriptOptions): ClaudeTranscriptResult {
  const { now, cutoverDay } = options
  const cfg = config.claude
  const result: ClaudeTranscriptResult = {
    files: 0,
    bytes: 0,
    requests: 0,
    roots: 0,
    unreadable: 0,
  }
  const [y, m, d] = cutoverDay.split('-').map(Number) as [number, number, number]
  const sinceMs = Math.max(new Date(y, m - 1, d).getTime(), now - config.lookback_days * 86400_000)
  const { files, saved } = gatherFiles(
    db,
    options.roots,
    sinceMs,
    recentFiles,
    "SELECT path, offset, state FROM cursors WHERE path LIKE '%.jsonl' OR path LIKE 'private:%'",
    result,
  )

  const rollups = new Map<string, [number, number, number, number, number]>()
  const roll = (key: string) => {
    const found = rollups.get(key) ?? [0, 0, 0, 0, 0]
    rollups.set(key, found)
    return found
  }
  const cursors = new Map<string, { offset: number; state: FileState }>()

  for (const file of [...files.values()].sort((a, b) => a.mtime - b.mtime)) {
    const resumed = resumeFile<FileState>(
      file,
      saved.get(privateKey(file.path)) ?? saved.get(file.path),
      options.isPrivate,
      (key, back) =>
        roll(key).forEach((_, i, own) => {
          own[i] = (own[i] as number) - (back[i] as number)
        }),
    )
    if (!resumed) continue
    const { state, offset } = resumed
    if (!startFile(file, offset, state, cursors)) continue
    state.rolls ??= {}
    state.seen ??= {}
    const mine = state.rolls
    const seen = state.seen
    let end = offset
    for (const [line, after] of newLines(file.path, offset, file.size)) {
      end = after
      if (!line.includes('"usage"')) continue
      const record = parseLine(line)
      const message = record?.message
      const usage = message?.usage
      if (record?.type !== 'assistant' || !usage || typeof message.model !== 'string') continue
      if (cfg.synthetic_models.includes(message.model)) continue
      const at = Date.parse(record.timestamp ?? '')
      if (Number.isNaN(at)) continue
      if (typeof record.cwd === 'string' && !state.cwd && !state.private) {
        if (options.isPrivate(record.cwd)) state.private = true
        else state.cwd = record.cwd
      }
      const day = localDay(at)
      if (day < cutoverDay) continue
      const speed = speedOf(usage.speed)
      const now4: [number, number, number, number] = [
        num(usage.input_tokens),
        num(usage.cache_read_input_tokens),
        num(usage.cache_creation_input_tokens),
        num(usage.output_tokens),
      ]
      const id = typeof message.id === 'string' ? message.id : null
      const before = id ? seen[id] : undefined
      const add: [number, number, number, number] = before
        ? [
            Math.max(now4[0] - before[0], 0),
            Math.max(now4[1] - before[1], 0),
            Math.max(now4[2] - before[2], 0),
            Math.max(now4[3] - before[3], 0),
          ]
        : now4
      if (id) {
        seen[id] = before
          ? [
              Math.max(now4[0], before[0]),
              Math.max(now4[1], before[1]),
              Math.max(now4[2], before[2]),
              Math.max(now4[3], before[3]),
            ]
          : now4
        const ids = Object.keys(seen)
        for (const old of ids.slice(0, Math.max(ids.length - cfg.remembered_messages, 0)))
          delete seen[old]
      }
      if (before && add.every((value) => value === 0)) continue
      const project = state.private ? 'private' : projectOf(state.cwd, options.homes)
      const key = [day, message.model, project, speed].join('\n')
      const requests = before ? 0 : 1
      const total = roll(key)
      const own = mine[key] ?? [0, 0, 0, 0, 0]
      mine[key] = own
      for (const row of [total, own]) {
        row[0] += requests
        row[1] += add[0]
        row[2] += add[1]
        row[3] += add[2]
        row[4] += add[3]
      }
      result.requests += requests
    }
    if (end !== offset) {
      result.files += 1
      result.bytes += end - offset
    }
    cursors.set(file.path, { offset: end, state })
  }

  const upsert = db.prepare(
    `INSERT INTO daily (day, provider, model, project, speed, requests, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens)
     VALUES (?, 'claude', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, provider, model, project, speed) DO UPDATE SET
       requests = requests + excluded.requests,
       input_tokens = input_tokens + excluded.input_tokens,
       cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
       cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
       output_tokens = output_tokens + excluded.output_tokens`,
  )
  for (const [key, entry] of rollups) {
    const [day, model, project, speed] = key.split('\n') as [string, string, string, string]
    upsert.run(day, model.slice(0, 100), project.slice(0, 200), speed, ...entry)
  }
  saveCursors(db, cursors)
  return result
}
