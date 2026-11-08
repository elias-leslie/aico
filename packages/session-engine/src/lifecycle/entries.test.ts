import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenPrivateSocket } from '@aico/shared/http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentStatePoller, AgentStateTracker } from '../agent-state'
import { ENTRY_HOME_ENV, ENTRY_TOOL_ENV, findEntryProcess, observeAgent } from '../continuity'
import { nodeProcFs, type ProcFs } from '../proc-fs'
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
import { initialLaunchLine, rootLaunchEnvironment, withRootPrompt } from './root-launch'
import { codexTui, initStore, registerBuiltinTuis } from './testing'
import { entryClaudeSession } from './tui/adapters/claude-code'
import { entryCodexRollout } from './tui/adapters/codex'
import { entryPiSession } from './tui/adapters/pi'
import { getTui } from './tui/registry'
import type { TuiSpec } from './tui/spec'

const CLAUDE = '5a7741ea-e6b1-4062-853b-0d9d2e03d549'
const OLD = '6b7741ea-e6b1-4062-853b-0d9d2e03d549'
const THREAD = '7c7741ea-e6b1-4062-853b-0d9d2e03d549'
const SUBAGENT = '8d7741ea-e6b1-4062-853b-0d9d2e03d549'

function procfs(
  files: Record<string, string>,
  links: Record<string, string> = {},
  mtimes?: Record<string, number>,
): ProcFs {
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
      if (path in links) return links[path] as string
      throw missing(path)
    },
    ...(mtimes ? { mtimeMs: (path: string) => (path in files ? (mtimes[path] ?? 0) : null) } : {}),
  }
}

