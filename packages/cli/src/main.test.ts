import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openTasksDb } from '@aico/tasks'
import { afterEach, describe, expect, it } from 'vitest'
import config from '../data/cli.json' with { type: 'json' }
import { catalog, extensionEnvironment, parseBinding, passiveHelp } from './extensions'
import { main, monitorSummary, NATIVE } from './main'

const root = resolve('.')
const scratch: string[] = []
afterEach(() => {
  for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true })
})
const temp = () => {
  const p = mkdtempSync(join(tmpdir(), 'aico-cli-'))
  scratch.push(p)
  return p
}
// cwd defaults to a folder outside every registered project, so the live registry never picks one.
function harness(env: NodeJS.ProcessEnv = {}, cwd: string = temp()) {
  const calls: { argv: string[]; env: NodeJS.ProcessEnv }[] = [],
    output: string[] = [],
    errors: string[] = []
  return {
    calls,
    output,
    errors,
    go: (argv: string[]) =>
      main(argv, {
        root,
        env,
        cwd,
        out: (x) => output.push(x),
        err: (x) => errors.push(x),
        execute: async (argv, env) => {
          calls.push({ argv, env })
          return argv[0].endsWith('st-service') && argv[1] === 'rebuild' && argv.includes('aico')
            ? 3
            : 0
        },
      }),
  }
}
describe('CLI cutover', () => {
  it('runs checked-main delivery from the registered Aico checkout', async () => {
    const dir = temp(),
      checkout = join(dir, 'aico'),
      leaf = join(checkout, 'native/git-outgoing/github-delivery')
    mkdirSync(join(checkout, 'native/git-outgoing'), { recursive: true })
    writeFileSync(leaf, 'fixture', { mode: 0o755 })
    const { Registry } = await import('@aico/tasks')
    const file = join(dir, 'tasks.db'),
      db = openTasksDb(file)
    new Registry(db).register({ id: 'aico', root: checkout })
    db.close()
    const h = harness({ HOME: dir, AICO_TASKS_DB: file })
    const args = ['--root', root, '--sha', 'a'.repeat(40)]
    expect(await h.go(['vcs', 'deliver', ...args])).toBe(0)
    expect(h.calls[0]?.argv).toEqual([leaf, ...args])
    expect(h.calls).toHaveLength(1)
  })
  it.each([
    'workflow',
    'automations',
    'ctx',
    'native-sessions',
    'create',
    'claim',
    'done',
    'context',
    'tasks',
  ])('retires %s without executing anything', async (verb) => {
    const h = harness()
    expect(await h.go([verb, '--help'])).toBe(2)
    expect(h.calls).toEqual([])
    expect(h.errors.join(' ')).toContain('dropped')
    expect(
      catalog(join(root, 'packages/cli/data'), '/missing', new Set()).some(
        (entry) => entry.binding.namespace === verb,
      ),
    ).toBe(false)
  })
  it.each([
    ['backup', 'backups'],
    ['snap', 'snapshots', 'take'],
    ['snaps', 'snapshots', 'list'],
    ['rollback', 'snapshots', 'restore'],
  ])('moves st %s to its Aico owner', async (verb, ...target) => {
    const h = harness()
    expect(await h.go([verb, 'x'])).toBe(0)
    expect(h.calls[0]?.argv).toEqual([
      join(root, 'packages/web-server/scripts/aico'),
      ...target,
      'x',
    ])
  })
  it.each([
    'check',
    'commit',
    'pulse',
    'lease',
    'memory',
    'prompt',
    'models',
    'logins',
    'web',
    'video',
    'caretaker',
    'vm',
    'plug',
    'away',
    'wip',
    'context-sync',
    'shift',
    'backups',
    'publish',
    'usage',
    'grants',
    'elevate',
    'deploy',
    'logs',
    'snapshots',
  ])('moves %s without SF runtime', async (verb) => {
    const h = harness()
    expect(await h.go([verb, '--help'])).toBe(0)
    expect(h.calls[0]?.argv.slice(1)).toEqual([verb, '--help'])
  })
  it.each([
    ['routines', ['routines', 'run', '--help'], ['routines', '--help']],
    ['projects', ['projects', 'show', '--help'], ['projects', '--help']],
    ['vm', ['vm', 'stop', '180', '--help'], ['vm', '--help']],
    ['snap', ['snap', 'x', '-h'], ['snapshots', '--help']],
    ['logins', ['logins', 'edit', '--help'], ['logins', 'edit', '--help']],
    [
      'run after --',
      ['logins', 'run', '--with', 'a', '--', 'x', '--help'],
      ['logins', 'run', '--with', 'a', '--', 'x', '--help'],
    ],
  ])(
    '--help after a sub-command asks about the command, never acts: %s',
    async (_name, argv, sent) => {
      const h = harness({ AICO_CLI_NAME: 'aico' })
      expect(await h.go(argv)).toBe(0)
      expect(h.calls[0]?.argv.slice(1)).toEqual(sent)
    },
  )
  it('routines add hands its --command line on whole, including a -h of its own', async () => {
    const h = harness({ AICO_CLI_NAME: 'aico' })
    const argv = ['routines', 'add', '--project', 'p', '--kind', 'k', '--command', 'df', '-h']
    expect(await h.go(argv)).toBe(0)
    expect(h.calls[0]?.argv.slice(1)).toEqual(argv)
    // A --help before --command still asks about the command.
    const asked = harness({ AICO_CLI_NAME: 'aico' })
    expect(await asked.go(['routines', 'add', '--help', '--command', 'true'])).toBe(0)
    expect(asked.calls[0]?.argv.slice(1)).toEqual(['routines', '--help'])
  })
  it.each(['note', 'notes', 'share', 'files'])(
    '%s points at tether, acting on nothing',
    async (verb) => {
      const h = harness()
      expect(await h.go([verb, 'anything'])).toBe(2)
      expect(h.calls).toEqual([])
      expect(h.errors.join(' ')).toContain(
        verb === 'note' || verb === 'notes' ? 'tether note' : 'tether share',
      )
    },
  )
  it('--help on any sessions verb prints the sessions help', async () => {
    const h = harness()
    for (const verb of ['inbox', 'confirm', 'ack']) {
      expect(await h.go(['sessions', verb, '--help'])).toBe(0)
      expect(h.calls).toEqual([])
    }
  })
  it('sessions send and wait answer --help themselves', async () => {
    const h = harness()
    await h.go(['sessions', 'send', 'x', '--help'])
    expect(h.calls.at(-1)?.argv).toEqual(['aico-hook', 'sessions', 'send', '--help'])
    await h.go(['sessions', 'wait', 'session', '--help'])
    expect(h.calls.at(-1)?.argv.slice(-3)).toEqual(['wait', 'session', '--help'])
  })
  it.each([
    'graph',
    'design',
    'show',
    'docker',
    'cleanup',
    'claude',
    'runtime',
    'ready-all',
    'critique',
  ])('explains dropped %s', async (verb) => {
    const h = harness()
    expect(await h.go([verb])).toBe(2)
    expect(h.errors.join()).toContain('dropped')
    expect(h.calls).toHaveLength(0)
  })
  it('keeps aico context/jobs/agent separate from st aliases', async () => {
    for (const verb of ['context', 'jobs', 'agent']) {
      const h = harness({ AICO_CLI_NAME: 'aico' })
      expect(await h.go([verb, '--help'])).toBe(0)
      expect(h.calls[0]?.argv.slice(1)).toEqual([verb, '--help'])
    }
  })
  it('routes root helpers, coordination, service rebuild and publication', async () => {
    const h = harness()
    await h.go(['aico', 'wait', 'cmd', '--', 'true'])
    await h.go(['sessions', 'may-disrupt', 'aico'])
    await h.go(['service', 'rebuild', 'aico', '--detach'])
    await h.go(['vcs', 'publish', '--all'])
    expect(h.calls.map((c) => c.argv.slice(1))).toEqual([
      [join(root, 'native/host-steward/aico-root-watch.py'), 'wait', 'cmd', '--', 'true'],
      ['sessions', 'may-disrupt', 'aico'],
      ['rebuild', 'aico', '--detach'],
      ['deploy', 'aico', '--detach'],
      ['publish', '--all'],
    ])
  })
  it('runs st skills from Aico and refuses the dropped st complete', async () => {
    const h = harness()
    await h.go(['skills', 'status', '--json'])
    expect(h.calls[0]?.argv).toEqual([
      join(root, 'native/service-tools/st-skills'),
      'status',
      '--json',
    ])
    expect(await h.go(['complete', '--agent', 'x'])).not.toBe(0)
    expect(h.calls).toHaveLength(1)
  })
  it('projects strips optional JSON spelling', async () => {
    const h = harness()
    await h.go(['projects', 'list', '--json'])
    expect(h.calls[0]?.argv.slice(1)).toEqual(['projects', 'list'])
  })
  it('tools run retains shared admission', async () => {
    const h = harness()
    await h.go(['tools', 'run', '--label', 'test', '--', 'true'])
    expect(h.calls[0]?.argv).toEqual([
      'python3',
      join(root, 'native/st-sdk/tools_run.py'),
      '--label',
      'test',
      '--',
      'true',
    ])
  })
  it('manifest stays passive and exact surfaces remain discoverable', async () => {
    const h = harness()
    expect(await h.go(['tools', 'manifest', '--surface', 'st.commit', '--format', 'json'])).toBe(0)
    expect(JSON.parse(h.output[0]).tools[0].surface).toBe('st.commit')
    expect(h.calls).toHaveLength(0)
  })
  it('reads tables, schema, count, sample and SQL from an Aico store; refuses mutations', async () => {
    const data = temp()
    const db = openTasksDb(join(data, 'tasks.db'))
    db.close()
    const h = harness({ AICO_DATA_DIR: data })
    for (const argv of [
      ['tables'],
      ['schema', 'projects'],
      ['count', 'projects'],
      ['sample', 'projects', '1'],
      ['query', 'SELECT 7 AS n'],
    ])
      expect(await h.go(['db', ...argv])).toBe(0)
    expect(JSON.parse(h.output.at(-1) || '')).toEqual([{ n: '7' }])
    expect(await h.go(['db', 'query', 'DELETE FROM projects'])).toBe(2)
    expect(await h.go(['db', 'exec', 'DROP TABLE projects'])).toBe(2)
  })
  it('mockup add sends the file, its name and originating session to Aico', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'test.html'), '<p>test</p>')
    let request: RequestInit | undefined
    const output: string[] = []
    expect(
      await main(
        ['mockup', 'add', join(dir, 'test.html'), '--project', 'aico', '--title', 'Test'],
        {
          root,
          env: { AICO_WIDGET_ID: 'aico-widget-1234abcd' },
          out: (x) => output.push(x),
          fetcher: (async (url, init) => {
            expect(String(url)).toBe('http://127.0.0.1:3002/api/mockups')
            request = init
            return new Response(JSON.stringify({ pageUrl: '/workbench?tab=designs&project=aico' }))
          }) as typeof fetch,
        },
      ),
    ).toBe(0)
    const sent = JSON.parse(String(request?.body))
    expect(sent).toMatchObject({ name: 'test.html', session: '1234abcd', project: 'aico' })
    expect(Buffer.from(sent.data, 'base64').toString()).toBe('<p>test</p>')
    expect(JSON.parse(output[0]).pageUrl).toBe(
      'https://aico.summitflow.dev/workbench?tab=designs&project=aico',
    )
  })
  it('mockup add sends an image as its bytes, and mockup remove asks for the design to go', async () => {
    const dir = temp()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 1])
    writeFileSync(join(dir, 'shot.png'), bytes)
    const calls: { url: string; init?: RequestInit }[] = []
    const run = (args: string[]) =>
      main(args, {
        root,
        env: {},
        out: () => {},
        fetcher: (async (url, init) => {
          calls.push({ url: String(url), init })
          return new Response('{}')
        }) as typeof fetch,
      })
    expect(
      await run(['mockup', 'add', join(dir, 'shot.png'), '--project', 'aico', '--title', 'Shot']),
    ).toBe(0)
    expect(Buffer.from(JSON.parse(String(calls[0].init?.body)).data, 'base64')).toEqual(bytes)
    expect(await run(['mockup', 'remove', 'abc123def456', '--project', 'aico'])).toBe(0)
    expect(calls[1].url).toBe('http://127.0.0.1:3002/api/mockups/abc123def456?project=aico')
    expect(calls[1].init?.method).toBe('DELETE')
    // --no-ask: no question in the owner's Needs you; without it the field is not sent at all.
    expect(JSON.parse(String(calls[0].init?.body))).not.toHaveProperty('ask')
    expect(
      await run([
        'mockup',
        'add',
        join(dir, 'shot.png'),
        '--project',
        'aico',
        '--title',
        'Shot',
        '--no-ask',
      ]),
    ).toBe(0)
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({ ask: false })
  })
})
describe('versioned extensions', () => {
  it('reads Neri hunt transfer help from its accepted owner manifest', () => {
    const state = temp(),
      source = join(state, 'projects/neri/current/source')
    mkdirSync(source, { recursive: true })
    const bundled = JSON.parse(
      readFileSync(join(root, 'packages/cli/data/extensions/neri.json'), 'utf8'),
    )
    writeFileSync(
      join(source, 'st-extension.json'),
      JSON.stringify({
        ...bundled,
        help: {
          ...bundled.help,
          hunt: 'Hunts',
          'hunt transfer': 'Transfer a running hunt in place',
        },
      }),
    )
    const extension = catalog(join(root, 'packages/cli/data'), state, new Set()).find(
      (entry) => entry.binding.owner === 'neri',
    )!
    expect(passiveHelp(extension, ['hunt', 'transfer', '--help'])).toBe(
      'Transfer a running hunt in place',
    )
    rmSync(join(source, 'st-extension.json'))
    const fallback = catalog(join(root, 'packages/cli/data'), state, new Set()).find(
      (entry) => entry.binding.owner === 'neri',
    )!
    expect(passiveHelp(fallback, ['--help'])).toBe(bundled.help[''])
  })

  it('loads trusted retained extensions, without executing owners', () => {
    const entries = catalog(join(root, 'packages/cli/data'), '/missing', new Set())
    expect(entries.find((x) => x.binding.namespace === 'browser')?.status).toBe('unverified')
    expect(entries.some((x) => x.binding.namespace === 'design')).toBe(false)
    const b = entries.find((x) => x.binding.namespace === 'browser')
    expect(b && passiveHelp(b, ['--help'])).toContain('browser')
  })
  it('names the missing runtime on a host with no service state folder', async () => {
    const home = temp()
    const h = harness({ HOME: home })
    expect(await h.go(['browser', 'login', 'list'])).toBe(2)
    expect(h.errors.join('\n')).toContain('browser: browser-automation has no accepted runtime')
    expect(h.errors.join('\n')).not.toMatch(/ENOENT|lstat/)
    expect(h.calls).toEqual([])
    // The extension listing reports it instead of crashing, and core commands never read the folder.
    expect(await h.go(['tools', 'extensions', '--check'])).toBe(0)
    const listed = JSON.parse(h.output.at(-1) ?? '{}').extensions
    expect(listed.find((e: { namespace: string }) => e.namespace === 'browser').status).toBe(
      'missing-dependency',
    )
    expect(await h.go(['browser', '--help'])).toBe(0)
    // A runtime folder without its executable names the install step.
    mkdirSync(join(home, '.summitflow/services/projects/browser-automation/releases/r/source'), {
      recursive: true,
    })
    symlinkSync(
      join(home, '.summitflow/services/projects/browser-automation/releases/r'),
      join(home, '.summitflow/services/projects/browser-automation/current'),
    )
    expect(await h.go(['browser', 'login', 'list'])).toBe(2)
    expect(h.errors.at(-1)).toContain('Install executable for browser-automation')
  })
  it('rejects traversal and injected environment', () => {
    const b = {
      id: 'x',
      owner: 'x',
      namespace: 'x',
      manifest: 'extensions/x.json',
      executable: 'bin/x',
      grant: { enabled: true, effects: [] },
    }
    expect(() => parseBinding({ ...b, executable: '../x' })).toThrow()
    expect(() => parseBinding({ ...b, environment: ['PYTHONPATH'] })).toThrow()
    expect(
      extensionEnvironment(
        parseBinding(b),
        { HOME: '/tmp', PASSWORD: 'secret', PATH: '/bin' },
        { contract_version: 1 },
      ),
    ).not.toHaveProperty('PASSWORD')
  })
  it('refuses namespace collisions and incompatible contracts', () => {
    const data = temp()
    mkdirSync(join(data, 'extensions'))
    const binding = {
      id: 'x',
      owner: 'x',
      namespace: 'x',
      manifest: 'extensions/x.json',
      executable: 'bin/x',
      grant: { enabled: true, effects: [] },
    }
    writeFileSync(
      join(data, 'extensions.json'),
      JSON.stringify({ contractVersion: 1, bindings: [binding] }),
    )
    writeFileSync(
      join(data, 'extensions/x.json'),
      JSON.stringify({
        id: 'x',
        owner: 'x',
        namespace: 'x',
        version: '1.0.0',
        st_contract_versions: [2],
        effects: [],
        summary: 'test',
        help: { '': 'test' },
        usage: [],
      }),
    )
    expect(catalog(data, '/missing', new Set())[0].status).toBe('incompatible')
    expect(catalog(data, '/missing', new Set(['x']))[0].status).toBe('collision')
  })
})

