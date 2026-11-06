import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openTasksDb } from '@aico/tasks'
import { afterEach, describe, expect, it } from 'vitest'
import { catalog, extensionEnvironment, parseBinding, passiveHelp } from './extensions'
import { main } from './main'

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
function harness(env: NodeJS.ProcessEnv = {}) {
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
        cwd: root,
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
  it('keeps checked-main delivery on the registered CLI-only transport', async () => {
    const dir = temp(),
      state = join(dir, 'services'),
      owner = join(state, 'projects/summitflow'),
      accepted = join(owner, 'releases/accepted/source'),
      leaf = join(accepted, 'backend/.venv/bin/st')
    mkdirSync(join(accepted, 'backend/.venv/bin'), { recursive: true })
    writeFileSync(leaf, 'fixture', { mode: 0o755 })
    symlinkSync(join(owner, 'releases/accepted'), join(owner, 'current'))
    const { Registry } = await import('@aico/tasks')
    const file = join(dir, 'tasks.db'),
      db = openTasksDb(file)
    new Registry(db).register({ id: 'summitflow', root: accepted })
    db.close()
    const h = harness({ HOME: dir, AICO_TASKS_DB: file, SUMMITFLOW_SERVICE_STATE_ROOT: state })
    const args = ['--root', root, '--sha', 'a'.repeat(40)]
    expect(await h.go(['vcs', 'deliver', ...args])).toBe(0)
    expect(h.calls[0]?.argv).toEqual([leaf, 'vcs', 'deliver', ...args])
    expect(h.calls).toHaveLength(1)
  })
  it.each(['workflow', 'automations', 'ctx', 'native-sessions', 'note'])(
    'retires %s without executing Agent Hub',
    async (verb) => {
      const h = harness()
      expect(await h.go([verb, '--help'])).toBe(2)
      expect(h.calls).toEqual([])
      expect(h.errors.join(' ')).toContain('dropped')
      expect(
        catalog(join(root, 'packages/cli/data'), '/missing', new Set()).some(
          (entry) => entry.binding.namespace === verb,
        ),
      ).toBe(false)
    },
  )
  it.each([
    ['create', 'tasks', 'create'],
    ['list', 'tasks', 'list'],
    ['context', 'tasks', 'context'],
    ['claim', 'tasks', 'claim'],
    ['done', 'tasks', 'done'],
    ['abandon', 'tasks', 'abandon'],
    ['log', 'tasks', 'log'],
    ['task', 'tasks'],
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
    'vm',
    'backups',
    'publish',
    'usage',
    'tasks',
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
  it('mockup add sends content and originating session to Aico', async () => {
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
            return new Response(JSON.stringify({ pageUrl: '/mockups?project=aico' }))
          }) as typeof fetch,
        },
      ),
    ).toBe(0)
    expect(JSON.parse(String(request?.body))).toMatchObject({
      html: '<p>test</p>',
      session: '1234abcd',
      project: 'aico',
    })
    expect(JSON.parse(output[0]).pageUrl).toBe('https://aico.summitflow.dev/mockups?project=aico')
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
  it('carries root project to native tasks and reads the ST_PROJECT_ID alias', async () => {
    const h = harness()
    expect(await h.go(['-P', 'selected', 'tasks', 'list'])).toBe(0)
    expect(h.calls[0]?.argv.slice(1)).toEqual(['tasks', 'list', '-P', 'selected'])
    const fromEnv = harness({ ST_PROJECT_ID: 'selected' })
    await fromEnv.go(['list'])
    expect(fromEnv.calls[0]?.argv.slice(1)).toEqual(['tasks', 'list', '-P', 'selected'])
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

it('passes the versioned Agent Hub context to the Aico session helper', async () => {
  const h = harness({ AGENT_HUB_URL: 'http://hub.test:8003' })
  expect(await h.go(['-P', 'aico', 'aico', 'create', 'proof'])).toBe(0)
  expect(JSON.parse(h.calls[0]?.env.ST_EXTENSION_CONTEXT || '{}')).toMatchObject({
    contract_version: 1,
    project_id: 'aico',
    cwd: root,
    agent_hub_url: 'http://hub.test:8003',
  })
})

it('keeps the verbose project registry read used by Agent Hub', async () => {
  const h = harness()
  expect(await h.go(['projects', 'list', '-v'])).toBe(0)
  expect(h.calls[0]?.argv.slice(1)).toEqual(['projects', 'list'])
})
