import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runCli } from './cli'
import { loadConfig, plan } from './plan'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aico-focused-check-'))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/vitest'), '#!/bin/sh\nprintf "%s\\n" "$@"\n')
  chmodSync(join(root, 'bin/vitest'), 0o755)
  writeFileSync(join(root, 'bin/pytest'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(root, 'bin/pytest'), 0o755)
  return root
}
const coordination = { foreign: () => ({}), guard: () => null, committed: () => '' }

it('retains the service acceptance artifact independently of the reuse cache', async () => {
  const { accept } = await import('./accept')
  const root = fixture()
  writeFileSync(join(root, '.st-check.toml'), '[native]\nlegacy_tools=[]\n')
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Source'],
    { cwd: root },
  )
  const config = loadConfig(root)
  if ('unsupported' in config) throw new Error(config.unsupported)
  const first = await accept(config, { coordination })
  const path = join(root, '.git/aico-checks/receipts', `accept-${first.tree}.json`)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
    passed: true,
    tree: first.tree,
    scope: null,
  })
  rmSync(path)
  expect((await accept(config, { coordination })).passed).toBe(true)
  expect(JSON.parse(readFileSync(path, 'utf8')).tree).toBe(first.tree)
})
it('runs a selected declared native stage through Aico', async () => {
  const root = fixture()
  writeFileSync(
    join(root, '.st-check.toml'),
    `[native]\nlegacy_tools=[]\n[native.tools]\nnode=${JSON.stringify(process.execPath)}\n[[native.stages]]\nid="focused"\ncoverage="focused"\ncovered_by="whole"\nargv=["node","-e","console.log('selected stage')"]\n`,
  )
  const lines: string[] = []
  expect(
    await runCli('check', ['--native', '--stage', 'focused', '--no-reuse'], {
      cwd: root,
      env: {},
      coordination,
      out: (s) => lines.push(s),
      err: (s) => lines.push(s),
    }),
  ).toBe(0)
  expect(lines.join()).toContain('focused')
})
it('keeps focused tool arguments and exit status without SF fallback', async () => {
  const root = fixture()
  writeFileSync(join(root, '.st-check.toml'), '[paths]\nvitest="bin"\n[native]\nlegacy_tools=[]\n')
  expect(
    await runCli('check', ['vitest', '--', '--project', 'cli'], {
      cwd: root,
      env: {},
      coordination,
      out: () => {},
      err: () => {},
    }),
  ).toBe(0)
  const details = readFileSync(
    join(root, '.dev-tools', `vitest-${process.pid}-details.txt`),
    'utf8',
  )
  expect(details).toContain('--project cli')
})
it('does not rediscover pytest when a native stage owns that suite', () => {
  const root = fixture()
  writeFileSync(
    join(root, '.st-check.toml'),
    '[paths]\npytest="bin"\n[native]\nlegacy_tools=[]\n[[native.stages]]\nid="host-tests"\ncoverage="full"\nquick=true\nquick_paths=["native/host/**"]\nargv=["bin/pytest","native/host/tests"]\n',
  )
  const config = loadConfig(root)
  if ('unsupported' in config) throw new Error(config.unsupported)
  expect(
    plan(config, 'quick', ['native/st-sdk/tests/test_sdk.py'], () => []).some(
      (p) => p.id === 'pytest',
    ),
  ).toBe(false)
})

it('formats scoped Python when a native stage owns Ruff', async () => {
  const { fixScope } = await import('./check')
  const root = fixture()
  writeFileSync(join(root, 'source.py'), 'x=1\n')
  writeFileSync(
    join(root, '.st-check.toml'),
    '[paths]\nruff="bin"\n[native]\nlegacy_tools=[]\n[[native.stages]]\nid="ruff"\ncoverage="full"\nargv=["bin/ruff","check","."]\n',
  )
  const config = loadConfig(root)
  if ('unsupported' in config) throw new Error(config.unsupported)
  expect(fixScope(config, ['source.py']).map((item) => item.files)).toEqual([['source.py']])
})

