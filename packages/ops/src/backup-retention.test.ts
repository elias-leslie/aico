import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { config, emptyState } from './backup-plan'
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
  await retainDrive(rt, state as never, rt.cfg.workstation)
  expect(tries.get('unlock')).toBe(1)
  expect(tries.get('forget')).toBe(2)
  expect(state.goodDriveRuns).toBe(1)
  expect(called(run).flat()).not.toContain('--remove-all')
})

it('a live lock unlock leaves in place still fails retention, after one more try', async () => {
  const { rt, tries } = runtime((verb) => verb === 'forget')
  await expect(retainDrive(rt, { goodDriveRuns: 0 } as never, rt.cfg.workstation)).rejects.toThrow(
    /exit 11/,
  )
  expect(tries.get('forget')).toBe(2)
  expect(tries.get('unlock')).toBe(1)
})

it('no lock, no unlock', async () => {
  const { rt, tries } = runtime(() => false)
  await retainDrive(rt, { goodDriveRuns: 0 } as never, rt.cfg.workstation)
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

it.each(['davion-sidarli', 'aico'])(
  'retention selects only the current controller’s exact source groups (%s)',
  async (machine) => {
    const { rt, run } = runtime(() => false)
    Object.assign(rt.cfg, config({ AICO_BACKUP_MACHINE: machine }), {
      stateDir: rt.cfg.stateDir,
      cacheDir: rt.cfg.cacheDir,
      rootCacheDir: rt.cfg.rootCacheDir,
    })
    await retainDrive(rt, emptyState(), machine)
    const command = called(run).find((argv) => argv.includes('forget')) as string[]
    const tags = command.flatMap((arg, index) => (arg === '--tag' ? [command[index + 1]] : []))
    expect(tags).toEqual(
      machine === rt.cfg.workstation
        ? [
            'offsite,source:aico-davion-sidarli',
            'offsite,source:blackbox-vault-archive',
            'offsite,source:home',
            'offsite,source:root',
            'offsite,source:workspaces',
          ]
        : [
            'offsite,source:aico-aico',
            'offsite,source:ominull-production-state',
            'offsite,source:pve-cluster-config',
            'offsite,source:pve-ct-190-aico-data',
            'offsite,source:pve-ct-191-jobinator-data',
            'offsite,source:pve-host-files',
            'offsite,source:pve-vm-100-browser-state',
            'offsite,source:pve-vm-180-app-recovery',
            'offsite,source:pve-vm-210-dadbot-data',
          ],
    )
    expect(command).toContain('--keep-daily')
    expect(command[command.indexOf('--keep-daily') + 1]).toBe(String(rt.cfg.retention.drive.daily))
  },
)
it('the legacy sweep never deletes moved or mixed-owner source history', async () => {
  const { rt } = runtime(() => false)
  const ownOld = 'a'.repeat(64),
    ownNew = 'b'.repeat(64),
    movedOld = 'c'.repeat(64),
    movedNew = 'd'.repeat(64),
    mixed = 'e'.repeat(64)
  const snapshots = [
    { id: ownOld, time: '2026-01-01T00:00:00Z', tags: ['source:blackbox-vault-archive'] },
    { id: ownNew, time: '2026-11-08T00:00:00Z', tags: ['source:blackbox-vault-archive'] },
    { id: movedOld, time: '2026-01-01T00:00:00Z', tags: ['source:pve-vm-180-app-recovery'] },
    { id: movedNew, time: '2026-02-01T00:00:00Z', tags: ['source:pve-vm-180-app-recovery'] },
    {
      id: mixed,
      time: '2026-01-01T00:00:00Z',
      tags: ['source:blackbox-vault-archive', 'source:pve-vm-180-app-recovery'],
    },
  ]
  const run = vi.fn(async (argv: string[]) => ({
    code: 0,
    out: JSON.stringify(argv.includes('snapshots') ? snapshots : []),
    err: '',
  }))
  rt.run = run
  const state = emptyState()
  state.goodDriveRuns = rt.cfg.retention.drive.legacyAfterGoodRuns
  await retainDrive(rt, state, rt.cfg.workstation)
  const forgets = run.mock.calls.map(([argv]) => argv).filter((argv) => argv.includes('forget'))
  expect(forgets).toHaveLength(2)
  expect(forgets[1]?.slice((forgets[1]?.indexOf('forget') ?? 0) + 1)).toEqual([ownOld])
  expect(forgets.flat()).not.toEqual(expect.arrayContaining([movedOld, movedNew, mixed, ownNew]))
})
