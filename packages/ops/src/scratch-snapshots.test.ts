import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { config } from './backup-plan'
import { scratchSnapshots } from './backup-retention'
import type { Runtime } from './backup-runtime'

const NOW = Date.parse('2026-11-08T12:00:00Z')
const GIB = 1024 ** 3
const roomy = () => 200 * GIB

/** A temp workspace root and store; the only "btrfs" is the stub below. */
function setup(points: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'aico-scratch-points-')),
    cfg = config({})
  cfg.retention.scratch = { ...cfg.retention.scratch, root, source: join(root, 'source') }
  const store = join(root, '.snapshots', cfg.retention.scratch.store)
  for (const point of points) mkdirSync(join(store, point), { recursive: true })
  const calls: string[][] = []
  const run: Runtime['run'] = async (argv) => {
    calls.push(argv)
    if (argv.includes('snapshot')) mkdirSync(argv.at(-1) as string)
    if (argv.includes(cfg.workSnapshotDeleteHelper))
      rmSync(argv.at(-3) as string, { recursive: true })
    return { code: 0, out: argv.includes('property') ? 'ro=true' : '', err: '' }
  }
  const rt: Runtime = { cfg, run, now: () => new Date(NOW) }
  return { rt, root, store, calls, left: () => readdirSync(store).sort() }
}
const day = (n: number) =>
  `${new Date(NOW - n * 86400000)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}-0000000${n}`

it('takes one when the newest is a day old, then keeps only the newest few', async () => {
  const { rt, store, calls, left } = setup([day(1), day(2), day(3)])
  expect(await scratchSnapshots(rt, true, false, roomy)).toBe(1)
  expect(calls[0]?.slice(0, 4)).toEqual(['btrfs', 'subvolume', 'snapshot', '-r'])
  expect(calls[0]?.[4]).toBe(rt.cfg.retention.scratch.source)
  expect(calls[0]?.[5]?.startsWith(`${store}/`)).toBe(true)
  expect(left()).toHaveLength(3)
  expect(left()).not.toContain(day(3))
  expect(left()).toContain(day(1))
})

it('takes nothing while the newest is under a day old, so a 30-minute routine costs one look', async () => {
  const { rt, calls, left } = setup([day(0)])
  expect(await scratchSnapshots(rt, true, false, roomy)).toBe(0)
  expect(calls).toEqual([])
  expect(left()).toEqual([day(0)])
})

it('after a long time off it takes one on the next run and raises nothing', async () => {
  const { rt, left } = setup([day(40)])
  expect(await scratchSnapshots(rt, true, false, roomy)).toBe(0)
  expect(left()).toHaveLength(2)
})

it('short of free space all go and none is taken; thresholds come from the data', async () => {
  const { rt, calls, left } = setup([day(1), day(2)])
  const line = rt.cfg.retention.scratch.stopBelowGib * GIB
  expect(await scratchSnapshots(rt, true, false, () => line - 1)).toBe(2)
  expect(left()).toEqual([])
  expect(calls.some((argv) => argv.includes('snapshot'))).toBe(false)
  expect(calls.at(-1)).toContain('sync')
})

it('under the space guard all go, whatever free space says', async () => {
  const { rt, left, calls } = setup([day(0), day(1)])
  expect(await scratchSnapshots(rt, true, true, roomy)).toBe(2)
  expect(left()).toEqual([])
  expect(calls.some((argv) => argv.includes('snapshot'))).toBe(false)
})

it('a manual run prunes nothing, as with work points', async () => {
  const { rt, left } = setup([day(1), day(2), day(3)])
  expect(await scratchSnapshots(rt, false, false, roomy)).toBe(0)
  expect(left()).toHaveLength(4)
})

it('touches nothing but its own points in its own folder', async () => {
  const { rt, root, store, left } = setup([
    day(1),
    day(2),
    day(3),
    day(4),
    'keep-me',
    'not-a-point',
  ])
  const work = join(root, '.snapshots', 'aico-autosnap', 'projects', 'workspace', day(9))
  mkdirSync(work, { recursive: true })
  await scratchSnapshots(rt, true, true, roomy)
  expect(left()).toEqual(['keep-me', 'not-a-point'])
  expect(readdirSync(join(root, '.snapshots', 'aico-autosnap', 'projects', 'workspace'))).toEqual([
    day(9),
  ])
  expect(store.startsWith(root)).toBe(true)
})

it('a failed snapshot throws nothing and keeps the older points', async () => {
  const { rt, left } = setup([day(1), day(2), day(3), day(4)])
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  rt.run = async () => ({ code: 1, out: '', err: 'no' })
  await expect(scratchSnapshots(rt, true, false, roomy)).resolves.toBe(0)
  expect(left()).toHaveLength(4)
  expect(errors).toHaveBeenCalledOnce()
  errors.mockRestore()
})

it('stays out of Drive and the T7, and its line is the storage check warning line', () => {
  const cfg = config({})
  expect(JSON.stringify(cfg.subvolumes)).not.toContain('/srv/scratch')
  expect(cfg.nativeSources).not.toContain('/srv/scratch')
  const checks = readFileSync(
    new URL('../../../native/host-steward/host_steward/data/checks.toml', import.meta.url),
    'utf8',
  )
  const value = (key: string) => Number(checks.match(new RegExp(`^${key} = (\\d+)`, 'm'))?.[1])
  expect(cfg.retention.scratch.stopBelowGib).toBe(value('reserve_gib') + value('warn_margin_gib'))
  expect(checks).toContain(
    `scratch_snapshots = "${join(cfg.retention.scratch.root, '.snapshots', cfg.retention.scratch.store)}"`,
  )
})
