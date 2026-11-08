import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = resolve(__dirname, '../../../scripts/standby-disk.sh')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A disk of `freeGib` free out of 32, as df reports it. */
function run(freeGib: number, minFree: string) {
  const dir = mkdtempSync(join(tmpdir(), 'standby-disk-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'df'),
    `#!/bin/sh\necho Filesystem 1024-blocks Used Available Capacity Mounted\necho x ${32 * 1048576} 0 ${freeGib * 1048576} 0% /\n`,
  )
  chmodSync(join(dir, 'df'), 0o755)
  return spawnSync('bash', [script, minFree], {
    encoding: 'utf8',
    env: { PATH: `${dir}:/usr/bin:/bin`, AICO_DATA_DIR: dir, HOME: dir },
  })
}

it('is quiet and clean while there is room', () => {
  const ok = run(13, '6')
  expect(ok.status).toBe(0)
  expect(ok.stdout.trim()).toBe('13 GiB free of 32.')
})

it('fails below the line and names how much is left', () => {
  const low = run(5, '6')
  expect(low.status).toBe(1)
  expect(low.stdout).toContain('Only 5 GiB free of 32 GiB')
})