describe('root command contracts', () => {
  it('accepts root output flags and project selection before extension help', async () => {
    const h = harness()
    expect(await h.go(['--no-compact', '--human', '-P', 'selected', 'ui', '--help'])).toBe(0)
    expect(h.output.join()).toContain('ui')
  })
  it('picks the project: -P, then the project holding cwd, then the inherited id', async () => {
    const dir = temp(),
      file = join(dir, 'tasks.db'),
      projectB = join(dir, 'b'),
      nested = join(projectB, 'src'),
      outside = join(dir, 'elsewhere')
    for (const p of [nested, outside]) mkdirSync(p, { recursive: true })
    const db = openTasksDb(file)
    const { Registry } = await import('@aico/tasks')
    new Registry(db).register({ id: 'b', root: projectB })
    db.close()
    const env = { AICO_TASKS_DB: file, AICO_PROJECT_ID: 'a', ST_PROJECT_ID: 'a' }
    const inB = harness(env, nested)
    await inB.go(['snap', 'x'])
    expect(inB.calls[0]?.argv.slice(1)).toEqual(['snapshots', 'take', 'x', '--project', 'b'])
    expect(inB.calls[0]?.env).toMatchObject({ AICO_PROJECT_ID: 'b', ST_PROJECT_ID: 'b' })
    const nowhere = harness(env, outside)
    await nowhere.go(['snap', 'x'])
    expect(nowhere.calls[0]?.argv.slice(1)).toEqual(['snapshots', 'take', 'x', '--project', 'a'])
    const flagged = harness(env, nested)
    await flagged.go(['-P', 'c', 'snap', 'x'])
    expect(flagged.calls[0]?.argv.slice(1)).toEqual(['snapshots', 'take', 'x', '--project', 'c'])
    expect(flagged.calls[0]?.env).toMatchObject({ AICO_PROJECT_ID: 'c', ST_PROJECT_ID: 'c' })
  })
  it('keeps undeclared help passive unless owner_help is granted', () => {
    const binding = {
      id: 'x',
      owner: 'x',
      namespace: 'x',
      manifest: 'extensions/x.json',
      executable: 'bin/x',
      grant: { enabled: true, effects: [] },
    }
    const extension = {
      binding,
      manifest: {
        id: 'x',
        owner: 'x',
        namespace: 'x',
        version: '1.0.0',
        st_contract_versions: [1],
        effects: [],
        summary: 'test',
        help: { '': 'root help', list: 'list help' },
        usage: [],
      },
      status: 'unverified',
    }
    expect(passiveHelp(extension, ['list', 'unknown', '--help'])).toBe('list help')
    expect(
      passiveHelp({ ...extension, binding: { ...binding, owner_help: true } }, [
        'list',
        'unknown',
        '--help',
      ]),
    ).toBeNull()
  })
})

