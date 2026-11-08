import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { sweepRuns } from './vitest-tmp'

it('a test’s temp folders live in the run’s own folder, which the run removes', () => {
  expect(tmpdir()).toMatch(/\/vt-\d+$/)
})

it('removes only the folders of runs that have ended', () => {
  const top = mkdtempSync(join(tmpdir(), 'sweep-'))
  for (const name of ['vt-11', 'vt-22', 'vt-x', 'aico-tray-33']) {
    mkdirSync(join(top, name))
  }
  expect(sweepRuns(top, (pid) => pid === 22)).toEqual(['vt-11'])
  expect(existsSync(join(top, 'vt-11'))).toBe(false)
  expect(existsSync(join(top, 'vt-22'))).toBe(true)
  expect(existsSync(join(top, 'vt-x'))).toBe(true)
  expect(existsSync(join(top, 'aico-tray-33'))).toBe(true)
})
