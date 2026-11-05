import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { trackedFiles } from './check'
import { runCli } from './cli'
import { loadConfig, plan } from './plan'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'aico-legacy-gate-'))
  roots.push(root)
  execFileSync('git', ['init', '-q'], { cwd: root })
  return root
}
function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text, { mode: 0o755 })
}
function config(root: string) {
  const loaded = loadConfig(root)
  if ('unsupported' in loaded) throw new Error(loaded.unsupported)
  return loaded
}
const coordination = { foreign: () => ({}), guard: () => null, committed: () => '' }

it('keeps docs-only repos applicable only to security checks', () => {
  const root = repo()
  write(root, 'README.md', 'Documentation\n')
  const steps = plan(config(root), 'quick', ['README.md'], () => trackedFiles(root))
  expect(steps.filter((item) => item.step).map((item) => item.id)).toEqual(['gitleaks'])
  expect(steps.find((item) => item.id === 'pytest')?.skip).toBe('no_python_inputs')
  expect(steps.find((item) => item.id === 'tsc')?.skip).toBe('no_tsconfig')
})

it('retains backend and frontend suites, working directories and the full security gate', () => {
  const root = repo()
  write(root, 'backend/tests/test_a.py', 'def test_a(): pass\n')
  write(root, 'frontend/package.json', '{"scripts":{"test":"vitest run"}}')
  write(root, 'frontend/tsconfig.json', '{}')
  write(root, 'frontend/biome.json', '{}')
  write(root, 'package-lock.json', '{}')
  write(root, '.semgrep.yml', 'rules: []')
  const steps = plan(config(root), 'full', null, () => trackedFiles(root))
  expect(steps.filter((item) => item.step).map((item) => item.id)).toEqual([
    'ruff',
    'types',
    'pytest',
    'biome',
    'tsc',
    'vitest',
    'gitleaks',
    'osv',
    'semgrep',
  ])
  expect(steps.find((item) => item.id === 'pytest')?.step?.cwd).toBe('backend')
  expect(steps.find((item) => item.id === 'vitest')?.step?.cwd).toBe('frontend')
})

it('keeps aggregate package scripts and hooks in the full gate', () => {
  const root = repo()
  write(
    root,
    'package.json',
    '{"packageManager":"pnpm@10.0.0","scripts":{"test:ci":"node test.mjs","pretest:ci":"node setup.mjs"}}',
  )
  expect(
    plan(config(root), 'full', null, () => []).find((item) => item.id === 'frontend-test')?.step
      ?.argv,
  ).toEqual(['pnpm', 'run', 'test:ci'])
  expect(
    plan(config(root), 'quick', ['src/a.ts'], () => []).find((item) => item.id === 'frontend-test')
      ?.skip,
  ).toContain('package_script')
})

it('uses the caller PATH for focused checks and keeps focused pytest serial with coverage disabled', async () => {
  const root = repo()
  write(root, '.st-check.toml', '[pytest]\nworkers=4\n')
  write(root, 'tests/test_a.py', 'def test_a(): pass\n')
  write(root, 'bin/pytest', `#!/bin/sh\n[ "$*" = "-q --tb=short --no-cov tests/test_a.py" ]\n`)
  expect(
    await runCli('check', ['pytest', '--', 'tests/test_a.py'], {
      cwd: root,
      env: { PATH: join(root, 'bin') },
      coordination,
      out: () => {},
      err: () => {},
    }),
  ).toBe(0)
})

it('does not hide a broken explicitly configured environment', async () => {
  const root = repo()
  write(root, '.st-check.toml', '[paths]\npytest="missing-bin"\n')
  write(root, 'tests/test_a.py', 'def test_a(): pass\n')
  expect(
    await runCli('check', ['pytest'], {
      cwd: root,
      env: { PATH: '/missing' },
      coordination,
      out: () => {},
      err: () => {},
    }),
  ).toBe(1)
})