it('forwards cancellation to the owned child process group', async () => {
  const { spawn } = await import('node:child_process')
  const { run } = await import('./main')
  const dir = temp(),
    file = join(dir, 'pid')
  const script = `import {spawn} from 'node:child_process'; const run=${run.toString().replace(/[\w$]+\.spawn/g, 'spawn')}; await run(['sh','-c','sleep 60 & echo $! > "$1"; wait','fixture',${JSON.stringify(file)}],process.env)`
  const processUnderTest = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: 'ignore',
  })
  let descendant = 0
  try {
    await expect
      .poll(
        () => {
          try {
            descendant = Number(readFileSync(file, 'utf8').trim())
            return descendant
          } catch {
            return 0
          }
        },
        { timeout: 3000 },
      )
      .toBeGreaterThan(0)
    processUnderTest.kill('SIGTERM')
    await new Promise<void>((done) => processUnderTest.once('exit', () => done()))
    await expect
      .poll(
        () => {
          try {
            return readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]
          } catch {
            return 'gone'
          }
        },
        { timeout: 1000 },
      )
      .toMatch(/^(gone|Z)$/)
  } finally {
    processUnderTest.kill('SIGKILL')
    if (descendant)
      try {
        process.kill(descendant, 'SIGKILL')
      } catch {}
  }
})

