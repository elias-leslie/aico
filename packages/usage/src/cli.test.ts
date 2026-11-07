// `aico usage`: bare means show, mistakes name the command and the problem, times are local with a zone.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runUsageCli } from './cli'
import { openUsage, putState, usageDbPath } from './db'
import { storeReading } from './readings'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aico-usage-cli-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NOW = Date.parse('2026-11-07T03:28:50.155Z')
const HOUR = 3_600_000

async function run(argv: string[]) {
  let out = ''
  let err = ''
  const code = await runUsageCli(argv, {
    out: (t) => {
      out += t
    },
    err: (t) => {
      err += t
    },
    dataDir: dir,
    home: dir,
    env: {},
    machine: 'm',
    statusUrl: null,
    fetch,
    now: () => new Date(NOW),
  })
  return { code, out, err }
}

function seed() {
  const db = openUsage(usageDbPath(dir))
  const event = (window_minutes: number, used_percent: number, resetsAt: number) => ({
    provider: 'opencode-go',
    window_minutes,
    observedAt: NOW - 1000,
    used_percent,
    resetsAt,
    source: 'opencode_go_usage',
    plan_type: null,
  })
  storeReading(db, event(300, 0, NOW + 5 * HOUR), 0)
  storeReading(db, event(10080, 100, NOW + 40 * HOUR), 0)
  putState(db, 'collected', { at: '2026-11-07T03:28:50.155Z', problems: {} })
  db.close()
}

it('shows by default, with local times that name their zone and no reset for an untouched window', async () => {
  seed()
  for (const argv of [[], ['show'], ['--json']]) {
    const result = await run(argv)
    expect(result.code).toBe(0)
    if (argv[0] === '--json')
      expect(JSON.parse(result.out).collected_at).toBe('2026-11-07T03:28:50.155Z')
    else {
      expect(result.out).toContain(
        'OpenCode Go usage: Weekly used up until Nov 8, 2:28 PM EST. 5h 100% left.',
      )
      expect(result.out).not.toContain('5h 100% left, resets')
      expect(result.out).toContain('Collected Nov 6, 10:28 PM EST.')
      expect(result.out).not.toContain('Z.')
    }
  }
})

it('names the command and the problem on a mistake', async () => {
  const option = await run(['show', '--bogus'])
  expect(option.code).toBe(2)
  expect(option.err).toBe('aico usage show: unknown option --bogus (try --json)\n')
  // Bare `aico usage` does not name a subcommand the user never typed.
  expect((await run(['--bogus'])).err).toBe('aico usage: unknown option --bogus (try --json)\n')
  const command = await run(['shwo'])
  expect(command.code).toBe(2)
  expect(command.err).toBe(
    'aico usage: unknown command shwo (collect or show; aico usage --help)\n',
  )
  expect((await run(['--help'])).code).toBe(0)
  expect((await run(['collect', '--help'])).out).toContain('aico usage [show]')
})
