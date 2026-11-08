import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { backupJob } from './backup-drive'
import { config, emptyState } from './backup-plan'
import { excludesPath, type Runtime } from './backup-runtime'

const temp = () => mkdtempSync(join(tmpdir(), 'backup-excludes-'))

it('a copy that mounts the home snapshot over /home needs no file from the live release', async () => {
  vi.stubEnv('XDG_RUNTIME_DIR', temp())
  const c = config({})
  Object.assign(c, { stateDir: temp(), cacheDir: temp(), rootCacheDir: temp() })
  const calls: string[][] = []
  const rt: Runtime = {
    cfg: c,
    run: async (argv) => {
      calls.push(argv)
      return { code: 0, out: '{"snapshot_id":"abc","total_bytes_processed":1}\n', err: '' }
    },
    now: () => new Date('2026-11-08T17:00:00Z'),
  }
  await backupJob(rt, emptyState(), {
    id: 'home',
    paths: ['/home'],
    binds: [['/home/.btrbk/home.old', '/home']],
    dataAt: '2026-11-08T14:44:00Z',
  })
  const argv = calls[0] ?? []
  // A release deployed after the snapshot isn't in it, so restic couldn't open its excludes file.
  expect(argv).not.toContain('--exclude-file')
  expect(argv).not.toContain(excludesPath())
  const given = argv.flatMap((arg, i) => (arg === '--exclude' ? [argv[i + 1]] : []))
  expect(given).toEqual(expect.arrayContaining(['node_modules', '.venv', '.cache']))
  expect(given.some((pattern) => pattern?.startsWith('#'))).toBe(false)
  expect(given).not.toContain('')
  vi.unstubAllEnvs()
})