it('recovers the asking session when the harness filters its child environment', async () => {
  const dir = temp()
  writeFileSync(join(dir, 'mock.html'), '<p>review</p>')
  let posted: Record<string, unknown> = {}
  expect(
    await main(
      ['mockup', 'add', join(dir, 'mock.html'), '--project', 'aico', '--title', 'Review'],
      {
        root,
        env: {},
        ownEnv: (env) => ({ ...env, AICO_WIDGET_ID: 'aico-widget-1234abcd' }),
        out: () => {},
        fetcher: (async (_url, init) => {
          posted = JSON.parse(String(init?.body))
          return new Response('{}')
        }) as typeof fetch,
      },
    ),
  ).toBe(0)
  expect(posted.session).toBe('1234abcd')
})
it('scopes snapshots by the selected project using the owning command spelling', async () => {
  const h = harness()
  await h.go(['-P', 'selected', 'snap'])
  expect(h.calls[0]?.argv.slice(1)).toEqual(['snapshots', 'take', '--project', 'selected'])
})
it('does not advertise retired VM or monitor commands', async () => {
  for (const surface of ['st.vm.reset', 'st.monitor.logs', 'st.ready']) {
    const h = harness()
    expect(await h.go(['tools', 'manifest', '--surface', surface, '--format', 'json'])).toBe(2)
  }
})

