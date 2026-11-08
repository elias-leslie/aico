import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { accept } from './accept'
import { type FixtureRuntime, withAcceptanceFixture } from './fixture'
import { loadConfig, plan } from './plan'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function write(root: string, path: string, contents: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), contents, { mode: 0o755 })
}
function repo(extra: string) {
  const root = mkdtempSync(join(tmpdir(), 'aico-check-fixture-'))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  write(root, '.gitignore', '.dev-tools/\n.venv/\nnode_modules/\n')
  write(root, '.st-check.toml', `[native]\nlegacy_tools=["pytest"]\n${extra}`)
  return root
}
function config(root: string) {
  const loaded = loadConfig(root)
  if ('unsupported' in loaded) throw new Error(loaded.unsupported)
  return loaded
}
const service = `
[acceptance]
host_tools=["node"]
[acceptance.env]
DATABASE_URL="postgresql://fixture@localhost:5432/test"
[acceptance.pytest]
argv=["pytest","--run-integration","-m","not private_context"]
setup=[["alembic","upgrade","head"]]
[acceptance.pytest.services.postgres]
image="postgres:16"
env={POSTGRES_USER="fixture",POSTGRES_DB="test"}
`
function host(fail?: 'run' | 'port' | 'exec') {
  const calls: string[][] = []
  let now = 0
  const runtime: FixtureRuntime = {
    which: (name) =>
      name === 'docker' ? '/test/docker' : name === 'node' ? process.execPath : undefined,
    run: async (argv) => {
      calls.push(argv)
      const command = argv[1]
      return {
        code: command === fail ? 1 : 0,
        output: command === 'port' ? '127.0.0.1:31415\n' : '',
      }
    },
    now: () => now,
    pause: async () => {
      now += 61_000
    },
  }
  return { runtime, calls }
}

it('keeps declared pytest argv, setup and clean env while rewriting only the disposable database port', async () => {
  const root = repo(service)
  const fake = host()
  await withAcceptanceFixture(
    config(root),
    plan(config(root), 'full', null, () => []),
    join(root, 'scratch'),
    { DATABASE_URL: 'owner-value', OWNER_SECRET: 'owner-value', ST_CHECK_SEED: '42' },
    async (steps, env) => {
      expect(env.OWNER_SECRET).toBeUndefined()
      expect(env.DATABASE_URL).toBe('postgresql://fixture@127.0.0.1:31415/test')
      expect(env.PGPORT).toBe('31415')
      expect(env.ST_CHECK_SEED).toBe('42')
      expect(steps[0].step?.argv).toEqual([
        'pytest',
        '--run-integration',
        '-m',
        'not private_context',
      ])
      expect(steps[0].step?.setup).toEqual([['alembic', 'upgrade', 'head']])
    },
    fake.runtime,
  )
  expect(fake.calls.map((argv) => argv[1])).toEqual(['run', 'port', 'exec', 'rm'])
  expect(fake.calls[0]).toContain('127.0.0.1::5432')
  expect(fake.calls[0]).toContain('--tmpfs')
})

it.each(['run', 'port', 'exec'] as const)(
  'removes partially started service containers after %s failure',
  async (fail) => {
    const root = repo(service)
    const fake = host(fail)
    await expect(
      withAcceptanceFixture(
        config(root),
        plan(config(root), 'full', null, () => []),
        join(root, 'scratch'),
        {},
        async () => true,
        fake.runtime,
      ),
    ).rejects.toThrow(/did not/)
    expect(fake.calls.at(-1)?.slice(1, 3)).toEqual(['rm', '-f'])
  },
)

it('removes services when setup or tests fail and preserves the failure', async () => {
  const root = repo(service)
  const fake = host()
  await expect(
    withAcceptanceFixture(
      config(root),
      plan(config(root), 'full', null, () => []),
      join(root, 'scratch'),
      {},
      async () => {
        throw new Error('setup failed')
      },
      fake.runtime,
    ),
  ).rejects.toThrow('setup failed')
  expect(fake.calls.at(-1)?.slice(1, 3)).toEqual(['rm', '-f'])
})

