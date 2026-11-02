import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { AgentStatePoller, AgentStateTracker } from './agent-state'
import { ENTRY_SCAN_DEFAULTS, resolveEntryScanConfig } from './config'
import { ENTRY_HOME_ENV, ENTRY_TOOL_ENV, observeAgent } from './continuity'
import { entryHomeFiles } from './entry-files'
import { entryClaudeSession } from './lifecycle/tui/adapters/claude-code'
import { entryCodexRollout } from './lifecycle/tui/adapters/codex'
import { entryPiSession } from './lifecycle/tui/adapters/pi'
import { nodeProcFs, type ProcFs } from './proc-fs'
import { findClaudeTranscript } from './recovery-facts'

// Two disposable synthetic homes: `inside` is the entry's home, `other` is
// any other directory on the host (another entry's home, the host's own).
// Everything here is written by the test; no real agent file is touched.
const fixture = mkdtempSync(join(tmpdir(), 'tether-entry-files-test-'))
const inside = join(fixture, 'inside')
const other = join(fixture, 'other')
const DAY = join('.codex', 'sessions', '2026', '10', '31')
const OURS = '1c7741ea-e6b1-4062-853b-0d9d2e03d549'
const THEIRS = '2d7741ea-e6b1-4062-853b-0d9d2e03d549'

const PI_DIR = join('.pi', 'agent', 'sessions', '--work--')
const piFile = (id: string) => `2026-10-31T09-00-00-000Z_${id}.jsonl`
const piLine = (role: string, stopReason?: string) =>
  `${JSON.stringify({ type: 'message', timestamp: '2026-10-31T09:00:01.000Z', message: { role, ...(stopReason ? { stopReason, content: [] } : { content: 'x' }) } })}\n`

const meta = (id: string) =>
  `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/work' } })}\n`
const event = (type: string) =>
  `${JSON.stringify({ timestamp: '2026-10-31T09:00:01.000Z', type: 'event_msg', payload: { type } })}\n`

function write(path: string, text: string): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

function contained(home = inside) {
  const files = entryHomeFiles(home)
  if (!files) throw new Error('home refused')
  return files
}

beforeEach(() => {
  rmSync(inside, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
  mkdirSync(inside, { recursive: true })
  // The other home holds a busy Codex thread and a Claude session.
  write(
    join(other, DAY, 'rollout-2026-10-31T09-00-00-theirs.jsonl'),
    meta(THEIRS) + event('task_started'),
  )
  write(
    join(other, '.claude', 'sessions', '9.json'),
    JSON.stringify({ pid: 9, sessionId: THEIRS, status: 'busy', updatedAt: 9 }),
  )
  write(join(other, '.claude', 'projects', 'p', `${THEIRS}.jsonl`), '{"theirs":true}\n')
  // ... and a busy Pi conversation, under its own id and under ours.
  write(join(other, PI_DIR, piFile(THEIRS)), piLine('user'))
  write(join(other, PI_DIR, piFile(OURS)), piLine('user'))
})

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true })
})