it.each([
  [[], { human: false, compact: true, progress_only: false }],
  [['--no-compact', '--human'], { human: true, compact: false, progress_only: false }],
  [
    ['--no-compact', '--human', '--progress-only'],
    { human: false, compact: true, progress_only: true },
  ],
])('dispatches normalized version-1 output context for %j', async (flags, expected) => {
  const { Registry } = await import('@aico/tasks')
  const dir = temp(),
    fakeRoot = join(dir, 'repo'),
    data = join(fakeRoot, 'packages/cli/data')
  mkdirSync(join(data, 'extensions'), { recursive: true })
  mkdirSync(join(dir, 'owner/bin'), { recursive: true })
  writeFileSync(join(dir, 'owner/bin/tool'), 'fixture', { mode: 0o755 })
  writeFileSync(
    join(fakeRoot, 'project.identity.json'),
    JSON.stringify({ runtime: { backend_port: 3002 } }),
  )
  writeFileSync(
    join(data, 'extensions.json'),
    JSON.stringify({
      contractVersion: 1,
      bindings: [
        {
          id: 'fixture',
          owner: 'fixture',
          namespace: 'fixture',
          manifest: 'extensions/fixture.json',
          executable: 'bin/tool',
          grant: { enabled: true, effects: [] },
        },
      ],
    }),
  )
  writeFileSync(
    join(data, 'extensions/fixture.json'),
    JSON.stringify({
      id: 'fixture',
      owner: 'fixture',
      namespace: 'fixture',
      version: '1.0.0',
      st_contract_versions: [1],
      effects: [],
      summary: 'test',
      help: { '': 'help' },
      usage: [],
    }),
  )
  const db = openTasksDb(join(dir, 'tasks.db'))
  new Registry(db).register({ id: 'fixture', root: join(dir, 'owner') })
  db.close()
  let context: Record<string, unknown> = {}
  expect(
    await main([...flags, 'fixture', 'run'], {
      root: fakeRoot,
      env: {
        AICO_TASKS_DB: join(dir, 'tasks.db'),
        HOME: dir,
        CODEX_THREAD_ID: 'fixture-session',
        ST_CALLER_IDENTITY: 'forged',
      },
      execute: async (_argv, env) => {
        context = JSON.parse(env.ST_EXTENSION_CONTEXT || '{}')
        expect(JSON.parse(env.ST_CALLER_IDENTITY || '{}')).toEqual({
          member_id: 'codex_cli:codex:fixture-session',
          provider: 'codex_cli',
          session_id: 'fixture-session',
        })
        return 0
      },
    }),
  ).toBe(0)
  expect(context.output).toEqual(expected)
})