it('does not start fixture services when pytest is not selected', async () => {
  const root = repo(service)
  const fake = host()
  await withAcceptanceFixture(
    config(root),
    [],
    join(root, 'scratch'),
    {},
    async () => true,
    fake.runtime,
  )
  expect(fake.calls).toEqual([])
})

it('passes only explicitly declared owner environment keys to acceptance', async () => {
  const root = repo('[acceptance]\npass_env=["TEST_PASSTHROUGH"]\n')
  await withAcceptanceFixture(
    config(root),
    [],
    join(root, 'scratch'),
    { TEST_PASSTHROUGH: 'allowed', TEST_OTHER: 'excluded' },
    async (_steps, env) => {
      expect(env.TEST_PASSTHROUGH).toBe('allowed')
      expect(env.TEST_OTHER).toBeUndefined()
    },
    host().runtime,
  )
})

it('runs committed acceptance setup before its exact pytest invocation in the worktree', async () => {
  const root = repo(`
[acceptance]
host_tools=["node"]
[acceptance.env]
FIXTURE_ENV="test"
[acceptance.pytest]
working_directory="backend"
argv=["node","test.cjs","--run-integration","-m","not private_context"]
setup=[["node","setup.cjs"]]
`)
  write(
    root,
    'backend/setup.cjs',
    `require('fs').writeFileSync('prepared.txt',process.env.FIXTURE_ENV || 'missing')`,
  )
  write(
    root,
    'backend/test.cjs',
    `const fs=require('fs'); if(fs.readFileSync('prepared.txt','utf8')!=='test' || process.argv.slice(2).join(' ')!=='--run-integration -m not private_context' || process.cwd()===${JSON.stringify(join(root, 'backend'))}) process.exit(1)`,
  )
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Fixture'],
    { cwd: root },
  )
  const report = await accept(config(root), {
    reuse: false,
    coordination: { foreign: () => ({}), guard: () => null, committed: () => '' },
  })
  expect(report.passed).toBe(true)
  expect(
    readFileSync(join(root, '.dev-tools', `pytest-${process.pid}-details.txt`), 'utf8'),
  ).toContain('--run-integration -m not private_context')
})

it('fails acceptance on setup failure without running the suite', async () => {
  const root = repo(`
[acceptance]
host_tools=["node"]
[acceptance.pytest]
argv=["node","-e","process.exit(0)"]
setup=[["node","-e","console.log('setup failed'); process.exit(1)"]]
`)
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Fixture failure',
    ],
    { cwd: root },
  )
  const report = await accept(config(root), {
    reuse: false,
    coordination: { foreign: () => ({}), guard: () => null, committed: () => '' },
  })
  expect(report.passed).toBe(false)
  expect(report.results.find((result) => result.id === 'pytest')?.state).toBe('fail')
})

it('links implicit ignored dependency environments in legacy acceptance', async () => {
  const root = repo('')
  write(root, '.st-check.toml', '[paths]\ngitleaks="bin"\n[acceptance]\nhost_tools=["node"]\n')
  write(root, 'package.json', '{"scripts":{"test":"node test.cjs"}}')
  write(
    root,
    'test.cjs',
    `if(require('test-dependency')!==42 || !require('fs').existsSync('.venv/bin/python')) process.exit(1)`,
  )
  write(root, 'node_modules/test-dependency/index.js', 'module.exports=42')
  write(root, '.venv/bin/python', '#!/bin/sh\nexit 0\n')
  write(root, 'bin/gitleaks', '#!/bin/sh\nexit 0\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'Legacy environment',
    ],
    { cwd: root },
  )
  const report = await accept(config(root), {
    reuse: false,
    coordination: { foreign: () => ({}), guard: () => null, committed: () => '' },
  })
  expect(report.passed).toBe(true)
  expect(report.results.find((result) => result.id === 'frontend-test')?.state).toBe('pass')
})
