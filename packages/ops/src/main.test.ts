import { afterEach, expect, it, vi } from 'vitest'
import { listText } from './backups'
import { main } from './main'

afterEach(() => vi.restoreAllMocks())

it.each(['deploy', 'logs', 'snapshots', 'vm'])(
  'aico %s --help prints that command only, exit 0, without a project or host',
  async (verb) => {
    for (const flag of ['--help', '-h']) {
      const out: string[] = []
      const err: string[] = []
      vi.spyOn(console, 'log').mockImplementation((line) => void out.push(String(line)))
      vi.spyOn(console, 'error').mockImplementation((line) => void err.push(String(line)))
      // No AICO_REPO_ROOT and no project above / : help must not need one.
      expect(await main([verb, flag], { PATH: process.env.PATH })).toBe(0)
      expect(err).toEqual([])
      const text = out.join('\n')
      expect(text).toContain(`aico ${verb} `)
      for (const other of ['deploy', 'logs', 'snapshots', 'vm'].filter((v) => v !== verb))
        expect(text).not.toContain(`aico ${other} `)
      vi.restoreAllMocks()
    }
  },
)

it('says what is wrong with aico logs once, without a doubled prefix', async () => {
  const err: string[] = []
  vi.spyOn(console, 'error').mockImplementation((line) => void err.push(String(line)))
  expect(await main(['logs', '--bogus'], { PATH: process.env.PATH })).toBe(2)
  expect(err).toEqual(['aico logs: unknown option --bogus'])
})

it('bare aico vm prints the grouped usage, one command per line, exit 2', async () => {
  const err: string[] = []
  vi.spyOn(console, 'error').mockImplementation((line) => void err.push(String(line)))
  expect(await main(['vm'], { PATH: process.env.PATH })).toBe(2)
  const lines = err.join('\n').split('\n')
  expect(lines[0]).toBe('Usage:')
  expect(lines.filter((line) => line.startsWith('  aico vm ')).length).toBeGreaterThan(5)
  expect(lines.every((line) => line.length < 100)).toBe(true)
})

it('lists backups for a person: problems, one line per target, archived sources folded', () => {
  const now = Date.parse('2026-11-07T02:00:00Z')
  const entry = (over: Record<string, unknown>) => ({
    id: 'x',
    source: 'x',
    name: 'X',
    target: 'native' as const,
    dataAt: '2026-11-07T01:30:00Z',
    nextRun: '2026-11-07T05:30:00Z',
    state: 'ok' as const,
    meaning: 'Restorable data is 30 min old.',
    snapshot: null,
    path: null,
    running: false,
    machine: 'ws',
    ...over,
  })
  const text = listText(
    {
      machine: 'ws',
      entries: [
        entry({ id: 'native/a', source: 'a', name: 'A' }),
        entry({ id: 'drive/a', source: 'a', name: 'A', target: 'drive' }),
        entry({
          id: 'external/j',
          name: 'Jobs DB',
          target: 'external',
          state: 'off',
          meaning: 'Machine is off.',
          dataAt: null,
        }),
        entry({ id: 'native/old', source: 'old', name: 'Old', state: 'off', gone: true }),
        entry({
          id: 'drive/old',
          source: 'old',
          name: 'Old',
          target: 'drive',
          state: 'off',
          gone: true,
        }),
      ],
      runs: {
        native: { started: '2026-11-07T01:29:00Z', finished: '2026-11-07T01:30:00Z', ok: true },
      },
    },
    now,
  )
  expect(text.split('\n')[0]).toBe(
    'Backups on ws: All 1 source current (2 copies), 1 on a machine that is off, 1 archived.',
  )
  expect(text).toContain('On a machine that is off:')
  expect(text).toContain('Owner backups Jobs DB: no good copy date known')
  expect(text).toMatch(
    / {2}T7 +1\/1 ok; newest data 30 min ago; last run 30 min ago, ok; next Nov 7, 12:30 AM EST/,
  )
  expect(text).toContain('Archived (source gone; older copies still hold them): Old.')
  expect(text).not.toContain('{')
})

async function backupsCall(argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line) => void out.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line) => void err.push(String(line)))
  const code = await main(['backups', ...argv], { PATH: process.env.PATH })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

it('aico backups says what is wrong: unknown command, missing arguments, always exit 2', async () => {
  const unknown = await backupsCall(['runs', '--help'])
  expect(unknown.code).toBe(2)
  expect(unknown.err).toBe(
    'aico backups: unknown command runs (did you mean run?); aico backups --help lists them',
  )
  const restore = await backupsCall(['restore'])
  expect(restore.code).toBe(2)
  expect(restore.err).toMatch(
    /^aico backups: restore needs SOURCE SNAPSHOT PATH --to FOLDER\nUsage:\n {2}aico backups restore SOURCE/,
  )
  expect((await backupsCall(['restore', 'a', 'b', '/x'])).err).toContain('needs --to FOLDER')
  expect((await backupsCall(['run', 'bogus'])).code).toBe(2)
  expect((await backupsCall(['snapshots'])).err).toContain('needs a SOURCE')
})

it('aico backups --help and aico backups COMMAND --help exit 0, the second with that command only', async () => {
  const all = await backupsCall(['--help'])
  expect(all.code).toBe(0)
  expect(all.out).toContain('aico backups restore')
  const one = await backupsCall(['run', '--help'])
  expect(one.code).toBe(0)
  expect(one.out).toContain('aico backups run native|drive')
  expect(one.out).not.toContain('aico backups restore')
})
