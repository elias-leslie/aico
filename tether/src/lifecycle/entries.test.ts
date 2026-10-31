import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentStatePoller, AgentStateTracker } from '../agent-state'
import {
  ENTRY_HOME_ENV,
  entryClaudeSession,
  findEntryProcess,
  observeAgent,
  type ProcFs,
} from '../continuity'
import { listenPrivateSocket } from '../http'
import {
  getRootRequest,
  getSessionEntry,
  getWidget,
  removeWidget,
  reserveRootRequest,
  type WidgetRow,
} from './catalog'
import {
  ENTRY_MISSING_EXIT,
  entriesFilePath,
  entryLaunchLine,
  entryProblem,
  resolveEntry,
  sessionEntryHome,
  sessionLaunchLine,
} from './entries'
import { createRootHandler, parseRootCreate, rootRequestDigest } from './root-control'
import { initStore, registerBuiltinTuis } from './testing'

const CLAUDE = '5a7741ea-e6b1-4062-853b-0d9d2e03d549'
const OLD = '6b7741ea-e6b1-4062-853b-0d9d2e03d549'

function procfs(files: Record<string, string>): ProcFs {
  const missing = (path: string) => Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' })
  return {
    readFile: (path) => {
      if (path in files) return files[path] as string
      throw missing(path)
    },
    readHead: (path, bytes) => {
      if (path in files) return (files[path] as string).slice(0, bytes)
      throw missing(path)
    },
    readdir: (path) => {
      const prefix = `${path}/`
      const names = Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split('/')[0] as string)
      if (!names.length) throw missing(path)
      return [...new Set(names)]
    },
    readlink: (path) => {
      throw missing(path)
    },
  }
}

const fixture = mkdtempSync(join(tmpdir(), 'tether-entries-test-'))
const entriesFile = join(fixture, 'entries.json')
const home = join(fixture, 'home')
const env = { TETHER_ENTRIES_FILE: entriesFile, HOME: home }
const enterScript = join(fixture, 'fake-enter')
const enterLog = join(fixture, 'enter.log')

function writeEntries(value: unknown): void {
  writeFileSync(entriesFile, typeof value === 'string' ? value : JSON.stringify(value))
}

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true })
})

describe('entries.json', () => {
  it('resolves argv and the per-arg home, and says why a name is refused', () => {
    expect(entriesFilePath({ XDG_CONFIG_HOME: '/c' })).toBe('/c/tether/entries.json')
    expect(entriesFilePath({ HOME: '/h' })).toBe('/h/.config/tether/entries.json')
    rmSync(entriesFile, { force: true })
    expect(resolveEntry({ name: 'hunt', arg: 'case-1' }, env)).toMatchObject({
      kind: 'unknown_entry',
    })
    writeEntries({
      hunt: { argv: ['/opt/enter', '--fixed'], home: '~/.local/state/hunt/{arg}/home' },
      abs: { argv: ['/opt/enter'], home: '/srv/h/{arg}' },
      relative: { argv: ['enter'], home: '/srv/h/{arg}' },
      nohome: { argv: ['/opt/enter'], home: '/srv/h' },
      noargv: { argv: [], home: '/srv/h/{arg}' },
    })
    expect(resolveEntry({ name: 'hunt', arg: 'case-1' }, env)).toEqual({
      kind: 'ok',
      entry: {
        argv: ['/opt/enter', '--fixed'],
        home: join(home, '.local/state/hunt/case-1/home'),
      },
    })
    expect(resolveEntry({ name: 'abs', arg: 'c2' }, env)).toEqual({
      kind: 'ok',
      entry: { argv: ['/opt/enter'], home: '/srv/h/c2' },
    })
    expect(resolveEntry({ name: 'other', arg: 'c' }, env)).toMatchObject({
      kind: 'unknown_entry',
      reason: expect.stringContaining('other is not in'),
    })
    // An inherited property is not an entry.
    expect(resolveEntry({ name: 'constructor', arg: 'c' }, env).kind).toBe('unknown_entry')
    for (const name of ['relative', 'nohome', 'noargv'])
      expect(resolveEntry({ name, arg: 'c' }, env).kind).toBe('invalid_config')
    writeEntries('{not json')
    expect(resolveEntry({ name: 'hunt', arg: 'c' }, env).kind).toBe('invalid_config')
  })

  it('accepts only a name and a one-word arg', () => {
    expect(entryProblem(undefined)).toBeNull()
    expect(entryProblem({ name: 'neri-hunt', arg: 'case-7' })).toBeNull()
    for (const bad of [
      'neri-hunt',
      [],
      { name: 'neri-hunt' },
      { name: 'neri-hunt', arg: '../x' },
      { name: 'neri-hunt', arg: 'Case' },
      { name: 'neri-hunt', arg: '-x' },
      { name: 'neri-hunt', arg: 'a b' },
      { name: 'neri-hunt', arg: 'x'.repeat(81) },
      { name: 'Neri', arg: 'c' },
      { name: 'neri-hunt', arg: 'c', argv: ['/bin/sh'] },
    ])
      expect(entryProblem(bad)).not.toBeNull()
  })
})

