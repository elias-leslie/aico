import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { config } from './backup-plan'
import { retainDrive, verifyDrive } from './backup-retention'
import type { Runtime } from './backup-runtime'

const folders: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-retention-'))
  folders.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true })
})
const runtime = (lockedFor: (verb: string, tries: number) => boolean) => {
  const cfg = config({})
  cfg.stateDir = temp()
  cfg.cacheDir = temp()
  cfg.rootCacheDir = temp()
  const tries = new Map<string, number>()
  const run = vi.fn(async (argv: string[]) => {
    const verb = ['forget', 'check', 'prune', 'unlock'].find((v) => argv.includes(v)) as string
    tries.set(verb, (tries.get(verb) ?? 0) + 1)
    return lockedFor(verb, tries.get(verb) as number)
      ? { code: 11, out: '', err: 'unable to create lock in backend: repository is already locked' }
      : { code: 0, out: '[]', err: '' }
  })
  const rt: Runtime = { cfg, run, now: () => new Date('2026-11-08T12:00:00Z') }
  return { rt, run, tries }
}
const called = (run: ReturnType<typeof runtime>['run']) => run.mock.calls.map(([argv]) => argv)

it("a dead process's lock doesn't stop retention: only stale locks are cleared, then forget runs again", async () => {
  const { rt, run, tries } = runtime((verb, n) => verb === 'forget' && n === 1)
  const state = { goodDriveRuns: 0 }
  await retainDrive(rt, state as never)
  expect(tries.get('unlock')).toBe(1)
  expect(tries.get('forget')).toBe(2)
  expect(state.goodDriveRuns).toBe(1)
  expect(called(run).flat()).not.toContain('--remove-all')
})

it('a live lock unlock leaves in place still fails retention, after one more try', async () => {
  const { rt, tries } = runtime((verb) => verb === 'forget')
  await expect(retainDrive(rt, { goodDriveRuns: 0 } as never)).rejects.toThrow(/exit 11/)
  expect(tries.get('forget')).toBe(2)
  expect(tries.get('unlock')).toBe(1)
})

it('no lock, no unlock', async () => {
  const { rt, tries } = runtime(() => false)
  await retainDrive(rt, { goodDriveRuns: 0 } as never)
  expect(tries.get('unlock')).toBeUndefined()
})

it("the weekly check and prune also get past a dead process's lock", async () => {
  const { rt, tries } = runtime((verb, n) => (verb === 'check' || verb === 'prune') && n === 1)
  rt.now = () => {
    const at = new Date('2026-11-08T12:00:00Z')
    at.setDate(at.getDate() + ((rt.cfg.verify.day - at.getDay() + 7) % 7))
    return at
  }
  await verifyDrive(rt, true)
  expect(tries.get('check')).toBe(2)
  expect(tries.get('prune')).toBe(2)
  expect(tries.get('unlock')).toBe(2)
})
