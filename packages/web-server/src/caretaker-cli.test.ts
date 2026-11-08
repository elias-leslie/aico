import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jobEnv, type StatusRow } from '@aico/status'
import { afterEach, expect, it, vi } from 'vitest'
import { POLICY } from './caretaker'
import { runCaretakerCli } from './caretaker-cli'

vi.mock('@aico/agent', () => ({
  ask: async () => ({ outcome: { kind: 'done', text: 'ready' } }),
}))
vi.mock('@aico/video', () => ({
  generate: async () => ({ text: 'ready' }),
  silenceBound: () => async () => {},
}))

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('reports the caretaker and route-check deadlines from its scheduled interval', async () => {
  const now = Date.parse('2026-11-08T20:00:00Z')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const dataDir = mkdtempSync(join(tmpdir(), 'aico-caretaker-schedule-'))
  dirs.push(dataDir)
  const rows: StatusRow[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
    if (init?.body) rows.push(...JSON.parse(String(init.body)))
    return new Response(JSON.stringify({ rows: [] }))
  })
  const io = {
    out: () => {},
    err: () => {},
    baseUrl: 'http://local',
    dataDir,
    repoRoot: dataDir,
    env: jobEnv('caretaker', now + 5 * 60_000, 5),
  }
  expect(await runCaretakerCli(['run'], io)).toBe(0)
  expect(rows.find((row) => row.id.endsWith('/caretaker'))).toMatchObject({
    next_run: new Date(now + 5 * 60_000).toISOString(),
    run_by: 'jobs/caretaker',
  })
  expect(rows.find((row) => row.id.endsWith('/model-routes'))).toMatchObject({
    next_run: new Date(now + 5 * 60_000 + POLICY.route_check_hours * 3600_000).toISOString(),
    run_by: 'jobs/caretaker',
  })
  rows.length = 0
  expect(await runCaretakerCli(['run'], { ...io, env: {} })).toBe(0)
  expect(rows[0]).not.toHaveProperty('next_run')
})