it.each(['status', 'start', 'stop', 'restart'])(
  'serves managed service %s from its registered unit config',
  async (action) => {
    const { Registry } = await import('@aico/tasks')
    const dir = temp()
    const db = openTasksDb(join(dir, 'tasks.db'))
    new Registry(db).register({ id: 'aico', root })
    db.close()
    const h = harness({ AICO_TASKS_DB: join(dir, 'tasks.db') })
    expect(await h.go(['service', action, 'aico'])).toBe(0)
    expect(h.calls[0]?.argv[0]).toBe(join(root, 'native/service-tools/st-service'))
    expect(h.calls[0]?.argv.slice(1)).toEqual([action, 'aico'])
    expect(h.calls[0]?.env.XDG_RUNTIME_DIR).toContain('/run/user/')
  },
)
it('keeps the phone app CLI available', async () => {
  const h = harness({ AICO_CLI_NAME: 'aico' })
  expect(await h.go(['app', 'status'])).toBe(0)
  expect(h.calls[0]?.argv.slice(1)).toEqual(['app', 'status'])
})

it('keeps phone metadata management available', async () => {
  const h = harness()
  expect(await h.go(['phones', 'list'])).toBe(0)
  expect(h.calls[0]?.argv.slice(1)).toEqual(['phones', 'list'])
})
it.each([
  ['--detach', 'aico'],
  ['--scope', 'frontend', 'aico'],
])('hands parsed Aico rebuild ownership back without option-order guesses', async (...args) => {
  const calls: string[][] = []
  expect(
    await main(['service', 'rebuild', ...args], {
      root,
      env: {},
      execute: async (argv) => {
        calls.push(argv)
        return argv[0].endsWith('st-service') ? 3 : 0
      },
    }),
  ).toBe(0)
  expect(calls.map((argv) => argv.slice(1))).toEqual([
    ['rebuild', ...args],
    ['deploy', ...args],
  ])
})
it.each([
  [['aico'], ['aico', '--scope', 'worker']],
  [
    ['aico', '--scope', 'full'],
    ['aico', '--scope', 'worker'],
  ],
  [
    ['aico', '--scope=full'],
    ['aico', '--scope', 'worker'],
  ],
  [
    ['aico', '--scope', 'backend'],
    ['aico', '--scope', 'backend'],
  ],
  [
    ['aico', '--worker', 'aico-jobs'],
    ['aico', '--worker', 'aico-jobs'],
  ],
])('an Aico restart reaches the deploy and restarts its units %j', async (args, deployed) => {
  const calls: string[][] = []
  expect(
    await main(['service', 'restart', ...args], {
      root,
      env: {},
      execute: async (argv) => {
        calls.push(argv)
        return argv[0].endsWith('st-service') ? 3 : 0
      },
    }),
  ).toBe(0)
  expect(calls.map((argv) => argv.slice(1))).toEqual([
    ['restart', ...args],
    ['deploy', ...deployed],
  ])
})
it('deploys from the registered source checkout when commands run from an installed release', async () => {
  const { Registry } = await import('@aico/tasks')
  const dir = temp()
  const db = openTasksDb(join(dir, 'tasks.db'))
  new Registry(db).register({ id: 'aico', root })
  db.close()
  let childEnv: NodeJS.ProcessEnv = {}
  expect(
    await main(['deploy', 'aico'], {
      root: join(dir, 'installed'),
      env: { AICO_TASKS_DB: join(dir, 'tasks.db') },
      execute: async (_argv, env) => {
        childEnv = env
        return 0
      },
    }),
  ).toBe(0)
  expect(childEnv.AICO_DEPLOY_ROOT).toBe(root)
})
it('keeps backup status as the Aico backup health view', async () => {
  const h = harness()
  expect(await h.go(['backup', 'status', '--json'])).toBe(0)
  expect(h.calls[0]?.argv.slice(1)).toEqual(['backups', 'list', '--json'])
})
it('advertises the native model and backup syntax', async () => {
  const h = harness()
  await h.go(['tools', 'manifest', '--surface', 'st.models.route', '--format', 'json'])
  expect(h.output.pop()).not.toContain('--task')
  await h.go(['tools', 'manifest', '--surface', 'st.backup.restore', '--format', 'json'])
  expect(h.output.pop()).toContain('SOURCE SNAPSHOT PATH')
})

it('passes the versioned extension context to the Aico session helper', async () => {
  const h = harness({ AICO_API_BASE: 'http://aico.test:3002/api' }, root)
  expect(await h.go(['-P', 'aico', 'aico', 'create', 'proof'])).toBe(0)
  expect(JSON.parse(h.calls[0]?.env.ST_EXTENSION_CONTEXT || '{}')).toMatchObject({
    contract_version: 1,
    project_id: 'aico',
    cwd: root,
    api_base: 'http://aico.test:3002/api',
    agent_hub_url: 'http://aico.test:3002',
  })
})

it('keeps the verbose project registry read', async () => {
  const h = harness()
  expect(await h.go(['projects', 'list', '-v'])).toBe(0)
  expect(h.calls[0]?.argv.slice(1)).toEqual(['projects', 'list'])
})

