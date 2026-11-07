import { expect, it } from 'vitest'
import { isTestRun, TEST_RUN_TOKENS } from './test-runs'

it('marks smoke, tmp and junk runs', () => {
  for (const project of [
    'tmp',
    'aico-m10d2-live',
    'm10b-live-x1',
    'commit-try',
    'live-smoke-codex-2434323-8364',
  ])
    expect(isTestRun({ project, cwd: null }), project).toBe(true)
  expect(isTestRun({ project: null, cwd: '/tmp/foo' })).toBe(true)
  expect(isTestRun({ project: null, cwd: '/srv/scratch/a/b' })).toBe(true)
  expect(isTestRun({ project: null, cwd: '/var/tmp' })).toBe(true)
  expect(isTestRun({ project: null, cwd: '/home/kasadis/work/probe-2' })).toBe(true)
})

it('leaves real projects alone', () => {
  for (const project of ['aico', 'agent-skills', 'security-research', 'portfolio-ai', 'ominull'])
    expect(isTestRun({ project, cwd: `/srv/workspaces/projects/${project}` }), project).toBe(false)
  expect(isTestRun({ project: null, cwd: null })).toBe(false)
  expect(isTestRun({ project: null, cwd: '/tmpfoo/x' })).toBe(false)
})

it('judges by the one token list', () => {
  for (const token of TEST_RUN_TOKENS) expect(isTestRun({ project: `a-${token}-9` })).toBe(true)
})
