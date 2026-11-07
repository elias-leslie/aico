import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openUsage, putState, type UsageReport, usageDbPath } from '@aico/usage'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Router } from './http'
import { registerUsageRoutes } from './usage-routes'

// Local noon, so the local day is the same whatever the machine's zone.
const NOW = new Date(2026, 10, 6, 12, 0, 0)
const day = (back: number) => {
  const d = new Date(2026, 10, 6 - back)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
let dir: string
let server: Server
let base: string

async function start(seed: (db: ReturnType<typeof openUsage>) => void) {
  const db = openUsage(usageDbPath(dir))
  seed(db)
  db.close()
  const router = new Router()
  registerUsageRoutes(router, { dataDir: dir, now: () => NOW })
  server = createServer((req, res) => {
    void router.handle(req, res, new URL(req.url || '/', 'http://localhost'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  base = `http://127.0.0.1:${address.port}`
}

const daily = (
  db: ReturnType<typeof openUsage>,
  at: string,
  provider: string,
  over: { tokens?: number; credits?: number; requests?: number },
) =>
  db
    .prepare(
      `INSERT INTO daily (day, provider, model, project, requests, input_tokens, output_tokens, credits_drawn)
       VALUES (?, ?, 'm', 'p', ?, ?, 0, ?)`,
    )
    .run(at, provider, over.requests ?? 1, over.tokens ?? 0, over.credits ?? 0)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aico-usage-api-'))
})
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  rmSync(dir, { recursive: true, force: true })
})

it('says usage was not collected yet instead of an empty report', async () => {
  await start(() => {})
  const res = await fetch(`${base}/api/usage`)
  expect(res.status).toBe(503)
  expect(((await res.json()) as { detail: string }).detail).toBe(
    'Aico has not collected usage yet.',
  )
})

it('reports windows, spend per day per provider, and what is not recorded', async () => {
  await start((db) => {
    putState(db, 'collected', { at: NOW.toISOString(), problems: {}, failed: [] })
    db.prepare(
      `INSERT INTO readings (provider, window_minutes, observed_at, used_percent, resets_at, source)
       VALUES ('opencode-go', 10080, ?, 100, ?, 'test'), ('opencode-go', 300, ?, 0, ?, 'test')`,
    ).run(
      NOW.toISOString(),
      new Date(NOW.getTime() + 2 * 86400_000).toISOString(),
      NOW.toISOString(),
      new Date(NOW.getTime() + 3600_000).toISOString(),
    )
    daily(db, day(3), 'claude', { tokens: 500, requests: 4 })
    daily(db, day(0), 'claude', { tokens: 900, requests: 6 })
    daily(db, day(1), 'codex', { tokens: 100, credits: 40.04 })
    daily(db, day(20), 'codex', { tokens: 100, credits: 5 })
  })
  const report = (await (await fetch(`${base}/api/usage`)).json()) as UsageReport
  expect(report.providers.map((p) => p.id)).toEqual(['claude', 'codex', 'opencode-go'])
  const [claude, codex, go] = report.providers

  // Claude: tokens, 14 days up to today, quiet days are zero (recorded since its first row).
  expect(claude?.spend.unit).toBe('tokens')
  expect(claude?.spend.days).toHaveLength(14)
  expect(claude?.spend.days.filter((d) => d.recorded)).toHaveLength(4)
  expect(claude?.spend.days.find((d) => d.day === day(4))?.recorded).toBe(false)
  expect(claude?.spend.days.map((d) => d.tokens).slice(-1)).toEqual([900])
  expect(claude?.spend.days.find((d) => d.day === day(3))?.requests).toBe(4)
  expect(claude?.spend.days.find((d) => d.day === day(2))?.tokens).toBe(0)

  // Codex: credits, and only the days in range (the row from 20 days ago is outside it).
  expect(codex?.spend.unit).toBe('credits')
  expect(codex?.spend.recorded_since).toBe(day(20))
  expect(codex?.spend.days).toHaveLength(14)
  expect(codex?.spend.days.find((d) => d.day === day(1))?.credits).toBe(40)

  // OpenCode Go: no daily rows, so no days (the page says it is not recorded, not zero).
  expect(go?.spend).toEqual({ unit: null, recorded_since: null, days: [] })
  expect(go?.status).toBe('used_up')
  expect(go?.answer).toMatch(/^Used up until .* \(weekly\)$/)
  expect(go?.windows.map((w) => [w.label, w.state])).toEqual([
    ['5h', 'ok'],
    ['weekly', 'used_up'],
  ])
})
