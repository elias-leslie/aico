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