it.each([
  { extra: 'paths=[".venv/bin"]\n', argv: '.venv/bin/python' },
  { extra: '[native.tools]\npython=".venv/bin/python"\n', argv: 'python' },
  { extra: '', argv: '.venv/bin/python' },
])(
  'links declared native Python environments into isolated acceptance (%j)',
  async ({ extra, argv }) => {
    const { accept } = await import('./accept')
    const root = fixture()
    mkdirSync(join(root, '.venv/bin'), { recursive: true })
    writeFileSync(join(root, '.venv/bin/python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(root, '.gitignore'), '.venv/\n.dev-tools/\n')
    writeFileSync(
      join(root, '.st-check.toml'),
      `[native]\nlegacy_tools=[]\n${extra}\n[[native.stages]]\nid="python-check"\nkind="check"\ncoverage="full"\nargv=[${JSON.stringify(argv)}]\n`,
    )
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
        'Native gate',
      ],
      { cwd: root },
    )
    const config = loadConfig(root)
    if ('unsupported' in config) throw new Error(config.unsupported)
    expect(config.environmentInputs).toContain('.venv')
    expect((await accept(config, { coordination, reuse: false })).passed).toBe(true)
  },
)

it.each([true, false])(
  'runs legacy-default project checks without a native section (config=%s)',
  async (hasConfig) => {
    const root = fixture()
    if (hasConfig) writeFileSync(join(root, '.st-check.toml'), '[paths]\npytest="bin"\n')
    writeFileSync(join(root, 'test_example.py'), 'def test_example(): pass\n')
    const config = loadConfig(root)
    if ('unsupported' in config) throw new Error(config.unsupported)
    expect(config.legacy).toContain('pytest')
    expect(config.environmentInputs).toContain('.venv')
    const lines: string[] = []
    expect(
      await runCli('check', ['pytest', '--', '--version'], {
        cwd: root,
        env: { PATH: join(root, 'bin') },
        coordination,
        out: (s) => lines.push(s),
        err: (s) => lines.push(s),
      }),
    ).toBe(0)
  },
)

it.each([
  [
    '[native]\nmanaged_environment_inputs=[".venv"]\n',
    'unknown key native.managed_environment_inputs; did you mean environment_inputs?',
  ],
  [
    '[native]\nlegacy_tools=[]\n[[native.stages]]\nid="a"\nargv=["x"]\ncoverage="full"\nquik=true\n',
    'unknown key native.stages[0].quik; did you mean quick?',
  ],
  ['[pytest]\nno_cov=false\nworkres=2\n', 'unknown key pytest.workres; did you mean workers?'],
  ['[nativ]\nx=1\n', 'unknown key nativ; did you mean native?'],
])('rejects an unknown .st-check.toml key and names the nearest one (%#)', (text, message) => {
  const root = fixture()
  writeFileSync(join(root, '.st-check.toml'), text)
  expect(() => loadConfig(root)).toThrow(`${join(root, '.st-check.toml')}: ${message}`)
})

it('fails acceptance at once when a declared environment input is not prepared', async () => {
  const { accept } = await import('./accept')
  const root = fixture()
  writeFileSync(
    join(root, '.st-check.toml'),
    '[native]\nlegacy_tools=[]\nenvironment_inputs=["backend/.venv","node_modules"]\n',
  )
  execFileSync('git', ['add', '-A'], { cwd: root })
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Source'],
    { cwd: root },
  )
  const config = loadConfig(root)
  if ('unsupported' in config) throw new Error(config.unsupported)
  await expect(accept(config, { coordination, reuse: false })).rejects.toThrow(
    `environment not prepared: backend/.venv missing in ${root}; run the repo's setup (e.g. uv sync / pnpm install)`,
  )
})
it('checks commit arguments alone when the launcher asks, before it queues for the heavy lane', async () => {
  const root = fixture()
  const errors: string[] = []
  const io = (env: NodeJS.ProcessEnv) => ({
    cwd: root,
    env,
    coordination,
    out: () => {},
    err: (line: string) => errors.push(line),
  })
  const env = { AICO_CHECKS_ARGS_ONLY: '1' }
  expect(await runCli('commit', ['--dry-run', '-m', 'x', '--paths', 'a'], io(env))).toBe(2)
  expect(errors[0]).toBe('st commit: unsupported --dry-run')
  // An error names the command as it was typed.
  errors.length = 0
  await runCli(
    'commit',
    ['--dry-run', '-m', 'x', '--paths', 'a'],
    io({ ...env, AICO_CLI_NAME: 'aico' }),
  )
  expect(errors[0]).toBe('aico commit: unsupported --dry-run')
  // Valid arguments stop before loading the repo gate (this fixture has none).
  expect(await runCli('commit', ['-m', 'x', '--paths', 'a'], io(env))).toBe(0)
})
