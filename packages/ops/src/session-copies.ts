// `aico shift`: what each active agent session on this machine is doing, and its conversation, on the
// other full Aico machines, so the survivor of a crash knows what was going on and holds the latest copy.
// Level 1 of docs/plans/session-shift/plan.md: nothing here moves or resumes a session.
//
// The sender (`aico shift run`, the session-copies-<machine> job) reads Tether's live sessions and the
// tool's own transcript files. Only what changed goes over the fleet link: nothing at all while nothing
// changed, and a file's new bytes when one grew. The receiver (`aico shift sizes|receive`, on the peer)
// holds them under copiesDir, 0700, out of backups and enforces the limits; a removal is logged in
// removed.log there. Uncommitted work goes through the repo copies (wip-mirror.ts).
// Limits, exclusions and places are data/session-copies.json; the interval is the job in packages/jobs.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { requestExec } from '@aico/fleet/exec'
import { fullPeers } from '@aico/fleet/peers'
import { readSettings } from '@aico/fleet/settings'
import { readPins } from '@aico/fleet/trust'
import { maskSecrets } from '@aico/shared/secrets'
import { localTime } from '@aico/shared/time'
import { machineId } from '@aico/status'
import { snapshotDatabase } from '@aico/store'
import copiesConfig from '../data/session-copies.json' with { type: 'json' }
import { Refusal } from './deploy'
import { expandHome, type Runner, run as shell } from './sh'

export type CopiesConfig = typeof copiesConfig

const MB = 1024 * 1024
const TAIL_BYTES = 4096
const MACHINE = /^[a-z0-9][a-z0-9._-]{0,99}$/
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,99}$/
const REL = /^[A-Za-z0-9._@+/-]{1,400}$/
const sq = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text
const lastLine = (text: string) => text.trim().split('\n').filter(Boolean).pop() ?? ''
const sizeWord = (bytes: number) =>
  bytes >= 1024 * MB
    ? `${(bytes / 1024 / MB).toFixed(1)} GB`
    : bytes >= MB
      ? `${Math.round(bytes / MB)} MB`
      : `${Math.ceil(bytes / 1024)} KB`

/** One line of what was said. Masked: the copy may hold anything, a list on a screen must not show a key. */
export interface Said {
  at: number | null
  text: string
}

/** What the survivor knows about one session, as of the sender's last pass. */
export interface CopySession {
  id: string
  tool: string
  /** The tool's own conversation id (null until it has one). */
  resumeId: string | null
  title: string
  project: string | null
  cwd: string | null
  state: string
  detail: string | null
  doing: string | null
  waitingOn: string | null
  needsYou: boolean
  /** The newest change to its conversation, else Tether's last state change. */
  lastActivity: number | null
  createdAt: number | null
  lastOwner: Said | null
  lastAgent: Said | null
  /** The project's checkout as of that pass (null: not a Git checkout). */
  git: { branch: string; head: string; dirty: number } | null
}

interface CopySnapshot {
  v: 1
  machine: string
  at: number
  sessions: CopySession[]
}

/** A session as `aico shift list` reads it: the snapshot's facts and what this machine holds of it. */
export interface HeldSession extends CopySession {
  /** When it left its machine's list; null while it was still there at the last pass. */
  endedAt: number | null
  copy: { bytes: number; files: number; cut: boolean; newest: number | null; path: string } | null
}

export interface HeldMachine {
  machine: string
  at: number
  sessions: HeldSession[]
}

// ---- which sessions, and which files --------------------------------------------------------

/** Tether's record, the fields this reads. */
export interface LiveRecord {
  id: string
  status: string
  tool: string
  host?: string | null
  displayTitle?: string | null
  label?: string | null
  name?: string | null
  projectId?: string | null
  projectRoot?: string | null
  rootRequestId?: string | null
  parentId?: string | null
  coordinatorId?: string | null
  state?: string | null
  stateAt?: number | null
  stateDetail?: string | null
  doing?: string | null
  waitingOn?: unknown
  asks?: unknown[]
  createdAt?: number | null
}

/**
 * The sessions that may leave this machine: agents running here (not ones another machine runs and
 * Tether only lists), never a shell, never a Neri project or a hunting role, and never a helper of
 * one: the rule follows a session up through whoever launched it. Where that chain can't be read to
 * its end the session stays home; `roles` null means roles couldn't be read.
 */
export function eligibleSessions(
  records: LiveRecord[],
  roles: ReadonlyMap<string, string | null> | null,
  cfg: CopiesConfig,
): LiveRecord[] {
  const rolePattern = new RegExp(cfg.exclude.rolePattern, 'i')
  const byId = new Map(records.map((record) => [record.id, record]))
  const excludedHere = (record: LiveRecord) => {
    if (record.projectId && cfg.exclude.projects.includes(record.projectId)) return true
    const segments = (record.projectRoot ?? '').split('/')
    return cfg.exclude.pathSegments.some((segment) => segments.includes(segment))
  }
  const huntingRoot = (root: string) => !roles?.has(root) || rolePattern.test(roles.get(root) ?? '')
  const allowed = (record: LiveRecord) => {
    const seen = new Set<string>()
    let at: LiveRecord | undefined = record
    while (at) {
      if (seen.has(at.id) || excludedHere(at)) return false
      seen.add(at.id)
      if (at.rootRequestId && huntingRoot(at.rootRequestId)) return false
      const up: string | null | undefined = at.parentId ?? at.coordinatorId
      if (!up) return true
      at = byId.get(up)
      // Launched by something that isn't listed any more: only a root we can name lets it through.
      if (!at) return !huntingRoot(up)
    }
    return false
  }
  return records.filter((record) => {
    if (record.host) return false
    if (!cfg.liveStatuses.includes(record.status)) return false
    if (cfg.exclude.tools.includes(record.tool)) return false
    return allowed(record)
  })
}