describe('entry launch line', () => {
  it('runs the agent line through the entry with its arg, never on the host directly', () => {
    // A synthetic entry: logs its arguments and its home marker, then runs
    // what follows `--` (a real one would `podman exec` it).
    writeFileSync(
      enterScript,
      `#!/bin/sh\nprintf '%s|' "$@" >"${enterLog}"\nprintf '%s' "$${ENTRY_HOME_ENV}" >>"${enterLog}"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`,
    )
    chmodSync(enterScript, 0o755)
    const line = `printf '%s' "it's $AICO_ROOT_INITIAL_PROMPT" > ${join(fixture, 'agent.out')}`
    const wrapped = entryLaunchLine(
      { argv: [enterScript], home: '/srv/h/case-1/home' },
      'case-1',
      line,
    )
    execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', wrapped], {
      env: { PATH: '/usr/bin:/bin', AICO_ROOT_INITIAL_PROMPT: 'go; $(id) `x`' },
    })
    expect(readFileSync(enterLog, 'utf8')).toBe(`case-1|--|/bin/sh|-c|${line}|/srv/h/case-1/home`)
    // The prompt stays data: expanded inside the entry's shell, never run.
    expect(readFileSync(join(fixture, 'agent.out'), 'utf8')).toBe("it's go; $(id) `x`")
  })
})

