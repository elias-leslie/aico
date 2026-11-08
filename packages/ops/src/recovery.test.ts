import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRow } from '@aico/status'
import { openDatabase } from '@aico/store'
import { afterEach, expect, it, vi } from 'vitest'
import { stageSqlite, standbyWork } from './backup-drive'
import { config } from './backup-plan'
import { drillRow, recovery, recoveryArgs } from './recovery'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('tests standalone recovery plans, read-only repository access and scratch cleanup', () => {
  const script = fileURLToPath(new URL('../scripts/test_recovery.py', import.meta.url))
  expect(() =>
    execFileSync('python3', [script], { cwd: dirname(script), stdio: 'pipe' }),
  ).not.toThrow()
})
it('routes recover and drill to plain scripts without a production operation', () => {
  expect(
    recoveryArgs(['recover', 'bootstrap', '--plan'], {
      AICO_RECOVERY_CONFIG: '/scratch/recovery.json',
    }).slice(2),
  ).toEqual(['--config', '/scratch/recovery.json', 'recover', 'bootstrap', '--plan'])
})
it('writes a dated drill result; failures reach the existing Status alert contract', () => {
  const receipt = {
    ok: true,
    started: '2026-11-05T00:00:00Z',
    finished: '2026-11-05T00:01:00Z',
    durationSeconds: 60,
    scratchDestroyed: true,
  }
  const row = drillRow(receipt, 'test')
  expect(parseRow(row).state).toBe('ok')
  expect(row.meaning).toContain('2026-11-05')
  expect(drillRow({ ...receipt, ok: false }, 'test').state).toBe('failed')
  expect(drillRow({ ...receipt, scratchDestroyed: false }, 'test').state).toBe('failed')
})
it('publishes a failed drill row when the script fails before producing JSON', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetcher)
  const code = await recovery(['drill'], config({}), {}, async () => ({
    code: 1,
    out: '',
    err: '',
  }))
  expect(code).toBe(1)
  expect(JSON.parse(fetcher.mock.calls[0][1].body)[0].state).toBe('failed')
})
it('the scheduled drill says when it is next due; one run by hand does not', async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetcher)
  const fail = async () => ({ code: 1, out: '', err: '' })
  const next = '2026-11-09T11:00:00.000Z'
  const scheduled = {
    AICO_JOB_KIND: 'backups-drill',
    AICO_JOB_NEXT_RUN: next,
    AICO_JOB_RUN_ID: 'drill-execution',
  }
  await recovery(['drill', '--scheduled'], config({}), scheduled, fail)
  expect(JSON.parse(fetcher.mock.calls[0][1].body)[0]).toMatchObject({
    next_run: next,
    run_by: 'jobs/backups-drill',
    run_id: 'drill-execution',
  })
  await recovery(['drill'], config({}), {}, fail)
  expect(JSON.parse(fetcher.mock.calls[1][1].body)[0]).not.toHaveProperty('next_run')
})
it('keeps drill help read only without publishing or parsing it as a receipt', async () => {
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  await recovery(['drill', '--help'], config({}), {}, async () => ({ code: 0, out: '', err: '' }))
  expect(fetcher).not.toHaveBeenCalled()
})
it('gives the scheduler a plain result while keeping snapshot metadata in the receipt', async () => {
  let output = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk)
    return true
  })
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output += args.join(' ') + '\n'
  })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  const receipt = {
    ok: true,
    started: '2026-11-05T00:00:00Z',
    finished: '2026-11-05T00:01:00Z',
    durationSeconds: 60,
    scratchDestroyed: true,
    snapshot: 'fixture-metadata',
  }
  await recovery(['drill', '--scheduled'], config({}), {}, async () => ({
    code: 0,
    out: JSON.stringify(receipt),
    err: '',
  }))
  expect(output).toContain('Restore drill passed')
  expect(output).not.toContain('snapshot')
})
it('includes private Logins files in encrypted append payloads on either machine', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-recovery-'))
  const cfg = config({})
  cfg.sqlite.dataDir = join(root, 'data')
  cfg.sqlite.stagingDir = join(root, 'staged')
  cfg.sqlite.otherDirs = []
  cfg.sqlite.recoveryPaths = [join(root, 'config')]
  mkdirSync(join(root, 'config'), { mode: 0o700 })
  mkdirSync(join(root, 'data/secrets'), { recursive: true, mode: 0o700 })
  const secret = join(root, 'data/secrets/fixture')
  writeFileSync(secret, 'fixture-only', { mode: 0o600 })
  const db = openDatabase(join(root, 'data/notes.db'), [])
  db.exec('CREATE TABLE fixture (id INTEGER)')
  db.close()
  try {
    const paths = stageSqlite(cfg, new Date()).paths
    expect(paths).toContain(join(root, 'data/secrets'))
    expect(paths).toContain(join(root, 'config'))
    expect(readFileSync(secret, 'utf8')).toBe('fixture-only')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
it('adds the standby own work to its Drive copy, and nothing on the workstation', () => {
  const root = mkdtempSync(join(tmpdir(), 'aico-standby-work-'))
  const cfg = config({})
  const phones = join(root, 'phones.json')
  writeFileSync(phones, '{}')
  cfg.sqlite.standbyWork = [phones, join(root, 'missing')]
  try {
    expect(standbyWork(cfg, 'aico')).toEqual([phones])
    expect(standbyWork(cfg, cfg.workstation)).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