describe('aico declare and aico notify', () => {
  it('passes declare to host-steward untouched', async () => {
    const h = harness()
    expect(await h.go(['declare', 'add', '--host', 'pve', '--what', 'vm', '--reason', 'lab'])).toBe(
      0,
    )
    expect(h.calls[0]?.argv).toEqual([
      '/usr/local/bin/host-steward',
      'declare',
      'add',
      '--host',
      'pve',
      '--what',
      'vm',
      '--reason',
      'lab',
    ])
  })
  const notifier = (status = 200, body: unknown = { id: 'n1' }) => {
    const sent: { url: string; body: Record<string, unknown> }[] = []
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify(body), { status })
    }) as unknown as typeof fetch
    return { sent, fetcher }
  }
  it('posts flags as a notice v1 to the loopback API', async () => {
    const n = notifier()
    const out: string[] = []
    const code = await main(
      [
        '-P',
        'neri',
        'notify',
        '--title',
        'T',
        '--body',
        'B',
        '--severity',
        'warning',
        '--key',
        'k1',
      ],
      {
        root,
        env: { AICO_WEB_PORT: '3999', AICO_WEB_URL: 'https://public.example' },
        cwd: temp(),
        fetcher: n.fetcher,
        out: (x) => out.push(x),
      },
    )
    expect(code).toBe(0)
    expect(n.sent[0]).toEqual({
      url: 'http://127.0.0.1:3999/api/notices',
      body: { v: 1, source: 'neri', title: 'T', body: 'B', severity: 'warning', key: 'k1' },
    })
    expect(out).toEqual(['{"id":"n1"}'])
  })
  it('shows the server reason and exits non-zero when the notice is refused', async () => {
    const n = notifier(422, { detail: 'title: too long' })
    const errors: string[] = []
    const code = await main(['notify', '--title', 'T', '--body', 'B'], {
      root,
      env: { AICO_API_BASE: 'http://x.test/api' },
      cwd: temp(),
      fetcher: n.fetcher,
      err: (x) => errors.push(x),
    })
    expect(code).toBe(2)
    expect(errors[0]).toContain('title: too long')
    expect(n.sent[0]?.body.source).toBe('agent')
  })
  it('resolves a notice by key', async () => {
    const n = notifier()
    await main(['notify', 'resolve', 'k1', '--text', 'fixed', '--source', 'neri'], {
      root,
      env: { AICO_API_BASE: 'http://x.test/api' },
      cwd: temp(),
      fetcher: n.fetcher,
      out: () => {},
    })
    expect(n.sent[0]).toEqual({
      url: 'http://x.test/api/notices/resolve',
      body: { source: 'neri', key: 'k1', text: 'fixed' },
    })
  })
  it('needs a title and body, and prints help', async () => {
    const errors: string[] = []
    const out: string[] = []
    const env = { AICO_API_BASE: 'http://x.test/api' }
    expect(
      await main(['notify', '--title', 'T'], {
        root,
        env,
        cwd: temp(),
        err: (x) => errors.push(x),
      }),
    ).toBe(2)
    expect(
      await main(['notify', '--help'], { root, env, cwd: temp(), out: (x) => out.push(x) }),
    ).toBe(0)
    expect(out[0]).toContain('aico notify --json')
  })
})

it('leaves the jobs, neri and portfolio tools out of the startup block of other projects', async () => {
  const surfaces = async (...extra: string[]) => {
    const h = harness()
    expect(await h.go(['tools', 'manifest', '--format', 'json', ...extra])).toBe(0)
    return (JSON.parse(h.output[0]).tools as { surface: string }[]).map((row) => row.surface)
  }
  const all = await surfaces()
  expect(all.some((s) => s.startsWith('st.jobs.'))).toBe(true)
  expect(all.some((s) => s.startsWith('st.neri.'))).toBe(true)
  expect(all.some((s) => s.startsWith('st.portfolio.'))).toBe(true)
  const aico = await surfaces('--project', 'aico')
  expect(aico).toContain('st.commit')
  expect(aico).toContain('st.browser')
  expect(aico.some((s) => /^st\.(jobs|neri|portfolio)\./.test(s))).toBe(false)
  expect((await surfaces('--project', '')).some((s) => s.startsWith('st.jobs.'))).toBe(false)
  expect(
    (await surfaces('--project', 'jobinator-4000')).some((s) => s.startsWith('st.jobs.')),
  ).toBe(true)
  expect((await surfaces('--project', 'neri-hunters')).some((s) => s.startsWith('st.neri.'))).toBe(
    true,
  )
  // A named surface is still found from any project.
  const named = harness()
  expect(
    await named.go(['tools', 'manifest', '--surface', 'st.jobs.ready', '--format', 'json']),
  ).toBe(0)
})