describe('root create with entry', () => {
  const socket = join(fixture, 'aico', 'gui.sock')
  const launched = new Set<string>()
  const ensure = vi.fn(async (widgetId: string) => {
    launched.add(widgetId)
  })
  const handle = createRootHandler(
    {
      available: () => true,
      validate: () => true,
      ensure,
      status: async (row: WidgetRow) => (launched.has(row.id) ? 'running' : 'uncertain'),
      mutate: async () => true,
      launchDeferral: () => null,
    },
    40,
  )
  const server = createServer((req, res) => {
    void handle(req, res)
  })
  const saved = process.env.TETHER_ENTRIES_FILE
  beforeAll(async () => {
    registerBuiltinTuis()
    initStore(join(fixture, 'catalog.db'))
    process.env.TETHER_ENTRIES_FILE = entriesFile
    await listenPrivateSocket(server, socket)
  })
  afterAll(async () => {
    if (saved === undefined) delete process.env.TETHER_ENTRIES_FILE
    else process.env.TETHER_ENTRIES_FILE = saved
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  afterEach(() => {
    writeEntries({ 'neri-hunt': { argv: [enterScript], home: `${fixture}/hunt/{arg}/home` } })
  })

  const body = (requestId: string, extra: Record<string, unknown> = {}) => ({
    requestId,
    tool: 'claude-code',
    projectId: 'sample-app',
    projectRoot: fixture,
    initialPrompt: 'Synthetic brief.',
    role: 'sample-root',
    workRole: 'hunting',
    entry: { name: 'neri-hunt', arg: 'case-1' },
    ...extra,
  })
  const call = (payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const client = request({ socketPath: socket, path: '/v1/roots', method: 'POST' }, (res) => {
        let text = ''
        res.on('data', (part: Buffer) => {
          text += part.toString('utf8')
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }))
      })
      client.once('error', reject)
      client.end(JSON.stringify(payload))
    })

  it('keeps the entry on the session, in the digest and on the descriptor', async () => {
    writeEntries({ 'neri-hunt': { argv: [enterScript], home: `${fixture}/hunt/{arg}/home` } })
    const created = await call(body('hunt-1'))
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ entry: { name: 'neri-hunt', arg: 'case-1' } })
    const root = getRootRequest('hunt-1')
    expect(root).toBeDefined()
    const widgetId = root?.widgetId as string
    expect(getSessionEntry(widgetId)).toEqual({ name: 'neri-hunt', arg: 'case-1' })
    expect(sessionEntryHome(widgetId)).toBe(`${fixture}/hunt/case-1/home`)
    // Every launch of the session goes through the entry.
    expect(sessionLaunchLine(widgetId, 'claude --x')).toBe(
      `/usr/bin/env ${ENTRY_HOME_ENV}=${fixture}/hunt/case-1/home ${enterScript} case-1 -- /bin/sh -c 'claude --x'`,
    )
    // A repeat is the same root; the same request without the entry, or with
    // another arg, is a different one.
    expect((await call(body('hunt-1'))).status).toBe(200)
    expect(await call(body('hunt-1', { entry: undefined }))).toEqual({
      status: 409,
      body: { error: 'request_conflict' },
    })
    expect(
      (await call(body('hunt-1', { entry: { name: 'neri-hunt', arg: 'case-2' } }))).status,
    ).toBe(409)
    const plain = parseRootCreate(body('x', { entry: undefined }))
    const withEntry = parseRootCreate(body('x'))
    expect(plain && withEntry && rootRequestDigest(plain) !== rootRequestDigest(withEntry)).toBe(
      true,
    )
    // A normal session is untouched.
    expect(sessionLaunchLine('0000beef', 'claude --x')).toBe('claude --x')
    // The entry goes with the session.
    removeWidget(widgetId)
    expect(getSessionEntry(widgetId)).toBeNull()
  })

  it('refuses an unknown or malformed entry before reserving anything', async () => {
    expect(await call(body('hunt-unknown', { entry: { name: 'nope', arg: 'c' } }))).toEqual({
      status: 400,
      body: {
        error: 'unknown_entry',
        entry: 'nope',
        reason: `nope is not in ${entriesFile}`,
      },
    })
    writeEntries({ 'neri-hunt': { argv: ['relative'], home: '/h/{arg}' } })
    expect(await call(body('hunt-config'))).toMatchObject({
      status: 422,
      body: { error: 'entry_unavailable', entry: 'neri-hunt' },
    })
    expect(await call(body('hunt-bad', { entry: { name: 'neri-hunt', arg: '../x' } }))).toEqual({
      status: 400,
      body: {
        error: 'invalid_body',
        field: 'entry',
        reason: 'entry.arg must match ^[a-z0-9][a-z0-9-]{0,79}$',
      },
    })
    expect(await call(body('hunt-codex', { tool: 'codex' }))).toEqual({
      status: 400,
      body: {
        error: 'invalid_body',
        field: 'entry',
        reason: 'entry runs claude-code sessions only',
      },
    })
    for (const id of ['hunt-unknown', 'hunt-config', 'hunt-bad', 'hunt-codex'])
      expect(getRootRequest(id)).toBeUndefined()
  })

  it('fails closed when the entry left entries.json after the create', () => {
    const widgetId = 'e0e0e0e1'
    reserveRootRequest(
      {
        requestId: 'hunt-gone',
        digest: 'd',
        widgetId,
        logicalSessionId: 'aico-root-gone',
        role: 'r',
        leadRootReference: null,
        facetCapsuleRef: null,
        createdAt: 1,
        origin: 'aico',
      },
      'claude-code',
      'sample-app',
      fixture,
      null,
      null,
      { name: 'neri-hunt', arg: 'case-9' },
    )
    expect(getWidget(widgetId)).toBeDefined()
    writeEntries({})
    const marker = join(fixture, 'host-ran')
    const line = sessionLaunchLine(widgetId, `touch ${marker}`) as string
    const run = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' })
    expect(run.status).toBe(ENTRY_MISSING_EXIT)
    expect(run.stderr).toContain('neri-hunt is not in')
    expect(() => readFileSync(marker)).toThrow()
    expect(sessionEntryHome(widgetId)).toBeNull()
  })
})