describe('entry home containment', () => {
  it('lists no Codex rollout a directory symlink leads outside the home to', () => {
    mkdirSync(join(inside, '.codex'), { recursive: true })
    symlinkSync(join(other, '.codex', 'sessions'), join(inside, '.codex', 'sessions'))
    // A plain read follows the link into the other home: the gap this closes.
    expect(entryCodexRollout(nodeProcFs, inside)?.threadId).toBe(THEIRS)
    const files = contained()
    expect(entryCodexRollout(files.fs, files.home, files.scan)).toBeNull()
    // A deeper directory link (a year) is refused the same way.
    rmSync(join(inside, '.codex', 'sessions'))
    mkdirSync(join(inside, '.codex', 'sessions'))
    symlinkSync(
      join(other, '.codex', 'sessions', '2026'),
      join(inside, '.codex', 'sessions', '2026'),
    )
    expect(entryCodexRollout(files.fs, files.home, files.scan)).toBeNull()
  })

  it('skips rollout symlinks and FIFOs and finds the real rollout inside', () => {
    const day = join(inside, DAY)
    const ours = write(join(day, 'rollout-2026-10-31T08-00-00-ours.jsonl'), meta(OURS))
    // Newer by name than ours: a link to the other home's thread, and a FIFO
    // (opening it must not block the poller).
    symlinkSync(
      join(other, DAY, 'rollout-2026-10-31T09-00-00-theirs.jsonl'),
      join(day, 'rollout-2026-10-31T09-00-00-link.jsonl'),
    )
    execFileSync('/usr/bin/mkfifo', [join(day, 'rollout-2026-10-31T10-00-00-fifo.jsonl')])
    const files = contained()
    expect(entryCodexRollout(files.fs, files.home, files.scan)).toEqual({
      path: join(files.home, DAY, 'rollout-2026-10-31T08-00-00-ours.jsonl'),
      threadId: OURS,
    })
    expect(readFileSync(ours, 'utf8')).toBe(meta(OURS))
  })

  it('stops tailing a rollout once its path is replaced by a link outside', async () => {
    const day = join(inside, DAY)
    const ours = write(
      join(day, 'rollout-2026-10-31T08-00-00-ours.jsonl'),
      meta(OURS) + event('task_started') + event('task_complete'),
    )
    const files = contained()
    expect(files.tail.read(ours, 0, 1 << 20).text).toContain('task_complete')
    // Swapped after it was chosen: the next read is refused, not followed.
    const link = join(day, '.swap')
    symlinkSync(join(other, DAY, 'rollout-2026-10-31T09-00-00-theirs.jsonl'), link)
    renameSync(link, ours)
    expect(() => files.tail.read(ours, 0, 1 << 20)).toThrow()
    expect(() => files.tail.range(ours, 0, 10)).toThrow()
  })

  it('never reads the other home through the poller, before or after a swap', async () => {
    const day = join(inside, DAY)
    const ours = write(
      join(day, 'rollout-2026-10-31T08-00-00-ours.jsonl'),
      meta(OURS) + event('task_started') + event('task_complete'),
    )
    const proc: Record<string, string> = {
      '/proc/10/task/10/children': '11',
      '/proc/11/task/11/children': '',
      '/proc/11/stat': '11 (enter)',
      '/proc/11/environ': `${ENTRY_HOME_ENV}=${inside}\0${ENTRY_TOOL_ENV}=codex\0`,
    }
    const fs: ProcFs = {
      ...nodeProcFs,
      readFile: (path) => {
        if (!path.startsWith('/proc/')) return nodeProcFs.readFile(path)
        if (path in proc) return proc[path] as string
        throw Object.assign(new Error(path), { code: 'ENOENT' })
      },
    }
    const tracker = new AgentStateTracker(
      () => {},
      () => 1000,
    )
    const poller = new AgentStatePoller(
      tracker,
      { sessions: () => [{ id: 'e', generation: 'g', panePid: async () => 10 }] },
      fs,
      '/h',
      { now: () => 0 },
    )
    await poller.poll()
    expect(tracker.get('e')).toMatchObject({ state: 'idle', stateSource: 'codex-rollout' })
    // The other home's thread is busy; ours becomes a link to it.
    const link = join(day, '.swap')
    symlinkSync(join(other, DAY, 'rollout-2026-10-31T09-00-00-theirs.jsonl'), link)
    renameSync(link, ours)
    await poller.poll()
    expect(tracker.get('e').state).not.toBe('working')
    expect(observeAgent(fs, '/h', 10)).toBeNull()
  })

  it('reads Claude session files only inside the home', () => {
    const sessions = join(inside, '.claude', 'sessions')
    mkdirSync(sessions, { recursive: true })
    symlinkSync(join(other, '.claude', 'sessions', '9.json'), join(sessions, '9.json'))
    expect(entryClaudeSession(nodeProcFs, inside)?.state.sessionId).toBe(THEIRS)
    const files = contained()
    expect(entryClaudeSession(files.fs, files.home)).toBeNull()
    // A linked .claude directory is refused as a whole.
    rmSync(join(inside, '.claude'), { recursive: true })
    symlinkSync(join(other, '.claude'), join(inside, '.claude'))
    expect(entryClaudeSession(files.fs, files.home)).toBeNull()
    // A real file inside is read; swapped for a link later, it is not.
    rmSync(join(inside, '.claude'))
    const file = write(
      join(sessions, '7.json'),
      JSON.stringify({ pid: 7, sessionId: OURS, status: 'idle', updatedAt: 1 }),
    )
    expect(entryClaudeSession(files.fs, files.home)?.state.sessionId).toBe(OURS)
    rmSync(file)
    symlinkSync(join(other, '.claude', 'sessions', '9.json'), file)
    expect(() => files.fs.readFile(file)).toThrow()
  })

  it('finds recovery transcripts only inside the home', () => {
    const projects = join(inside, '.claude', 'projects', 'p')
    mkdirSync(projects, { recursive: true })
    symlinkSync(
      join(other, '.claude', 'projects', 'p', `${THEIRS}.jsonl`),
      join(projects, `${THEIRS}.jsonl`),
    )
    const files = contained()
    expect(findClaudeTranscript(files.reader, files.home, THEIRS)).toBeNull()
    expect(files.reader.read(join(projects, `${THEIRS}.jsonl`))).toBeNull()
    write(join(projects, `${OURS}.jsonl`), '{"a":1}\n{"b":2}\n')
    const path = findClaudeTranscript(files.reader, files.home, OURS)
    expect(path).toBe(join(files.home, '.claude', 'projects', 'p', `${OURS}.jsonl`))
    expect(files.reader.read(path as string)).toBe('{"a":1}\n{"b":2}\n')
    expect(files.reader.read(path as string, 9)).toBe('{"b":2}\n')
  })

  it('refuses a home that is itself a link, and resolves a linked parent', () => {
    const linked = join(fixture, 'linked-home')
    rmSync(linked, { force: true })
    symlinkSync(other, linked)
    expect(entryHomeFiles(linked)).toBeNull()
    expect(entryHomeFiles('relative/home')).toBeNull()
    expect(entryHomeFiles(join(fixture, 'missing'))).toBeNull()
    const parent = join(fixture, 'linked-parent')
    rmSync(parent, { force: true })
    symlinkSync(fixture, parent)
    write(join(inside, DAY, 'rollout-2026-10-31T08-00-00-ours.jsonl'), meta(OURS))
    const files = contained(join(parent, 'inside'))
    expect(files.home).toBe(join(realpathSync(fixture), 'inside'))
    expect(entryCodexRollout(files.fs, files.home, files.scan)?.threadId).toBe(OURS)
  })

  it('takes its rollout scan limits from configuration', () => {
    expect(resolveEntryScanConfig({})).toEqual(ENTRY_SCAN_DEFAULTS)
    expect(
      resolveEntryScanConfig({ TETHER_ENTRY_ROLLOUT_SCAN: '10', TETHER_ENTRY_ROLLOUT_OPEN: '2' }),
    ).toEqual({ rolloutScan: 10, rolloutOpen: 2 })
    for (const bad of ['0', '-1', '1.5', 'many'])
      expect(() => resolveEntryScanConfig({ TETHER_ENTRY_ROLLOUT_OPEN: bad })).toThrow(
        /TETHER_ENTRY_ROLLOUT_OPEN/,
      )
    // Opening only the newest: a subagent rollout written last hides the thread.
    const day = join(inside, DAY)
    write(join(day, 'rollout-2026-10-31T08-00-00-ours.jsonl'), meta(OURS))
    write(
      join(day, 'rollout-2026-10-31T09-00-00-sub.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: THEIRS, parent_thread_id: OURS } })}\n`,
    )
    execFileSync('/usr/bin/touch', [
      '-d',
      '2026-10-31T08:00:00Z',
      join(day, 'rollout-2026-10-31T08-00-00-ours.jsonl'),
    ])
    const narrow = entryHomeFiles(inside, { rolloutScan: 10, rolloutOpen: 1 })
    expect(narrow && entryCodexRollout(narrow.fs, narrow.home, narrow.scan)).toBeNull()
    expect(entryCodexRollout(contained().fs, contained().home, contained().scan)?.threadId).toBe(
      OURS,
    )
  })
})

describe('Pi entry home containment', () => {
  const piProc = (id: string): ProcFs => {
    const proc: Record<string, string> = {
      '/proc/10/task/10/children': '11',
      '/proc/11/task/11/children': '',
      '/proc/11/stat': '11 (enter)',
      '/proc/11/environ': `${ENTRY_HOME_ENV}=${inside}\0${ENTRY_TOOL_ENV}=pi\0AICO_ROOT_INITIAL_LAUNCH=1\0AICO_ROOT_RESUME_SESSION_ID=\0AICO_ROOT_FRESH_SESSION_ID=${id}\0`,
    }
    return {
      ...nodeProcFs,
      readFile: (path) => {
        if (!path.startsWith('/proc/')) return nodeProcFs.readFile(path)
        if (path in proc) return proc[path] as string
        throw Object.assign(new Error(path), { code: 'ENOENT' })
      },
      readdir: (path) => {
        if (!path.startsWith('/proc/')) return nodeProcFs.readdir(path)
        if (path === '/proc/10/task') return ['10']
        if (path === '/proc/11/task') return ['11']
        throw Object.assign(new Error(path), { code: 'ENOENT' })
      },
    }
  }

  it('finds only the chosen conversation inside the home, never by scanning elsewhere', () => {
    const ours = write(
      join(inside, PI_DIR, piFile(OURS)),
      piLine('user') + piLine('assistant', 'stop'),
    )
    const files = contained()
    expect(entryPiSession(files.fs, files.home, OURS)).toEqual({ sessionId: OURS, path: ours })
    // Another id is nothing here, though the other home has it.
    expect(entryPiSession(files.fs, files.home, THEIRS)).toEqual({ sessionId: THEIRS, path: null })
    expect(entryPiSession(files.fs, files.home, null)).toBeNull()
    expect(observeAgent(piProc(OURS), '/h', 10)).toEqual({
      pid: 11,
      resumeId: OURS,
      idle: null,
      blocked: false,
    })
    expect(observeAgent(piProc(THEIRS), '/h', 10)).toBeNull()
  })

  it('skips a session file that is a link out of the home, or a FIFO', () => {
    symlinkSync(join(other, PI_DIR), join(inside, '.pi-link'))
    mkdirSync(join(inside, PI_DIR), { recursive: true })
    symlinkSync(join(other, PI_DIR, piFile(OURS)), join(inside, PI_DIR, piFile(OURS)))
    const files = contained()
    expect(entryPiSession(files.fs, files.home, OURS)?.path).toBeNull()
    expect(observeAgent(piProc(OURS), '/h', 10)).toBeNull()
    rmSync(join(inside, PI_DIR, piFile(OURS)))
    execFileSync('/usr/bin/mkfifo', [join(inside, PI_DIR, piFile(OURS))])
    expect(entryPiSession(files.fs, files.home, OURS)?.path).toBeNull()
  })

  it('reads nothing through a replaced ancestor directory', () => {
    write(join(inside, PI_DIR, piFile(OURS)), piLine('assistant', 'stop'))
    expect(observeAgent(piProc(OURS), '/h', 10)?.resumeId).toBe(OURS)
    // .pi swapped for a link to the other home's .pi (which has our id too).
    renameSync(join(inside, '.pi'), join(inside, '.pi-old'))
    symlinkSync(join(other, '.pi'), join(inside, '.pi'))
    expect(observeAgent(piProc(OURS), '/h', 10)).toBeNull()
    const files = contained()
    expect(entryPiSession(files.fs, files.home, OURS)?.path).toBeNull()
    // The sessions/--work-- level swapped the same way.
    rmSync(join(inside, '.pi'))
    renameSync(join(inside, '.pi-old'), join(inside, '.pi'))
    const cwd = join(inside, PI_DIR)
    rmSync(cwd, { recursive: true })
    symlinkSync(join(other, PI_DIR), cwd)
    expect(observeAgent(piProc(OURS), '/h', 10)).toBeNull()
  })

  it('never reads the other home through the poller, before or after a swap', async () => {
    const ours = write(
      join(inside, PI_DIR, piFile(OURS)),
      piLine('user') + piLine('assistant', 'stop'),
    )
    const tracker = new AgentStateTracker(
      () => {},
      () => 1000,
    )
    const poller = new AgentStatePoller(
      tracker,
      { sessions: () => [{ id: 'p', generation: 'g', panePid: async () => 10 }] },
      piProc(OURS),
      '/h',
      { now: () => 0 },
    )
    await poller.poll()
    expect(tracker.get('p')).toMatchObject({ state: 'idle', stateSource: 'pi-session' })
    // Our file swapped for a link to the other home's busy file with our id.
    const link = join(inside, PI_DIR, '.swap')
    symlinkSync(join(other, PI_DIR, piFile(OURS)), link)
    renameSync(link, ours)
    await poller.poll()
    expect(tracker.get('p').state).not.toBe('working')
    // A parent swapped after selection: the tailed path is refused too.
    rmSync(ours)
    write(ours, piLine('assistant', 'stop'))
    const cwd = join(inside, PI_DIR)
    renameSync(cwd, `${cwd}-old`)
    symlinkSync(join(other, PI_DIR), cwd)
    await poller.poll()
    expect(tracker.get('p').state).not.toBe('working')
  })
})