describe('aico as the owner CLI', () => {
  const aico = () => harness({ AICO_CLI_NAME: 'aico' })
  const commands = config.aicoHelp.flatMap((g) => g.commands.map(([c]) => c as string))

  it('has its own grouped help, one line per command, never st usage', async () => {
    const h = aico()
    expect(await h.go(['--help'])).toBe(0)
    const text = h.output.join('\n')
    expect(text).toMatch(/^Usage: aico <command>/)
    expect(text).not.toContain('Usage: st')
    for (const group of config.aicoHelp) expect(text).toContain(`\n${group.group}\n`)
    for (const command of ['status', 'usage', 'agent', 'backups', 'grants', 'declare', 'tether'])
      expect(text).toMatch(new RegExp(`\n {2}${command} +\\S`))
    expect(h.calls).toEqual([])
  })

  it.each(commands)("aico %s --help exits 0 with that command's help", async (command) => {
    for (const flag of ['--help', '-h']) {
      const h = aico()
      expect(await h.go([command, flag])).toBe(0)
      expect(h.errors).toEqual([])
      if (h.calls.length === 0) expect(h.output.join('\n')).toMatch(/Usage/)
      else {
        // Delegated: the owning tool gets the flag untouched, and nothing else runs first.
        expect(h.calls).toHaveLength(1)
        expect(h.calls[0]?.argv.at(-1)).toBe(flag)
      }
    }
  })

  it('aico help COMMAND is COMMAND --help', async () => {
    const h = aico()
    expect(await h.go(['help', 'sessions'])).toBe(0)
    expect(h.output.join('\n')).toContain('aico sessions send TARGET')
  })

  it('names itself in errors and unknown commands', async () => {
    const h = aico()
    expect(await h.go(['nonsense'])).toBe(2)
    expect(h.errors).toEqual(['aico: Unknown command nonsense; use aico --help'])
    const st = harness()
    expect(await st.go(['nonsense'])).toBe(2)
    expect(st.errors).toEqual(['st: Unknown command nonsense; use st --help'])
  })

  it('suggests the nearest command for a typo, as tether does', async () => {
    const h = aico()
    expect(await h.go(['sttus'])).toBe(2)
    expect(h.errors).toEqual([
      'aico: Unknown command sttus (did you mean status?); use aico --help',
    ])
  })

  it('aico machines is a command of its own, listed in help', async () => {
    const h = aico()
    expect(await h.go(['machines'])).toBe(0)
    expect(h.calls[0]?.argv.slice(-2)).toEqual([
      expect.stringContaining('scripts/aico'),
      'machines',
    ])
    const help = aico()
    await help.go(['--help'])
    expect(help.output.join('\n')).toMatch(/\n {2}machines +every machine once/)
  })

  it('names the command and the problem for db and monitor mistakes, as aico or as st', async () => {
    for (const [h, who] of [
      [aico(), 'aico'],
      [harness(), 'st'],
    ] as const) {
      expect(await h.go(['db', 'drop', 'x'])).toBe(2)
      expect(await h.go(['monitor', 'bogus'])).toBe(2)
      expect(h.errors[0]).toBe(
        `${who}: db: unknown command drop (read-only: tables, schema, count, sample, query)`,
      )
      expect(h.errors[1]).toBe(
        `${who}: monitor bogus: dropped; use status, connections, processes, mounts or ${who} logs UNIT`,
      )
    }
  })

  it('monitor status reads as words, with the raw readings behind --json', () => {
    const text = monitorSummary({
      load: [1.5, 2, 3],
      uptime: 90_000,
      memory:
        'MemTotal: 2097152 kB\nMemAvailable: 1048576 kB\nSwapTotal: 1048576 kB\nSwapFree: 0 kB\n',
      pressure: 'some avg10=0.25 avg60=0 avg300=0 total=1\nfull avg10=0 avg60=0 avg300=0 total=0\n',
    })
    expect(text).toContain('Load 1.5 2 3 (1, 5, 15 min), up 1d 1h')
    expect(text).toContain('Memory 1.0 of 2.0 GB free, swap used 1.0 GB, stalled on memory 0.25%')
  })

  it('takes backup and backups alike', async () => {
    const h = aico()
    await h.go(['backup', 'list'])
    await h.go(['backups', 'list'])
    expect(h.calls.map((c) => c.argv.slice(1))).toEqual([
      ['backups', 'list'],
      ['backups', 'list'],
    ])
  })

  it('a bare recent lists, with or without flags', async () => {
    const h = aico()
    await h.go(['recent'])
    await h.go(['recent', '--limit', '3'])
    await h.go(['recent', '--help'])
    expect(h.calls.map((c) => c.argv)).toEqual([
      ['tether', 'history', 'list'],
      ['tether', 'history', 'list', '--limit', '3'],
      ['tether', 'history', '--help'],
    ])
  })

  it('recent reads past sessions; sessions list|show still does for old scripts', async () => {
    const h = aico()
    await h.go(['recent', 'list', '--limit', '5'])
    await h.go(['sessions', 'show', 'abc', '--json'])
    expect(h.calls.map((c) => c.argv)).toEqual([
      ['tether', 'history', 'list', '--limit', '5'],
      ['tether', 'history', 'show', 'abc', '--json'],
    ])
  })

  it('asks a model with prompt-model; ask points there and at tether ask', async () => {
    const h = aico()
    await h.go(['prompt-model', 'haiku', 'hi'])
    expect(h.calls[0]?.argv.slice(1)).toEqual(['prompt-model', 'haiku', 'hi'])
    expect(await h.go(['ask', 'haiku', 'hi'])).toBe(2)
    expect(h.errors.join()).toMatch(/aico prompt-model MODEL.*tether ask create/)
    expect(h.calls).toHaveLength(1)
  })
})

describe('the launcher', () => {
  it('routes every command the CLI hands it (aico away once fell through to unknown command)', () => {
    const script = readFileSync(
      resolve(import.meta.dirname, '../../web-server/scripts/aico'),
      'utf8',
    )
    const routed = new Set(
      [...script.matchAll(/^ {2}([a-z-]+(?: \| [a-z-]+)*)\)/gm)].flatMap((m) => m[1].split(' | ')),
    )
    expect([...NATIVE].filter((verb) => !routed.has(verb))).toEqual([])
  })
})