/** A Codex rollout's first line (session_meta), as Codex 0.164 writes it. */
function rolloutMeta(id: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    timestamp: '2026-10-31T09:00:00.000Z',
    type: 'session_meta',
    payload: { id, cwd: '/work', originator: 'codex_cli_rs', ...extra },
  })}\n`
}

function rolloutEvent(type: string, timestamp: string): string {
  return `${JSON.stringify({ timestamp, type: 'event_msg', payload: { type } })}\n`
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
      'claude-code',
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
      `/usr/bin/env ${ENTRY_HOME_ENV}=${fixture}/hunt/case-1/home ${ENTRY_TOOL_ENV}=claude-code ${enterScript} case-1 -- /bin/sh -c 'claude --x'`,
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
    expect(await call(body('hunt-unsupported', { tool: 'opencode' }))).toEqual({
      status: 400,
      body: {
        error: 'unsupported_tool',
        supported: ['agy', 'aico-agent', 'claude-code', 'codex', 'pi'],
      },
    })
    expect(
      await call(body('hunt-codex-instr', { tool: 'codex', instructions: { path: '/x' } })),
    ).toMatchObject({ status: 400, body: { error: 'invalid_body', field: 'entry' } })
    expect(
      await call(body('hunt-codex-unknown', { tool: 'codex', entry: { name: 'nope', arg: 'c' } })),
    ).toMatchObject({ status: 400, body: { error: 'unknown_entry', entry: 'nope' } })
    for (const id of [
      'hunt-unknown',
      'hunt-config',
      'hunt-bad',
      'hunt-unsupported',
      'hunt-codex-instr',
      'hunt-codex-unknown',
    ])
      expect(getRootRequest(id)).toBeUndefined()
  })

  it('runs Codex through the entry with the explicit model and effort on every launch', async () => {
    writeEntries({ 'neri-hunt': { argv: [enterScript], home: `${fixture}/hunt/{arg}/home` } })
    const created = await call(
      body('hunt-codex', { tool: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }),
    )
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ entry: { name: 'neri-hunt', arg: 'case-1' } })
    const widgetId = getRootRequest('hunt-codex')?.widgetId as string
    const native = initialLaunchLine(widgetId, codexTui) as string
    const line = sessionLaunchLine(widgetId, native) as string
    expect(
      line.startsWith(
        `/usr/bin/env ${ENTRY_HOME_ENV}=${fixture}/hunt/case-1/home ${ENTRY_TOOL_ENV}=codex ${enterScript} case-1 -- /bin/sh -c `,
      ),
    ).toBe(true)
    // A synthetic codex on the entry's PATH records what it was started with.
    const bin = join(fixture, 'codex-bin')
    const argsLog = join(fixture, 'codex.args')
    execFileSync('/bin/mkdir', ['-p', bin])
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nprintf '%s\\n' "$@" >"${argsLog}"\n`)
    chmodSync(join(bin, 'codex'), 0o755)
    const run = (extra: Record<string, string>) => {
      rmSync(argsLog, { force: true })
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', line], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          AICO_ROOT_INITIAL_LAUNCH: '1',
          AICO_ROOT_INITIAL_PROMPT: 'Synthetic brief.',
          AICO_ROOT_MODEL: 'gpt-6.1-sol',
          AICO_ROOT_REASONING_EFFORT: 'xhigh',
          ...extra,
        },
      })
      return readFileSync(argsLog, 'utf8').split('\n')
    }
    const first = run({})
    expect(first).toEqual(
      expect.arrayContaining(['--model', 'gpt-6.1-sol', 'model_reasoning_effort="xhigh"']),
    )
    expect(first).toContain('Synthetic brief.')
    expect(readFileSync(enterLog, 'utf8').startsWith('case-1|--|/bin/sh|-c|')).toBe(true)
    // A resume (restart, recovery, reboot restore) goes the same way, with the thread.
    const resumed = run({ AICO_ROOT_RESUME_SESSION_ID: THREAD })
    expect(resumed).toEqual(expect.arrayContaining(['--model', 'gpt-6.1-sol', 'resume', THREAD]))
    removeWidget(widgetId)
  })

  it('runs Pi through the entry under a host-chosen id with either model, kept on every launch', async () => {
    // A container-like synthetic entry: it records its own environment (what
    // the host reads at /proc/<pid>/environ), then runs the line with nothing
    // but the AICO_ROOT_* values a hunt entry forwards and the agent home as
    // HOME. A pinned synthetic pi (no network, no provider) records its argv
    // and writes a Pi-shaped session file named after the id it was given.
    const piEnter = join(fixture, 'pi-enter')
    const roots = [
      'INITIAL_LAUNCH',
      'INITIAL_PROMPT',
      'RESUME_SESSION_ID',
      'FRESH_SESSION_ID',
      'MODEL',
      'REASONING_EFFORT',
      'DAYBREAK',
    ].map((name) => `AICO_ROOT_${name}="$AICO_ROOT_${name}"`)
    writeFileSync(
      piEnter,
      `#!/bin/sh\ncat /proc/$$/environ >"${fixture}/pi-enter-$1.environ"\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec /usr/bin/env -i PATH=/usr/bin:/bin HOME="$${ENTRY_HOME_ENV}" ${roots.join(' ')} "$@"\n`,
    )
    chmodSync(piEnter, 0o755)
    const pinned = join(fixture, 'pinned', 'pi-synthetic')
    execFileSync('/bin/mkdir', ['-p', join(fixture, 'pinned')])
    writeFileSync(
      pinned,
      [
        '#!/bin/sh',
        '# synthetic-pi: no network, no provider, no login',
        'printf \'%s\\n\' "$@" >"$HOME/pi.args"',
        '/usr/bin/env >"$HOME/pi.env"',
        'id=; prev=',
        'for a in "$@"; do case "$prev" in --session-id|--session) id="$a";; esac; prev="$a"; done',
        'dir="$HOME/.pi/agent/sessions/--work--"',
        'mkdir -p "$dir"',
        `printf '%s\\n' '{"type":"message","timestamp":"2026-10-31T09:00:01.000Z","message":{"role":"user","content":"x"}}' '{"type":"message","timestamp":"2026-10-31T09:00:02.000Z","message":{"role":"assistant","stopReason":"stop","content":[]}}' >>"$dir/2026-10-31T09-00-00-000Z_$id.jsonl"`,
        '',
      ].join('\n'),
    )
    chmodSync(pinned, 0o755)
    writeEntries({ 'neri-hunt': { argv: [piEnter], home: `${fixture}/pi-hunt/{arg}/home` } })
    const tool = { ...(getTui('pi') as TuiSpec), command: [pinned, '--approve'] }
    const models = ['opencode-go/deepseek-v4.1-flash', 'opencode-go/glm-5.3-flash']
    const hunts = models.map((model, index) => ({ model, arg: `case-pi-${index}`, widgetId: '' }))
    for (const hunt of hunts) {
      const created = await call(
        body(`hunt-${hunt.arg}`, {
          tool: 'pi',
          model: hunt.model,
          reasoningEffort: 'high',
          entry: { name: 'neri-hunt', arg: hunt.arg },
        }),
      )
      expect(created.status).toBe(200)
      hunt.widgetId = getRootRequest(`hunt-${hunt.arg}`)?.widgetId as string
      execFileSync('/bin/mkdir', ['-p', `${fixture}/pi-hunt/${hunt.arg}/home`])
    }
    const homeOf = (arg: string) => `${fixture}/pi-hunt/${arg}/home`
    const launch = (widgetId: string, arg: string, environment: Record<string, string>) => {
      const line = sessionLaunchLine(widgetId, initialLaunchLine(widgetId, tool)) as string
      // Preflight: the line runs the pinned synthetic pi through the entry and
      // names no bare `pi` a host install could answer.
      expect(
        line.startsWith(
          `/usr/bin/env ${ENTRY_HOME_ENV}=${homeOf(arg)} ${ENTRY_TOOL_ENV}=pi ${piEnter} ${arg} -- `,
        ),
      ).toBe(true)
      expect(line).toContain(pinned)
      expect(line).not.toMatch(/(^|[\s;'"])pi(\s|$)/)
      expect(readFileSync(pinned, 'utf8')).toContain('# synthetic-pi')
      rmSync(join(homeOf(arg), 'pi.args'), { force: true })
      execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', line], {
        env: { PATH: '/usr/bin:/bin', HOST_ONLY: 'not-for-the-entry', ...environment },
      })
      return readFileSync(join(homeOf(arg), 'pi.args'), 'utf8')
        .split('\n')
        .filter(Boolean)
    }
    // The host's view of a hunt: its entry process (as recorded) in a pane,
    // its home read through the contained readers.
    const look = (arg: string) => {
      const proc = procfs({
        '/proc/10/task/10/children': '11',
        '/proc/11/task/11/children': '',
        '/proc/11/stat': '11 (pi-enter)',
        '/proc/11/environ': readFileSync(join(fixture, `pi-enter-${arg}.environ`), 'utf8'),
      })
      const fs: ProcFs = {
        ...nodeProcFs,
        readFile: (path) => (path.startsWith('/proc/') ? proc : nodeProcFs).readFile(path),
        readdir: (path) => (path.startsWith('/proc/') ? proc : nodeProcFs).readdir(path),
      }
      return { entry: findEntryProcess(fs, [10, 11]), seen: observeAgent(fs, '/h', 10) }
    }
    const selection = (model: string) => [
      '--provider',
      'opencode-go',
      '--model',
      model.slice('opencode-go/'.length),
      '--thinking',
      'high',
    ]
    const chosen = new Map<string, string>()
    for (const hunt of hunts) {
      // First launch: the options come from the stored reservation.
      await withRootPrompt(hunt.widgetId, 'Synthetic brief.', async () => {
        const environment = rootLaunchEnvironment(hunt.widgetId)
        const fresh = environment.AICO_ROOT_FRESH_SESSION_ID as string
        expect(fresh).toMatch(/^[0-9a-f-]{36}$/)
        expect(environment).toMatchObject({
          AICO_ROOT_MODEL: hunt.model,
          AICO_ROOT_REASONING_EFFORT: 'high',
        })
        const args = launch(hunt.widgetId, hunt.arg, environment)
        expect(args).toEqual([
          '--approve',
          ...selection(hunt.model),
          '--session-id',
          fresh,
          '--',
          'Synthetic brief.',
        ])
        const { entry, seen } = look(hunt.arg)
        expect(entry).toMatchObject({
          pid: 11,
          home: homeOf(hunt.arg),
          tool: 'pi',
          chosenId: fresh,
        })
        expect(seen).toEqual({ pid: 11, resumeId: fresh, idle: null, blocked: false })
        chosen.set(hunt.arg, fresh)
      })
      // Inside: the agent got its id and selection, never the host's other
      // variables, the prompt variable or the fresh id variable itself.
      const inside = readFileSync(join(homeOf(hunt.arg), 'pi.env'), 'utf8')
      expect(inside).toContain(`TETHER_AGENT_SESSION_ID=${chosen.get(hunt.arg)}`)
      expect(inside).toContain(`AICO_ROOT_MODEL=${hunt.model}`)
      expect(inside).not.toMatch(
        /HOST_ONLY|AICO_ROOT_INITIAL_PROMPT|AICO_ROOT_FRESH_SESSION_ID|TETHER_ENTRY_HOME/,
      )
    }
    // Two hunts: each resolves only its own conversation in its own home.
    const [a, b] = hunts as [(typeof hunts)[0], (typeof hunts)[0]]
    const idA = chosen.get(a.arg) as string
    const idB = chosen.get(b.arg) as string
    expect(idA).not.toBe(idB)
    expect(look(a.arg).seen?.resumeId).toBe(idA)
    expect(look(b.arg).seen?.resumeId).toBe(idB)
    expect(entryPiSession(nodeProcFs, homeOf(a.arg), idB)?.path).toBeNull()
    expect(entryPiSession(nodeProcFs, homeOf(b.arg), idA)?.path).toBeNull()
    // Crash recovery / reboot restore: resumes exactly that id, same selection
    // (no options passed: they come back from the reservation).
    await withRootPrompt(
      a.widgetId,
      'Resume.',
      async () => {
        const args = launch(a.widgetId, a.arg, rootLaunchEnvironment(a.widgetId))
        expect(args).toEqual([
          '--approve',
          ...selection(a.model),
          '--session',
          idA,
          '--',
          'Resume.',
        ])
        expect(look(a.arg).seen?.resumeId).toBe(idA)
      },
      idA,
    )
    // Restart with nothing to resume: a new conversation under a new
    // host-chosen id, same selection, and it is the one observed.
    const later = rootLaunchEnvironment(a.widgetId)
    expect(later.AICO_ROOT_INITIAL_LAUNCH).toBe('0')
    const restarted = launch(a.widgetId, a.arg, later)
    expect(restarted).toEqual([
      '--approve',
      ...selection(a.model),
      '--session-id',
      later.AICO_ROOT_FRESH_SESSION_ID,
    ])
    expect(later.AICO_ROOT_FRESH_SESSION_ID).not.toBe(idA)
    expect(look(a.arg).seen?.resumeId).toBe(later.AICO_ROOT_FRESH_SESSION_ID)
    expect(look(b.arg).seen?.resumeId).toBe(idB)
    // End: the entry and the kept options go with the session.
    for (const hunt of hunts) {
      removeWidget(hunt.widgetId)
      expect(getSessionEntry(hunt.widgetId)).toBeNull()
      expect(sessionEntryHome(hunt.widgetId)).toBeNull()
      expect(rootLaunchEnvironment(hunt.widgetId).AICO_ROOT_MODEL).toBe('')
      rmSync(`${fixture}/pi-hunt/${hunt.arg}`, { recursive: true, force: true })
    }
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

  it('fails closed for a Codex session whose entry is gone, or a tool no entry runs', () => {
    const reserve = (widgetId: string, tool: string) =>
      reserveRootRequest(
        {
          requestId: `hunt-${widgetId}`,
          digest: 'd',
          widgetId,
          logicalSessionId: `aico-root-${widgetId}`,
          role: 'r',
          leadRootReference: null,
          facetCapsuleRef: null,
          createdAt: 1,
          origin: 'aico',
        },
        tool,
        'sample-app',
        fixture,
        null,
        { name: 'neri-hunt', arg: 'case-8' },
      )
    const marker = join(fixture, 'host-ran-codex')
    reserve('e0e0e0e2', 'codex')
    reserve('e0e0e0e3', 'agy')
    // Listed, but the session's tool is not one an entry runs: never on the host.
    let run = spawnSync(
      '/bin/sh',
      ['-c', sessionLaunchLine('e0e0e0e3', `touch ${marker}`) as string],
      {
        encoding: 'utf8',
      },
    )
    expect(run.status).toBe(ENTRY_MISSING_EXIT)
    expect(run.stderr).toContain('entry neri-hunt cannot run agy')
    writeEntries({})
    run = spawnSync('/bin/sh', ['-c', sessionLaunchLine('e0e0e0e2', `touch ${marker}`) as string], {
      encoding: 'utf8',
    })
    expect(run.status).toBe(ENTRY_MISSING_EXIT)
    expect(run.stderr).toContain('neri-hunt is not in')
    expect(() => readFileSync(marker)).toThrow()
    removeWidget('e0e0e0e2')
    removeWidget('e0e0e0e3')
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
    expect(findEntryProcess(fs, [10, 11, 12])).toEqual({
      pid: 11,
      home: HOME,
      tool: 'claude-code',
      chosenId: null,
    })
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

  describe('Codex', () => {
    const day = `${HOME}/.codex/sessions/2026/10/31`
    const codexPane = {
      ...pane,
      '/proc/11/environ': `PATH=/bin\0${ENTRY_HOME_ENV}=${HOME}\0${ENTRY_TOOL_ENV}=codex\0`,
      // A host rollout a pane process holds open is never this session's state.
      '/proc/12/fd': '',
      '/h/.codex/sessions/2026/10/31/rollout-2026-10-31T08-00-00-host.jsonl': rolloutMeta(OLD),
    }
    const links = {
      '/proc/12/fd/3': '/h/.codex/sessions/2026/10/31/rollout-2026-10-31T08-00-00-host.jsonl',
    }
    const files = {
      ...codexPane,
      '/proc/12/fd/3': '',
      [`${HOME}/.codex/sessions/2026/10/30/rollout-2026-10-30T23-00-00-a.jsonl`]: rolloutMeta(OLD),
      [`${day}/rollout-2026-10-31T09-00-00-b.jsonl`]: rolloutMeta(THREAD),
      // A subagent's rollout, written after the user thread's.
      [`${day}/rollout-2026-10-31T09-30-00-c.jsonl`]: rolloutMeta(SUBAGENT, {
        parent_thread_id: THREAD,
      }),
      [`${day}/notes.txt`]: 'x',
      [`${HOME}/.codex/auth.json`]: '{}',
    }

    it('reads the user thread from the entry home rollouts, never the host', () => {
      // A resumed older thread appends to its own file: write time decides.
      const fs = procfs(files, links, {
        [`${HOME}/.codex/sessions/2026/10/30/rollout-2026-10-30T23-00-00-a.jsonl`]: 100,
        [`${day}/rollout-2026-10-31T09-00-00-b.jsonl`]: 300,
        [`${day}/rollout-2026-10-31T09-30-00-c.jsonl`]: 400,
      })
      expect(findEntryProcess(fs, [10, 11, 12])).toEqual({
        pid: 11,
        home: HOME,
        tool: 'codex',
        chosenId: null,
      })
      expect(entryCodexRollout(fs, HOME)).toEqual({
        path: `${day}/rollout-2026-10-31T09-00-00-b.jsonl`,
        threadId: THREAD,
      })
      expect(observeAgent(fs, '/h', 10)).toEqual({
        pid: 11,
        resumeId: THREAD,
        idle: null,
        blocked: false,
      })
      const resumedOld = procfs(files, links, {
        [`${HOME}/.codex/sessions/2026/10/30/rollout-2026-10-30T23-00-00-a.jsonl`]: 500,
        [`${day}/rollout-2026-10-31T09-00-00-b.jsonl`]: 300,
      })
      expect(observeAgent(resumedOld, '/h', 10)?.resumeId).toBe(OLD)
      // Without write times, the newest by name (creation).
      expect(observeAgent(procfs(files, links), '/h', 10)?.resumeId).toBe(THREAD)
      // No rollout in the entry home yet: nothing, even with the host's held open.
      expect(observeAgent(procfs(codexPane, links), '/h', 10)).toBeNull()
    })

    it('reads nothing for an entry marker naming a tool no entry runs', () => {
      const fs = procfs(
        {
          ...files,
          '/proc/11/environ': `${ENTRY_HOME_ENV}=${HOME}\0${ENTRY_TOOL_ENV}=agy\0`,
          [`${HOME}/.claude/sessions/9.json`]: containerFile(9, {}),
        },
        links,
      )
      expect(findEntryProcess(fs, [10, 11, 12])).toEqual({
        pid: 11,
        home: HOME,
        tool: null,
        chosenId: null,
      })
      expect(observeAgent(fs, '/h', 10)).toBeNull()
    })

    it('polls the turn from the entry home rollout and loses it with the entry', async () => {
      const realHome = join(fixture, 'codex-home')
      const realDay = join(realHome, '.codex', 'sessions', '2026', '10', '31')
      execFileSync('/bin/mkdir', ['-p', realDay])
      const rollout = join(realDay, 'rollout-2026-10-31T09-00-00-b.jsonl')
      writeFileSync(
        rollout,
        rolloutMeta(THREAD) + rolloutEvent('task_started', '2026-10-31T09:00:01.000Z'),
      )
      const proc: Record<string, string> = {
        ...pane,
        '/proc/11/environ': `${ENTRY_HOME_ENV}=${realHome}\0${ENTRY_TOOL_ENV}=codex\0`,
      }
      // /proc is synthetic; the entry home is a real synthetic directory.
      const fake = procfs(proc)
      const fs: ProcFs = {
        ...nodeProcFs,
        readFile: (path) =>
          path.startsWith('/proc/') ? fake.readFile(path) : nodeProcFs.readFile(path),
        readdir: (path) =>
          path.startsWith('/proc/') ? fake.readdir(path) : nodeProcFs.readdir(path),
      }
      const tracker = new AgentStateTracker(
        () => {},
        () => 1000,
      )
      const poller = new AgentStatePoller(
        tracker,
        { sessions: () => [{ id: 'c', generation: 'g', panePid: async () => 10 }] },
        fs,
        '/h',
        { now: () => 0 },
      )
      await poller.poll()
      expect(tracker.get('c')).toMatchObject({ state: 'working', stateSource: 'codex-rollout' })
      writeFileSync(
        rollout,
        rolloutMeta(THREAD) +
          rolloutEvent('task_started', '2026-10-31T09:00:01.000Z') +
          rolloutEvent('task_complete', '2026-10-31T09:00:09.000Z'),
      )
      await poller.poll()
      expect(tracker.get('c').state).toBe('idle')
      delete proc['/proc/11/stat']
      delete proc['/proc/11/environ']
      proc['/proc/10/task/10/children'] = ''
      await poller.poll()
      expect(tracker.get('c').state).toBe('unknown')
    })
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