export interface SourceFile {
  /** Where it is on this machine. */
  abs: string
  /** Its path below the home, which is also its path in the copy. */
  rel: string
  kind: 'lines' | 'sqlite'
  subagent: boolean
  size: number
  mtime: number
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function fileAt(home: string, abs: string, kind: SourceFile['kind'], subagent = false) {
  try {
    const stat = statSync(abs)
    if (!stat.isFile()) return null
    let mtime = stat.mtimeMs
    if (kind === 'sqlite') {
      try {
        mtime = Math.max(mtime, statSync(`${abs}-wal`).mtimeMs)
      } catch {}
    }
    return { abs, rel: relative(home, abs), kind, subagent, size: stat.size, mtime } as SourceFile
  } catch {
    return null
  }
}

/** The tool's own files for a conversation, the main one first. Nothing a tool doesn't keep in a file. */
export function transcriptFiles(
  tool: string,
  resumeId: string | null,
  createdAt: number | null,
  home: string,
  now: number,
): SourceFile[] {
  if (!resumeId || !SESSION.test(resumeId)) return []
  if (tool === 'claude-code') {
    const root = join(home, '.claude', 'projects')
    for (const dir of listDir(root)) {
      const main = fileAt(home, join(root, dir, `${resumeId}.jsonl`), 'lines')
      if (!main) continue
      const subs = join(root, dir, resumeId, 'subagents')
      const found = listDir(subs)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => fileAt(home, join(subs, name), 'lines', true))
        .filter((file): file is SourceFile => file !== null)
      return [main, ...found.sort((a, b) => b.mtime - a.mtime)]
    }
    return []
  }
  if (tool === 'agy') {
    const db = fileAt(
      home,
      join(home, '.gemini', 'antigravity-cli', 'conversations', `${resumeId}.db`),
      'sqlite',
    )
    return db ? [db] : []
  }
  if (tool === 'pi') {
    const root = join(home, '.pi', 'agent', 'sessions')
    for (const dir of listDir(root)) {
      const name = listDir(join(root, dir)).find((entry) => entry.endsWith(`_${resumeId}.jsonl`))
      const found = name ? fileAt(home, join(root, dir, name), 'lines') : null
      if (found) return [found]
    }
    return []
  }
  if (tool === 'codex') {
    const day = 86_400_000
    const from = Math.max(createdAt ?? now, now - 30 * day)
    for (let at = now; at >= from - day; at -= day) {
      const date = new Date(at)
      const folder = join(
        home,
        '.codex',
        'sessions',
        String(date.getFullYear()),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0'),
      )
      const name = listDir(folder).find((entry) => entry.endsWith(`-${resumeId}.jsonl`))
      const found = name ? fileAt(home, join(folder, name), 'lines') : null
      if (found) return [found]
    }
  }
  return []
}

// ---- the receiving side ---------------------------------------------------------------------

export interface HeldOptions {
  dir: string
  cfg: CopiesConfig
  now: number
  /** Free space on the copies' disk, in bytes (a test stands in for the disk). */
  freeBytes?: () => number
}

interface FileEntry {
  session: string
  rel: string
  /** Where these bytes start in the original. */
  offset: number
  length: number
  mode: 'append' | 'replace'
}