describe('entry session state', () => {
  const HOME = '/srv/h/case-1/home'
  const hostFile = (pid: number, sessionId: string, status = 'busy') =>
    JSON.stringify({ pid, sessionId, status, statusUpdatedAt: 5 })
  const containerFile = (pid: number, extra: Record<string, unknown>) =>
    JSON.stringify({ pid, sessionId: CLAUDE, status: 'idle', ...extra })
  const pane = {
    '/proc/10/task/10/children': '11',
    '/proc/11/task/11/children': '12',
    '/proc/12/task/12/children': '',
    '/proc/11/environ': `PATH=/bin\0${ENTRY_HOME_ENV}=${HOME}\0`,
    '/proc/11/stat': '11 (neri-hunt-enter)',
    '/proc/12/environ': `${ENTRY_HOME_ENV}=/elsewhere\0`,
  }

  it('reads Claude from the entry home on the entry process, never the host home', () => {
    const fs = procfs({
      ...pane,
      // A host Claude file for a pid in the pane is ignored for an entry session.
      '/h/.claude/sessions/12.json': hostFile(12, OLD),
      // Container pids: a stale earlier process and the live one.
      [`${HOME}/.claude/sessions/7.json`]: containerFile(7, {
        sessionId: OLD,
        updatedAt: 100,
      }),
      [`${HOME}/.claude/sessions/9.json`]: containerFile(9, {
        status: 'waiting',
        startedAt: 150,
        updatedAt: 200,
      }),
    })
    expect(findEntryProcess(fs, [10, 11, 12])).toEqual({ pid: 11, home: HOME })
    expect(observeAgent(fs, '/h', 10)).toEqual({
      pid: 11,
      resumeId: CLAUDE,
      idle: true,
      blocked: true,
    })
    // No session file yet: nothing observed (the host file is never used).
    const empty = procfs({ ...pane, '/h/.claude/sessions/12.json': hostFile(12, OLD) })
    expect(observeAgent(empty, '/h', 10)).toBeNull()
  })

  it('follows a parked session to its background job file', () => {
    const fs = procfs({
      [`${HOME}/.claude/sessions/9.json`]: containerFile(9, {
        updatedAt: 50,
        parkedJobId: 'job-1',
      }),
      [`${HOME}/.claude/sessions/30.json`]: containerFile(30, {
        kind: 'bg',
        jobId: 'job-1',
        status: 'busy',
        updatedAt: 60,
      }),
      [`${HOME}/.claude/sessions/31.json`]: containerFile(31, { kind: 'bg', updatedAt: 99 }),
      [`${HOME}/.claude/sessions/32.json`]: JSON.stringify({ pid: 99, sessionId: CLAUDE }),
    })
    expect(entryClaudeSession(fs, HOME)?.file).toBe(`${HOME}/.claude/sessions/30.json`)
  })

  it('polls state from the entry home and loses the agent with its entry process', async () => {
    const files: Record<string, string> = {
      ...pane,
      [`${HOME}/.claude/sessions/9.json`]: containerFile(9, {
        status: 'busy',
        statusUpdatedAt: 1,
      }),
    }
    const tracker = new AgentStateTracker(
      () => {},
      () => 1000,
    )
    const poller = new AgentStatePoller(
      tracker,
      { sessions: () => [{ id: 'a', generation: 'g', panePid: async () => 10 }] },
      procfs(files),
      '/h',
      { now: () => 0 },
    )
    await poller.poll()
    expect(tracker.get('a').state).toBe('working')
    files[`${HOME}/.claude/sessions/9.json`] = containerFile(9, {
      status: 'idle',
      statusUpdatedAt: 2,
    })
    await poller.poll()
    expect(tracker.get('a').state).toBe('idle')
    // The entry process exits (the container's agent with it).
    delete files['/proc/11/stat']
    delete files['/proc/11/environ']
    files['/proc/10/task/10/children'] = ''
    await poller.poll()
    expect(tracker.get('a').state).toBe('unknown')
  })

  it('leaves a normal pane to the host home', () => {
    const fs = procfs({
      '/proc/10/task/10/children': '20',
      '/proc/20/task/20/children': '',
      '/proc/20/environ': 'PATH=/bin\0',
      '/h/.claude/sessions/20.json': hostFile(20, CLAUDE),
    })
    expect(observeAgent(fs, '/h', 10)).toMatchObject({ pid: 20, resumeId: CLAUDE })
  })
})
