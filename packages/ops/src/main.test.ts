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

it('lists backups for a person: problems, one line per target, retired sources folded', () => {
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
  expect(text.split('\n')[0]).toBe('Backups on ws: 2 ok, 1 need a look, 1 retired sources.')
  expect(text).toContain('  off    Owner backups Jobs DB: Machine is off.')
  expect(text).toMatch(/ {2}T7 +1\/1 ok; newest data 30 min ago; last run 30 min ago, ok; next /)
  expect(text).toContain('Retired (path gone; older copies still hold them): Old.')
  expect(text).not.toContain('{')
})