const privateDir = (path: string) => {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

function machineDir(dir: string, machine: string): string {
  if (!MACHINE.test(machine)) throw new Refusal(`${machine} is not a machine name`, 2)
  return join(dir, machine)
}

function sessionDir(dir: string, machine: string, session: string): string {
  if (!SESSION.test(session)) throw new Refusal(`${session} is not a session id`, 2)
  return join(machineDir(dir, machine), 'sessions', session)
}

function heldPath(session: string, rel: string): string {
  if (!REL.test(rel) || rel.split('/').some((part) => part === '..' || part === '' || part === '.'))
    throw new Refusal(`${rel} is not a path this copy holds`, 2)
  return join(session, 'files', rel)
}

type Bases = Record<string, number>
function readBases(session: string): Bases {
  try {
    return JSON.parse(readFileSync(join(session, 'bases.json'), 'utf8')) as Bases
  } catch {
    return {}
  }
}
function writeBases(session: string, bases: Bases): void {
  writeFileSync(join(session, 'bases.json'), JSON.stringify(bases), { mode: 0o600 })
}

function freeOf(options: HeldOptions): number {
  if (options.freeBytes) return options.freeBytes()
  const stat = statfsSync(options.dir)
  return Number(stat.bavail) * Number(stat.bsize)
}

interface Walked {
  rel: string
  size: number
  mtime: number
}
function walkFiles(root: string, under = ''): Walked[] {
  const out: Walked[] = []
  for (const name of listDir(join(root, under))) {
    const rel = under ? `${under}/${name}` : name
    try {
      const stat = statSync(join(root, rel))
      if (stat.isDirectory()) out.push(...walkFiles(root, rel))
      else if (stat.isFile()) out.push({ rel, size: stat.size, mtime: stat.mtimeMs })
    } catch {}
  }
  return out
}

export interface Removal {
  at: number
  machine: string
  session: string
  file?: string
  bytes: number
  why: string
}

const REMOVED_LOG_LINES = 200

/** Every removal is a line in removed.log beside the copies; the log keeps its last lines only. */
function logRemovals(dir: string, removals: Removal[]): void {
  if (!removals.length) return
  const path = join(dir, 'removed.log')
  let lines: string[] = []
  try {
    lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  } catch {}
  lines.push(...removals.map((removal) => JSON.stringify(removal)))
  writeFileSync(path, `${lines.slice(-REMOVED_LOG_LINES).join('\n')}\n`, { mode: 0o600 })
}

/**
 * A session over its cap: the oldest subagent files go first, then the conversation loses its oldest
 * lines (down to three quarters of the cap, whole lines, so the next pass need not cut again). A file
 * that can't be cut (a database) goes whole.
 */
function trimSession(
  dir: string,
  machine: string,
  session: string,
  cfg: CopiesConfig,
  now: number,
): Removal[] {
  const root = sessionDir(dir, machine, session)
  const filesRoot = join(root, 'files')
  const cap = cfg.maxSessionMb * MB
  const files = walkFiles(filesRoot)
  let total = files.reduce((sum, file) => sum + file.size, 0)
  if (total <= cap) return []
  const removals: Removal[] = []
  const bases = readBases(root)
  const gone = (file: Walked, why: string) => {
    rmSync(join(filesRoot, file.rel), { force: true })
    delete bases[file.rel]
    total -= file.size
    removals.push({ at: now, machine, session, file: file.rel, bytes: file.size, why })
  }
  for (const file of files
    .filter((entry) => entry.rel.includes('/subagents/'))
    .sort((a, b) => a.mtime - b.mtime)) {
    if (total <= cap) break
    gone(file, 'session over its cap: oldest subagent first')
  }
  for (const file of files
    .filter((entry) => !entry.rel.includes('/subagents/'))
    .sort((a, b) => b.size - a.size)) {
    if (total <= cap) break
    if (!file.rel.endsWith('.jsonl')) {
      gone(file, 'session over its cap: a database can only go whole')
      continue
    }
    const keep = Math.min(file.size, Math.max(0, Math.floor(cap * 0.75) - (total - file.size)))
    const path = join(filesRoot, file.rel)
    const cut = keepTail(path, keep)
    bases[file.rel] = (bases[file.rel] ?? 0) + cut
    total -= cut
    removals.push({
      at: now,
      machine,
      session,
      file: file.rel,
      bytes: cut,
      why: 'session over its cap: oldest lines',
    })
  }
  writeBases(root, bases)
  return removals
}

/** Keeps at most `keep` bytes of a file's end, from a line start; returns how many bytes it dropped. */
function keepTail(path: string, keep: number): number {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    let from = Math.max(0, size - keep)
    let kept = Buffer.alloc(size - from)
    readSync(fd, kept, 0, kept.length, from)
    if (from > 0) {
      const newline = kept.indexOf(10)
      kept = newline >= 0 ? kept.subarray(newline + 1) : kept.subarray(kept.length)
      from = size - kept.length
    }
    writeFileSync(`${path}.tmp`, kept, { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
    return from
  } finally {
    closeSync(fd)
  }
}

/** The copies whose session is gone from its machine's list: since when, and what was last known of it. */
type EndedRecords = Record<string, { at: number; session: CopySession | null }>
function readEnded(machineRoot: string): EndedRecords {
  try {
    return JSON.parse(readFileSync(join(machineRoot, 'ended.json'), 'utf8')) as EndedRecords
  } catch {
    return {}
  }
}

/** A new list from a machine: a copy whose session left it starts its time now; one that came back stops. */
function noteEnded(machineRoot: string, next: CopySnapshot, now: number): void {
  const before = readSnapshot(join(machineRoot, 'snapshot.json'))
  const known = new Map(before?.sessions.map((session) => [session.id, session]))
  const live = new Set(next.sessions.map((session) => session.id))
  const held = listDir(join(machineRoot, 'sessions'))
  const was = readEnded(machineRoot)
  const ended: EndedRecords = {}
  for (const id of held) {
    if (live.has(id)) continue
    ended[id] = was[id] ?? { at: now, session: known.get(id) ?? null }
  }
  const path = join(machineRoot, 'ended.json')
  writeFileSync(`${path}.tmp`, JSON.stringify(ended), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

function readSnapshot(path: string): CopySnapshot | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as CopySnapshot
    return value && Array.isArray(value.sessions) ? value : null
  } catch {
    return null
  }
}

/**
 * The rule that keeps the copies bounded. A session its machine no longer runs goes keepEndedHours after it
 * left that machine's list, counted only on a pass from that machine: a machine that is off keeps its last
 * copy however long it stays off. Over maxTotalMb, or with the disk under minFreeMb, the ended copies go
 * oldest first; only the total cap may then take a live session's copy. Everything removed is logged.
 */
export function pruneCopies(options: HeldOptions, from: string | null): Removal[] {
  const { dir, cfg, now } = options
  const removals: Removal[] = []
  interface Held {
    machine: string
    session: string
    path: string
    bytes: number
    newest: number
    /** When it left its machine's list; null while it hasn't. */
    endedAt: number | null
  }
  let held: Held[] = []
  for (const machine of listDir(dir)) {
    if (!MACHINE.test(machine)) continue
    const root = join(dir, machine, 'sessions')
    const ended = readEnded(join(dir, machine))
    for (const session of listDir(root)) {
      const path = join(root, session)
      const files = walkFiles(path)
      held.push({
        machine,
        session,
        path,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
        newest: files.reduce((newest, file) => Math.max(newest, file.mtime), 0),
        endedAt: ended[session]?.at ?? null,
      })
    }
  }
  const remove = (entry: Held, why: string) => {
    rmSync(entry.path, { recursive: true, force: true })
    removals.push({
      at: now,
      machine: entry.machine,
      session: entry.session,
      bytes: entry.bytes,
      why,
    })
  }
  const keepMs = cfg.keepEndedHours * 3_600_000
  held = held.filter((entry) => {
    if (entry.endedAt === null || entry.machine !== from || now - entry.endedAt <= keepMs)
      return true
    remove(entry, `ended more than ${cfg.keepEndedHours} hours ago`)
    return false
  })
  const live = (entry: Held) => entry.endedAt === null
  held.sort((a, b) => Number(live(a)) - Number(live(b)) || a.newest - b.newest)
  let total = held.reduce((sum, entry) => sum + entry.bytes, 0)
  const cap = cfg.maxTotalMb * MB
  let freed = 0
  const floor = cfg.minFreeMb * MB
  for (const entry of held) {
    const overCap = total > cap
    const lowDisk = !live(entry) && freeOf(options) + freed < floor
    if (!overCap && !lowDisk) continue
    remove(
      entry,
      overCap ? `copies over ${cfg.maxTotalMb} MB` : `disk under ${cfg.minFreeMb} MB free`,
    )
    total -= entry.bytes
    freed += options.freeBytes ? entry.bytes : 0
  }
  return removals
}

function prepareDir(dir: string): void {
  privateDir(dir)
  // restic skips a folder holding this (backup-drive.ts): nothing here goes to a backup or to Drive.
  const marker = join(dir, '.nobackup')
  if (!existsSync(marker)) writeFileSync(marker, '', { mode: 0o600 })
}

export interface SizesAnswer {
  freeMb: number
  files: Record<string, { base: number; end: number; tail: string; tailLen: number }>
}

const fileKey = (session: string, rel: string) => `${session}\n${rel}`

function tailHash(path: string, size: number): { tail: string; tailLen: number } {
  const tailLen = Math.min(TAIL_BYTES, size)
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.alloc(tailLen)
    readSync(fd, chunk, 0, tailLen, size - tailLen)
    return { tail: createHash('sha1').update(chunk).digest('hex'), tailLen }
  } finally {
    closeSync(fd)
  }
}

/** The peer's answer to "what do you hold of these files": how far each goes and a check of its last bytes. */
export function answerSizes(
  input: { from: string; files: { session: string; rel: string }[] },
  options: HeldOptions,
): SizesAnswer {
  prepareDir(options.dir)
  const answer: SizesAnswer = { freeMb: Math.floor(freeOf(options) / MB), files: {} }
  for (const { session, rel } of input.files) {
    const root = sessionDir(options.dir, input.from, session)
    const path = join(options.dir, input.from, 'sessions', heldPath(session, rel))
    try {
      const size = statSync(path).size
      const base = readBases(root)[rel] ?? 0
      answer.files[fileKey(session, rel)] = { base, end: base + size, ...tailHash(path, size) }
    } catch {}
  }
  return answer
}

export interface ReceiveAnswer {
  written: number
  skipped: number
  removed: Removal[]
  lowDisk: boolean
}

/**
 * One batch from a peer: a JSON line (the machine, its files and maybe its snapshot), then those files'
 * bytes in order. A file's bytes that don't land exactly where the copy ends are not written; the
 * sender's next look at the sizes puts it right. Below the disk floor no file is written, the snapshot is.
 */
export function receiveBatch(input: Buffer, options: HeldOptions): ReceiveAnswer {
  const { dir, cfg, now } = options
  const newline = input.indexOf(10)
  if (newline < 0) throw new Refusal('session copy: no header', 2)
  const header = JSON.parse(input.subarray(0, newline).toString('utf8')) as {
    from: string
    files: FileEntry[]
    snapshot?: CopySnapshot
  }
  prepareDir(dir)
  const machineRoot = machineDir(dir, header.from)
  privateDir(machineRoot)
  privateDir(join(machineRoot, 'sessions'))
  const answer: ReceiveAnswer = { written: 0, skipped: 0, removed: [], lowDisk: false }
  // Logged as they go: a later refusal in this batch mustn't lose what was already removed.
  const removedNow = (removals: Removal[]) => {
    logRemovals(dir, removals)
    answer.removed.push(...removals)
  }
  // The list first: a copy's time runs on the machine's newest word, and a session back on it keeps its copy.
  if (header.snapshot) {
    noteEnded(machineRoot, header.snapshot, now)
    const path = join(machineRoot, 'snapshot.json')
    writeFileSync(`${path}.tmp`, JSON.stringify(header.snapshot), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  }
  removedNow(pruneCopies(options, header.snapshot ? header.from : null))
  answer.lowDisk = freeOf(options) < cfg.minFreeMb * MB
  let at = newline + 1
  const touched = new Set<string>()
  for (const entry of header.files) {
    const bytes = input.subarray(at, at + entry.length)
    at += entry.length
    if (bytes.length !== entry.length) throw new Refusal('session copy: a batch ended early', 2)
    const root = sessionDir(dir, header.from, entry.session)
    const path = join(machineRoot, 'sessions', heldPath(entry.session, entry.rel))
    if (answer.lowDisk) {
      answer.skipped++
      continue
    }
    for (const parent of [root, join(root, 'files')]) privateDir(parent)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const bases = readBases(root)
    if (entry.mode === 'replace') {
      writeFileSync(`${path}.tmp`, bytes, { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
      bases[entry.rel] = entry.offset
      writeBases(root, bases)
    } else {
      // Removed since the sender looked: its next look sends it again.
      if (!existsSync(path)) {
        answer.skipped++
        continue
      }
      const fd = openSync(path, 'r+')
      try {
        const size = fstatSync(fd).size
        if ((bases[entry.rel] ?? 0) + size !== entry.offset) {
          answer.skipped++
          continue
        }
        writeSync(fd, bytes, 0, bytes.length, size)
      } finally {
        closeSync(fd)
      }
    }
    answer.written += entry.length
    touched.add(entry.session)
  }
  for (const session of touched) removedNow(trimSession(dir, header.from, session, cfg, now))
  if (header.snapshot) removedNow(pruneCopies(options, header.from))
  return answer
}

/** What this machine holds of every other machine, newest pass first. */
export function readHeld(dir: string): HeldMachine[] {
  const machines: HeldMachine[] = []
  for (const machine of listDir(dir)) {
    if (!MACHINE.test(machine)) continue
    const snapshot = readSnapshot(join(dir, machine, 'snapshot.json'))
    if (!snapshot) continue
    const heldOf = (session: CopySession, endedAt: number | null): HeldSession => {
      const root = join(dir, machine, 'sessions', session.id, 'files')
      const files = walkFiles(root)
      if (!files.length) return { ...session, endedAt, copy: null }
      const bases = readBases(join(dir, machine, 'sessions', session.id))
      return {
        ...session,
        endedAt,
        copy: {
          bytes: files.reduce((sum, file) => sum + file.size, 0),
          files: files.length,
          cut: Object.values(bases).some((base) => base > 0),
          newest: files.reduce((newest, file) => Math.max(newest, file.mtime), 0),
          path: root,
        },
      }
    }
    // A copy still kept of a session that ended is still readable: it may be what the owner is after.
    const ended = Object.values(readEnded(join(dir, machine))).flatMap((entry) =>
      entry.session ? [heldOf(entry.session, entry.at)].filter((held) => held.copy) : [],
    )
    machines.push({
      machine,
      at: snapshot.at,
      sessions: [...snapshot.sessions.map((session) => heldOf(session, null)), ...ended],
    })
  }
  return machines.sort((a, b) => b.at - a.at)
}

// ---- the sending side -----------------------------------------------------------------------

export interface CopyPeer {
  name: string
  call(
    args: string[],
    input: Buffer,
  ): Promise<{ code: number; stdout: string; output: string; ended: boolean }>
}

export interface SendDeps {
  cfg: CopiesConfig
  machine: string
  home: string
  statePath: string
  now(): number
  /** Tether's live sessions and which conversation each holds; null while Tether doesn't answer. */
  sessions(): LiveRecord[] | null
  /** A root's work role by request id; null when it can't be read. */
  roles(): ReadonlyMap<string, string | null> | null
  resumeIds(): ReadonlyMap<string, string>
  /** The last things said in a conversation, as the session history reads them. */
  said(tool: string, resumeId: string): { owner: Said | null; agent: Said | null }
  git(root: string): CopySession['git']
  peers(): { peers: CopyPeer[]; off: string | null }
  /** Sends these projects' uncommitted work through the repo copies. */
  wip(projects: string[]): void
}

interface SentState {
  /** What each peer last took whole. */
  peers: Record<string, string>
  /** Each database's look when last sent, per peer and file. */
  sent: Record<string, string>
  /** What was last read from each session's conversation, by its size. */
  said: Record<string, { size: number; owner: Said | null; agent: Said | null }>
  /** Each session's conversation size at the end of the last pass: what "active since" means. */
  sizes: Record<string, number>
}

function readSent(path: string): SentState {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<SentState>
    return {
      peers: value.peers ?? {},
      sent: value.sent ?? {},
      said: value.said ?? {},
      sizes: value.sizes ?? {},
    }
  } catch {
    return { peers: {}, sent: {}, said: {}, sizes: {} }
  }
}

function writeSent(path: string, state: SentState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 })
  renameSync(`${path}.tmp`, path)
}

interface Planned {
  session: string
  file: SourceFile
  /** The bytes go from here to the file's end (a whole line boundary when it was cut). */
  from: number
  mode: FileEntry['mode']
}

/** Empty when the file went away since it was listed: the tool removed it, not a failure. */
function readRange(path: string, from: number, length: number): Buffer {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return Buffer.alloc(0)
  }
  try {
    const chunk = Buffer.alloc(length)
    const got = readSync(fd, chunk, 0, length, from)
    return chunk.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

/** Where a too-long conversation's copy starts: the first whole line within the cap. */
function cutPoint(file: SourceFile, cap: number): number {
  if (file.size <= cap) return 0
  const start = file.size - cap
  const newline = readRange(file.abs, start, cap).indexOf(10)
  return newline >= 0 ? start + newline + 1 : file.size
}

/** A clean copy of a database that is in use, in a throwaway folder. */
function sqliteCopy(path: string): { bytes: Buffer } | { error: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aico-shift-'))
  try {
    const out = join(dir, 'copy.db')
    snapshotDatabase(path, out)
    return { bytes: readFileSync(out) }
  } catch (error) {
    return { error: (error as Error).message }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface PassReport {
  lines: string[]
  failed: boolean
  /** Whether any peer was asked anything. */
  contacted: boolean
}

/** One pass: nothing leaves, and no peer is asked anything, while nothing changed. */
export async function sendPass(deps: SendDeps): Promise<PassReport> {
  const { cfg, machine, home } = deps
  const now = deps.now()
  const found = deps.peers()
  if (found.off) return { lines: [found.off], failed: false, contacted: false }
  const records = deps.sessions()
  if (!records)
    return {
      lines: [`${machine}: sessions couldn't be read; the next run catches up`],
      failed: false,
      contacted: false,
    }
  const roles = deps.roles()
  // Without roles the hunting rule can't be read, and a session leaving the list looks like it ended.
  if (!roles)
    return {
      lines: [`${machine}: roles couldn't be read; the next run catches up`],
      failed: false,
      contacted: false,
    }
  const state = readSent(deps.statePath)
  const live = eligibleSessions(records, roles, cfg)
  const resume = deps.resumeIds()
  const windowMs = cfg.activeWindowMin * 60_000
  const facts = live.map((record) => {
    const resumeId = resume.get(record.id) ?? null
    const files = transcriptFiles(record.tool, resumeId, record.createdAt ?? null, home, now)
    // Only what's moving: a subagent long finished is not sent, however long its session has lived.
    const kept = files.filter((file) => !file.subagent || now - file.mtime <= windowMs)
    return { record, resumeId, files: kept }
  })
  const signature = createHash('sha1')
    .update(
      JSON.stringify(
        facts.map(({ record, files }) => [
          record.id,
          record.state,
          record.doing,
          record.displayTitle,
          record.waitingOn,
          record.asks?.length ?? 0,
          files.map((file) => [file.rel, file.size, file.mtime]),
        ]),
      ),
    )
    .digest('hex')
  const due = found.peers.filter((peer) => state.peers[peer.name] !== signature)
  if (!due.length)
    return { lines: [`${machine}: nothing changed`], failed: false, contacted: false }

  const sessions: CopySession[] = facts.map(({ record, resumeId, files }) => {
    const main = files[0]
    let said = state.said[record.id] ?? { size: -1, owner: null, agent: null }
    if (main && resumeId && cfg.historyTools.includes(record.tool) && said.size !== main.size) {
      const read = deps.said(record.tool, resumeId)
      said = {
        size: main.size,
        owner: read.owner ?? said.owner,
        agent: read.agent ?? said.agent,
      }
    }
    state.said[record.id] = said
    const root = record.projectRoot ?? null
    return {
      id: record.id,
      tool: record.tool,
      resumeId,
      title: maskSecrets(record.displayTitle || record.label || record.name || record.id),
      project: record.projectId ?? null,
      cwd: root,
      state: record.state ?? 'unknown',
      detail: record.stateDetail ? maskSecrets(record.stateDetail) : null,
      doing: record.doing ? clip(maskSecrets(record.doing), cfg.messageChars) : null,
      waitingOn: typeof record.waitingOn === 'string' ? maskSecrets(record.waitingOn) : null,
      needsYou: record.state === 'blocked' || (record.asks?.length ?? 0) > 0,
      lastActivity: main ? Math.round(main.mtime) : (record.stateAt ?? null),
      createdAt: record.createdAt ?? null,
      lastOwner: said.owner,
      lastAgent: said.agent,
      git: root ? deps.git(root) : null,
    }
  })
  const snapshot: CopySnapshot = { v: 1, machine, at: now, sessions }
  const liveIds = new Set(facts.map(({ record }) => record.id))
  for (const id of Object.keys(state.said)) if (!liveIds.has(id)) delete state.said[id]
  for (const key of Object.keys(state.sent))
    if (!liveIds.has(key.split('\n')[1] ?? '')) delete state.sent[key]

  const report: PassReport = { lines: [], failed: false, contacted: true }
  let reached = false
  for (const peer of due) {
    const outcome = await sendToPeer(deps, peer, facts, snapshot, state, signature)
    report.lines.push(`${peer.name}: ${outcome.line}`)
    report.failed ||= outcome.failed
    reached ||= outcome.reached
  }
  const active: string[] = []
  for (const { record, files } of facts) {
    const size = files.reduce((sum, file) => sum + file.size, 0)
    if (state.sizes[record.id] === size) continue
    if (record.projectId && PROJECT.test(record.projectId)) active.push(record.projectId)
  }
  // Unreached, these still count as moved: the uncommitted work goes once the peer answers.
  if (reached)
    state.sizes = Object.fromEntries(
      facts.map(({ record, files }) => [
        record.id,
        files.reduce((sum, file) => sum + file.size, 0),
      ]),
    )
  writeSent(deps.statePath, state)
  if (reached && active.length) deps.wip([...new Set(active)])
  return report
}

async function sendToPeer(
  deps: SendDeps,
  peer: CopyPeer,
  facts: { record: LiveRecord; files: SourceFile[] }[],
  snapshot: CopySnapshot,
  state: SentState,
  signature: string,
): Promise<{ line: string; failed: boolean; reached: boolean }> {
  const { cfg, machine } = deps
  const now = deps.now()
  const offLine = {
    line: 'not connected; the next run catches it up',
    failed: false,
    reached: false,
  }
  const notYet = (answer: { output: string }) => /unknown command/i.test(answer.output)
  const wanted = facts.flatMap(({ record, files }) =>
    files.map((file) => ({ session: record.id, rel: file.rel })),
  )
  const asked = await peer.call(
    ['sizes', '--from', machine],
    Buffer.from(JSON.stringify({ from: machine, files: wanted })),
  )
  if (!asked.ended) return offLine
  if (notYet(asked))
    return {
      line: "doesn't have this Aico release yet; the next run catches it up",
      failed: false,
      reached: false,
    }
  // A command cut off by the machine going down reports an exit too: it only counts if the peer still answers.
  const stillThere = async () =>
    (
      await peer.call(
        ['sizes', '--from', machine],
        Buffer.from(JSON.stringify({ from: machine, files: [] })),
      )
    ).ended
  let theirs: SizesAnswer | null = null
  try {
    theirs = JSON.parse(lastLine(asked.stdout)) as SizesAnswer
  } catch {}
  if ((asked.code !== 0 || !theirs) && !(await stillThere())) return offLine
  if (asked.code !== 0 || !theirs)
    return {
      line: `couldn't read its copies (${lastLine(asked.output) || `exit ${asked.code}`})`,
      failed: true,
      reached: true,
    }
  const lowDisk = theirs.freeMb < cfg.minFreeMb
  const cap = cfg.maxSessionMb * MB
  const windowMs = cfg.activeWindowMin * 60_000
  const planned: Planned[] = []
  for (const { record, files } of facts) {
    let room = cap
    for (const file of files) {
      const held = theirs.files[fileKey(record.id, file.rel)]
      const look = `${file.size}:${file.mtime}`
      const lookKey = `${peer.name}\n${record.id}\n${file.rel}`
      // Long idle and never copied: its conversation stays home until it moves again.
      if (!held && now - file.mtime > windowMs) continue
      if (file.kind === 'sqlite') {
        // A database goes whole: one too big for a pass or the cap stays home, and isn't retried each pass.
        if (file.size > Math.min(cap, cfg.maxPassMb * MB)) continue
        room -= file.size
        if (!held || state.sent[lookKey] !== look)
          planned.push({ session: record.id, file, from: 0, mode: 'replace' })
        continue
      }
      const counted = Math.min(file.size, room)
      if (counted <= 0 || (file.subagent && file.size > room)) continue
      room -= counted
      if (held && held.end <= file.size) {
        const start = held.end - held.tailLen
        const same =
          createHash('sha1')
            .update(readRange(file.abs, start, held.tailLen))
            .digest('hex') === held.tail
        if (same) {
          if (held.end < file.size)
            planned.push({ session: record.id, file, from: held.end, mode: 'append' })
          continue
        }
      }
      // A rewritten file, or one the copy doesn't have: from the start, or the part within the cap.
      planned.push({ session: record.id, file, from: cutPoint(file, cap), mode: 'replace' })
    }
  }
  let budget = lowDisk ? 0 : cfg.maxPassMb * MB
  const batchLimit = cfg.batchMb * MB
  let sent = 0
  let incomplete = lowDisk && planned.length > 0
  let removed = 0
  let notCopied = 0
  let refused = false
  let entries: FileEntry[] = []
  let parts: Buffer[] = []
  let batchBytes = 0
  let dropped = false
  const looks: [string, string][] = []
  const flush = async (last: boolean): Promise<string | null> => {
    const header = {
      from: machine,
      files: entries,
      ...(last ? { snapshot } : {}),
    }
    const input = Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), ...parts])
    const answered = await peer.call(['receive', '--from', machine], input)
    entries = []
    parts = []
    batchBytes = 0
    if (!answered.ended) {
      dropped = true
      return null
    }
    let parsed: ReceiveAnswer | null = null
    try {
      parsed = JSON.parse(lastLine(answered.stdout)) as ReceiveAnswer
    } catch {}
    if ((answered.code !== 0 || !parsed) && !(await stillThere())) {
      dropped = true
      return null
    }
    if (answered.code !== 0 || !parsed)
      return `couldn't take the copy (${lastLine(answered.output) || `exit ${answered.code}`})`
    sent += parsed.written
    removed += parsed.removed.length
    if (parsed.skipped) {
      incomplete = true
      refused = true
    }
    return null
  }
  for (const item of planned) {
    if (budget <= 0) {
      incomplete = true
      break
    }
    if (item.file.kind === 'sqlite') {
      const copy = sqliteCopy(item.file.abs)
      // Copied again when it next changes, not on every pass.
      if ('error' in copy) {
        notCopied++
        continue
      }
      if (copy.bytes.length > budget) {
        if (copy.bytes.length <= cfg.maxPassMb * MB) incomplete = true
        else notCopied++
        continue
      }
      entries.push({
        session: item.session,
        rel: item.file.rel,
        offset: 0,
        length: copy.bytes.length,
        mode: 'replace',
      })
      parts.push(copy.bytes)
      batchBytes += copy.bytes.length
      budget -= copy.bytes.length
      looks.push([
        `${peer.name}\n${item.session}\n${item.file.rel}`,
        `${item.file.size}:${item.file.mtime}`,
      ])
    } else {
      let from = item.from
      let mode = item.mode
      while (from < item.file.size && budget > 0) {
        const length = Math.min(item.file.size - from, batchLimit - batchBytes, budget)
        const bytes = readRange(item.file.abs, from, length)
        if (!bytes.length) break
        entries.push({
          session: item.session,
          rel: item.file.rel,
          offset: from,
          length: bytes.length,
          mode,
        })
        parts.push(bytes)
        batchBytes += bytes.length
        budget -= bytes.length
        from += bytes.length
        mode = 'append'
        if (batchBytes >= batchLimit) {
          const failure = await flush(false)
          if (failure) return { line: failure, failed: true, reached: true }
          if (dropped) return { ...offLine, line: 'the link dropped; the next run catches it up' }
        }
      }
      if (from < item.file.size) incomplete = true
    }
    if (batchBytes >= batchLimit) {
      const failure = await flush(false)
      if (failure) return { line: failure, failed: true, reached: true }
      if (dropped) return { ...offLine, line: 'the link dropped; the next run catches it up' }
    }
  }
  const failure = await flush(true)
  if (failure) return { line: failure, failed: true, reached: true }
  if (dropped) return { ...offLine, line: 'the link dropped; the next run catches it up' }
  // Under the disk floor the peer may have skipped a database: only what surely landed counts as sent.
  if (!refused) for (const [key, look] of looks) state.sent[key] = look
  if (!incomplete) state.peers[peer.name] = signature
  const said = [
    `${snapshot.sessions.length} session${snapshot.sessions.length === 1 ? '' : 's'}, ${sizeWord(sent)} sent`,
  ]
  if (removed) said.push(`${removed} old cop${removed === 1 ? 'y' : 'ies'} removed`)
  if (notCopied) said.push(`${notCopied} database${notCopied === 1 ? '' : 's'} couldn't be copied`)
  if (lowDisk) said.push(`its disk is under ${cfg.minFreeMb} MB free, only the list went`)
  else if (incomplete) said.push('the rest goes next run')
  return { line: said.join(', '), failed: false, reached: true }
}

// ---- the real world -------------------------------------------------------------------------

function tetherJson(cfg: CopiesConfig, env: NodeJS.ProcessEnv, args: string[]): unknown {
  const bin = env.TETHER_BIN || expandHome(cfg.tetherBin)
  const done = spawnSync(bin, ['--json', ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * MB,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000,
  })
  if (done.status !== 0) return null
  try {
    return JSON.parse(done.stdout)
  } catch {
    return null
  }
}

const itemsOf = (value: unknown): Record<string, unknown>[] | null => {
  const items = (value as { items?: unknown } | null)?.items
  return Array.isArray(items) ? (items as Record<string, unknown>[]) : null
}

/** The last owner message and agent message in the session history's tail. Never a text the tool or Tether injected. */
export function saidFromEvents(
  events: { at: number | null; role: string; kind: string; text: string }[],
  chars: number,
): { owner: Said | null; agent: Said | null } {
  const shown = (event: { at: number | null; text: string }) => ({
    at: event.at,
    text: clip(maskSecrets(event.text.trim().replace(/\s+/g, ' ')), chars),
  })
  let owner: Said | null = null
  let agent: Said | null = null
  for (let i = events.length - 1; i >= 0 && !(owner && agent); i--) {
    const event = events[i] as (typeof events)[number]
    if (event.kind !== 'text' || !event.text.trim()) continue
    if (!owner && event.role === 'user' && !/^\s*(<|Tether |Recovery: )/.test(event.text))
      owner = shown(event)
    if (!agent && event.role === 'assistant') agent = shown(event)
  }
  return { owner, agent }
}

function gitFacts(git: Runner, root: string): CopySession['git'] {
  const options = { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }
  const branch = git('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], options)
  if (branch.code) return null
  const head = git('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], options)
  const status = git(
    'git',
    ['-C', root, 'status', '--porcelain=v1', '--untracked-files=normal'],
    options,
  )
  return {
    branch: branch.out.trim(),
    head: head.out.trim(),
    dirty: status.out.split('\n').filter(Boolean).length,
  }
}

function realPeers(env: NodeJS.ProcessEnv, cfg: CopiesConfig): SendDeps['peers'] {
  return () => {
    const settings = readSettings(env, '')
    if (!settings) return { peers: [], off: 'Off: this machine is not part of a fleet.' }
    const found = fullPeers(settings, readPins(settings.allowlist))
    if (found.role !== 'full')
      return { peers: [], off: 'Off: only a full Aico machine sends session copies.' }
    if (!found.peers.length)
      return { peers: [], off: 'Off: no other full Aico on other hardware to copy sessions to.' }
    return {
      off: null,
      peers: found.peers.map((peer) => ({
        name: peer.name,
        call: (args, input) =>
          requestExec(
            peer.exec,
            ['sh', '-c', `cd "$HOME" && ${cfg.peerAico} shift ${args.map(sq).join(' ')}`],
            input,
          ),
      })),
    }
  }
}

function realDeps(env: NodeJS.ProcessEnv, cfg: CopiesConfig): SendDeps {
  return {
    cfg,
    machine: machineId(),
    home: env.HOME || homedir(),
    statePath: expandHome(cfg.state),
    now: () => Date.now(),
    sessions: () => itemsOf(tetherJson(cfg, env, ['sessions', 'list'])) as LiveRecord[] | null,
    roles: () => {
      const listed = tetherJson(cfg, env, ['roots', 'list']) as { roots?: unknown } | null
      if (!Array.isArray(listed?.roots)) return null
      const items = listed.roots as Record<string, unknown>[]
      return new Map(
        items.map((item) => [
          String(item.requestId),
          (item.workRole as string | null | undefined) ?? null,
        ]),
      )
    },
    resumeIds: () => {
      try {
        const snapshot = JSON.parse(readFileSync(expandHome(cfg.continuity), 'utf8')) as {
          sessions?: { id: string; resumeId: string | null }[]
        }
        return new Map(
          (snapshot.sessions ?? [])
            .filter((entry) => entry.resumeId)
            .map((entry) => [entry.id, entry.resumeId as string]),
        )
      } catch {
        return new Map()
      }
    },
    said: (tool, resumeId) => {
      const page = tetherJson(cfg, env, [
        'history',
        'events',
        `${tool}:${resumeId}`,
        '--limit',
        '200',
      ])
      const items = itemsOf(page) as
        | { at: number | null; role: string; kind: string; text: string }[]
        | null
      return items ? saidFromEvents(items, cfg.messageChars) : { owner: null, agent: null }
    },
    git: (root) => gitFacts(shell, root),
    peers: realPeers(env, cfg),
    wip: (projects) => {
      shell(process.argv[0] as string, [process.argv[1] as string, 'wip', 'run', ...projects])
    },
  }
}

function copiesDirFor(machine: string, cfg: CopiesConfig = copiesConfig): string {
  const places = cfg.copiesDir as Record<string, string>
  return expandHome(places[machine] ?? (places['*'] as string))
}

// ---- the command ----------------------------------------------------------------------------

const USAGE = `Usage:
  aico shift list [--json]      what was running on the other machines at their last change
  aico shift show ID [--json]   one of those sessions: what it was doing, where its copy is
  aico shift run                send what changed to the other full machines (runs by itself)
Limits and exclusions: packages/ops/data/session-copies.json. Never a shell or a Neri session.`

const age = (ms: number) => {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

const running = (machine: HeldMachine) =>
  machine.sessions.filter((session) => !session.endedAt).length

export function heldLines(held: HeldMachine[], now: number): string[] {
  if (!held.length) return ['No copies of another machine’s sessions here.']
  const lines: string[] = []
  for (const machine of held) {
    lines.push(
      `${machine.machine}  as of ${localTime(machine.at)} (${age(now - machine.at)} ago)  ${running(machine)} session${running(machine) === 1 ? '' : 's'}`,
    )
    for (const session of machine.sessions) {
      const state = session.endedAt ? 'ended' : session.needsYou ? 'needs-you' : session.state
      const copy = session.copy
        ? `copy ${sizeWord(session.copy.bytes)}${session.copy.cut ? ' (latest part)' : ''}`
        : 'no copy'
      const dirty = session.git?.dirty ? `  ${session.git.dirty} uncommitted` : ''
      lines.push(
        `  ${session.id}  ${state.padEnd(9)} ${session.tool.padEnd(11)} ${(session.project ?? '-').padEnd(14)} ${clip(session.title, 50)}  ${copy}${dirty}`,
      )
    }
  }
  return lines
}

export function showLines(machine: HeldMachine, session: HeldSession): string[] {
  const lines = [
    `${session.title} (${session.id}) on ${machine.machine}, as of ${localTime(machine.at)}`,
    `tool ${session.tool}${session.resumeId ? ` conversation ${session.resumeId}` : ''}`,
    session.endedAt
      ? `ended ${localTime(session.endedAt)}; before that ${session.state}`
      : `state ${session.needsYou ? 'needs-you' : session.state}${session.detail ? `: ${session.detail}` : ''}`,
    `project ${session.project ?? '-'}  ${session.cwd ?? ''}`.trimEnd(),
  ]
  if (session.lastActivity) lines.push(`last activity ${localTime(session.lastActivity)}`)
  if (session.git)
    lines.push(`git ${session.git.branch} ${session.git.head}, ${session.git.dirty} uncommitted`)
  if (session.doing) lines.push(`doing: ${session.doing}`)
  if (session.waitingOn) lines.push(`waiting on: ${session.waitingOn}`)
  if (session.lastOwner) lines.push(`owner said: ${session.lastOwner.text}`)
  if (session.lastAgent) lines.push(`agent said: ${session.lastAgent.text}`)
  lines.push(
    session.copy
      ? `copy ${session.copy.path} (${session.copy.files} file${session.copy.files === 1 ? '' : 's'}, ${sizeWord(session.copy.bytes)}${session.copy.cut ? ', latest part only' : ''})`
      : 'no copy of its conversation here',
  )
  if (session.project)
    lines.push(
      `uncommitted work: aico wip restore ${session.project} --of ${machine.machine} --to DIR`,
    )
  return lines
}

async function readStdin(): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of process.stdin) parts.push(chunk as Buffer)
  return Buffer.concat(parts)
}

export async function shift(argv: string[], env = process.env): Promise<number> {
  const [verb, ...rest] = argv
  const cfg = copiesConfig
  if (!verb || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(USAGE)
    return 0
  }
  const dir = copiesDirFor(machineId(), cfg)
  const options = (): HeldOptions => ({ dir, cfg, now: Date.now() })
  if (verb === 'list') {
    const held = readHeld(dir)
    if (rest.includes('--json')) console.log(JSON.stringify({ machines: held }))
    else console.log(heldLines(held, Date.now()).join('\n'))
    return 0
  }
  if (verb === 'show') {
    const id = rest.find((arg) => !arg.startsWith('-'))
    if (!id) throw new Refusal(USAGE, 2)
    for (const machine of readHeld(dir)) {
      const session = machine.sessions.find(
        (entry) => entry.id === id || entry.resumeId?.startsWith(id),
      )
      if (!session) continue
      if (rest.includes('--json'))
        console.log(JSON.stringify({ machine: machine.machine, at: machine.at, session }))
      else console.log(showLines(machine, session).join('\n'))
      return 0
    }
    throw new Refusal(`No copy of a session ${id} here.`, 1)
  }
  if (verb === 'run') {
    if (rest.length) throw new Refusal(USAGE, 2)
    const report = await sendPass(realDeps(env, cfg))
    console.log(report.lines.join('; '))
    return report.failed ? 1 : 0
  }
  if (verb === 'sizes') {
    const input = JSON.parse((await readStdin()).toString('utf8'))
    console.log(JSON.stringify(answerSizes(input, options())))
    return 0
  }
  if (verb === 'receive') {
    console.log(JSON.stringify(receiveBatch(await readStdin(), options())))
    return 0
  }
  throw new Refusal(`aico shift: unknown command ${verb}\n${USAGE}`, 2)
}
