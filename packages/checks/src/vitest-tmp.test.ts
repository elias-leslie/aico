import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import setup, { sweepRuns } from './vitest-tmp'

afterEach(() => {
  vi.unstubAllEnvs()
})

const sandbox = () => mkdtempSync(join(tmpdir(), 'sweep-'))

it('a test’s temp folders live in the run’s own folder, which the run removes', () => {
  const top = sandbox()
  vi.stubEnv('TMPDIR', top)
  const done = setup()
  const own = tmpdir()
  expect(own).toBe(join(top, `vt-${process.pid}`))
  expect(existsSync(own)).toBe(true)
  done()
  expect(existsSync(own)).toBe(false)
})

it('removes only the folders of runs that have ended', () => {
  const top = sandbox()
  for (const name of ['vt-11', 'vt-22', 'vt-x', 'vt-5000-backup', 'vt-123abc', 'aico-tray-33'])
    mkdirSync(join(top, name))
  writeFileSync(join(top, 'vt-44'), 'not a folder')
  expect(sweepRuns(top, (pid) => pid === 22)).toEqual(['vt-11'])
  for (const name of ['vt-22', 'vt-x', 'vt-5000-backup', 'vt-123abc', 'aico-tray-33', 'vt-44'])
    expect(existsSync(join(top, name))).toBe(true)
  expect(existsSync(join(top, 'vt-11'))).toBe(false)
})

it('a run folder it can’t remove stays and doesn’t stop the run', () => {
  const top = sandbox()
  const stuck = join(top, 'vt-11', 'locked')
  mkdirSync(stuck, { recursive: true })
  writeFileSync(join(stuck, 'inside.txt'), 'x')
  chmodSync(stuck, 0o000)
  try {
    expect(sweepRuns(top, () => false)).toEqual([])
  } finally {
    chmodSync(stuck, 0o700)
  }
})

it('makes its own folder over a dead run’s with the same pid, and ends as it started', () => {
  const top = sandbox()
  vi.stubEnv('TMPDIR', top)
  const leftover = join(top, `vt-${process.pid}`)
  mkdirSync(leftover)
  writeFileSync(join(leftover, 'old.txt'), 'x')
  const done = setup()
  expect(tmpdir()).toBe(leftover)
  expect(existsSync(join(leftover, 'old.txt'))).toBe(false)
  done()
  expect(tmpdir()).toBe(top)
  expect(existsSync(leftover)).toBe(false)
})

it('takes what Vitest passes its global setup without sweeping by it', () => {
  const top = sandbox()
  vi.stubEnv('TMPDIR', top)
  mkdirSync(join(top, 'vt-999999'))
  const vitestSetup = setup as unknown as (project: object) => () => void
  const done = vitestSetup({ name: 'a project' })
  done()
  expect(existsSync(join(top, 'vt-999999'))).toBe(false)
})
