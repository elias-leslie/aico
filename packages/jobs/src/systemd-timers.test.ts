import { describe, expect, it } from 'vitest'
import { JobStore } from './leases'
import { type RoutineView, routinesCommand } from './routines-cli'
import { parseTimers, type RunCommand, readTimers, timerKind } from './systemd-timers'

const FILE = parseTimers({
  hosts: {
    pve: { exec: ['ssh', 'pve'], root: true, tz: 'UTC' },
    box: { exec: ['ssh', 'box'] },
    far: { fleet: true },
  },
  timers: [
    {
      unit: 'beat.timer',
      host: 'ws',
      project: 'aico',
      what: 'Heartbeat',
      schedule: 'every 5 minutes',
    },
    {
      unit: 'trim.timer',
      host: 'pve',
      project: 'aico',
      what: 'Weekly trim',
      schedule: 'Mondays at 00:00',
    },
    {
      unit: 'mine.timer',
      host: 'ws',
      scope: 'user',
      project: 'aico',
      what: 'User job',
      schedule: 'daily',
    },
    { unit: 'gone.timer', host: 'box', project: 'aico', what: 'Missing', schedule: 'hourly' },
    { unit: 'far.timer', host: 'far', project: 'aico', what: 'Far', schedule: 'hourly' },
  ],
})

const NEXT = 1_794_100_000_000
const LAST = NEXT - 300_000

/** A systemctl that answers like the real one for the units above; `calls` records what ran. */
function fake(over: { failing?: string; down?: string } = {}) {
  const calls: string[][] = []
  const run: RunCommand = async (argv) => {
    calls.push(argv)
    if (over.down && argv.includes(over.down)) throw new Error('it did not answer in time')
    const verb = argv.find((word) =>
      ['list-timers', 'show', 'start', 'disable', 'enable'].includes(word),
    )
    if (verb === 'list-timers')
      return {
        code: 0,
        out: JSON.stringify(
          argv
            .filter((word) => word.endsWith('.timer') && word !== 'gone.timer')
            .map((unit) => ({ unit, next: NEXT * 1000, last: LAST * 1000 })),
        ),
      }
    if (verb === 'show') {
      const out = argv
        .filter((word) => /\.(timer|service)$/.test(word))
        .map((id) => {
          if (id === 'gone.timer')
            return `Id=${id}\nLoadState=not-found\nActiveState=inactive\nResult=success\n`
          const service = id.endsWith('.service')
          const bad = service && id === over.failing
          return [
            `Id=${id}`,
            'LoadState=loaded',
            `ActiveState=${service ? (bad ? 'failed' : 'inactive') : id === 'mine.timer' ? 'inactive' : 'active'}`,
            `Result=${bad ? 'exit-code' : 'success'}`,
            service ? `ExecMainStatus=${bad ? 3 : 0}` : '',
            service && id === 'beat.service'
              ? `ExecMainExitTimestamp=@${Math.floor(LAST / 1000) + 120}`
              : '',
            '',
          ]
            .filter((line, i, all) => line !== '' || i === all.length - 1)
            .join('\n')
        })
        .join('\n')
      return { code: 0, out }
    }
    return { code: 0, out: '' }
  }
  return { calls, run }
}

function harness(over: Parameters<typeof fake>[0] = {}) {
  const f = fake(over)
  const lines: string[] = []
  const errors: string[] = []
  const run = (...args: string[]) =>
    routinesCommand(
      args,
      {
        jobs: [],
        store: new JobStore(':memory:'),
        machine: 'ws',
        env: { XDG_RUNTIME_DIR: '/run/user/1000' },
        dataDir: '/nonexistent',
        timers: FILE,
        runCommand: f.run,
        postRows: async () => {},
        removeRow: async () => {},
      },
      (l) => lines.push(l),
      (l) => errors.push(l),
    )
  return { ...f, lines, errors, run }
}

describe('systemd timers in Routines', () => {
  it('lists each with its schedule, next run and last result, read from systemd', async () => {
    const h = harness()
    expect(await h.run('list', '--json')).toBe(0)
    const views = JSON.parse(h.lines[0] as string) as RoutineView[]
    expect(views.map((v) => v.kind)).toEqual([
      'beat@ws',
      'trim@pve',
      'mine@ws',
      'gone@box',
      'far@far',
    ])
    expect(views[0]).toMatchObject({
      source: 'systemd',
      what: 'Heartbeat',
      project: 'aico',
      home: 'ws',
      schedule: 'every 5 minutes',
      paused: false,
      running: false,
      nextRun: NEXT,
      // The service finished after the timer last fired (a hand-started run): that is the last run.
      lastRun: Math.floor(LAST / 1000) * 1000 + 120_000,
      lastState: 'ok',
      lastMeaning: 'Finished OK.',
      lastMachine: 'ws',
      command: ['beat.timer'],
    })
    // Its times of day are in its host's zone, named in the file; a host with none says nothing.
    expect(views[0]?.tz).toBeUndefined()
    expect(views[1]).toMatchObject({ schedule: 'Mondays at 00:00', tz: 'UTC' })
    // A timer that is not active is paused: no next run.
    expect(views[2]).toMatchObject({ paused: true, nextRun: null, scope: 'user' })
    // One that is not installed is not known, never OK.
    expect(views[3]).toMatchObject({
      unreadable: 'gone.timer is not installed on box',
      lastState: null,
    })
    // It asks systemd for the service's finish time as a plain number, not a date in a locale.
    const shown = h.calls.find((c) => c.includes('show')) as string[]
    expect(shown).toContain('--timestamp=unix')
    expect(shown.find((word) => word.startsWith('Id,'))).toContain('ExecMainExitTimestamp')
    // One batch of calls per host and scope, not per timer.
    expect(h.calls.filter((c) => c.includes('list-timers'))).toHaveLength(5)
  })

  it('reaches each host the way the file says: here, over a root hop, sudo on a plain hop, the fleet link', async () => {
    const h = harness()
    await h.run('list', '--json')
    const first = (unit: string) =>
      h.calls.find((c) => c.includes('list-timers') && c.includes(unit)) as string[]
    expect(first('beat.timer').slice(0, 3)).toEqual(['sudo', '-n', 'systemctl'])
    expect(first('mine.timer').slice(0, 2)).toEqual(['systemctl', '--user'])
    expect(first('trim.timer').slice(0, 3)).toEqual(['ssh', 'pve', 'systemctl'])
    expect(first('gone.timer').slice(0, 5)).toEqual(['ssh', 'box', 'sudo', '-n', 'systemctl'])
    const far = first('far.timer')
    expect(far.slice(1, 3)).toEqual(['fleet', 'exec'])
    expect(far[3]).toBe('/run/user/1000/aico/fleet/far/exec.sock')
  })

  it('shows a failed service as a failed row, and a host that does not answer as not known', async () => {
    const h = harness({ failing: 'beat.service', down: 'pve' })
    await h.run('list', '--json')
    const views = JSON.parse(h.lines[0] as string) as RoutineView[]
    expect(views[0]).toMatchObject({
      lastState: 'failed',
      lastMeaning: 'Failed (exit-code, exit 3).',
    })
    expect(views[1]).toMatchObject({ unreadable: 'it did not answer in time', lastState: null })
    // The text list says it too.
    h.lines.length = 0
    await h.run('list')
    expect(h.lines.join('\n')).toContain('beat@ws  aico  every 5 minutes')
    expect(h.lines.join('\n')).toContain('failed: Failed (exit-code, exit 3).')
  })

  it('runs now, pauses and resumes through systemctl, never waiting on the service', async () => {
    const h = harness()
    expect(await h.run('run', 'beat@ws')).toBe(0)
    expect(h.calls.at(-1)).toEqual([
      'sudo',
      '-n',
      'systemctl',
      'start',
      '--no-ask-password',
      '--no-block',
      'beat.service',
    ])
    expect(await h.run('pause', 'trim@pve')).toBe(0)
    expect(h.calls.at(-1)).toEqual([
      'ssh',
      'pve',
      'systemctl',
      'disable',
      '--now',
      '--no-ask-password',
      'trim.timer',
    ])
    expect(await h.run('resume', 'mine@ws')).toBe(0)
    expect(h.calls.at(-1)).toEqual([
      'systemctl',
      '--user',
      'enable',
      '--now',
      '--no-ask-password',
      'mine.timer',
    ])
    expect(h.lines.join('\n')).toContain('paused (its timer is disabled)')
    expect(await h.run('remove', 'beat@ws')).toBe(2)
    expect(h.errors.join('\n')).toContain('systemd-timers.json')
  })

  it('says what systemctl said when it refuses', async () => {
    const h = harness()
    const refuse: RunCommand = async () => ({
      code: 4,
      out: 'Failed to start beat.service: Access denied\n',
    })
    const code = await routinesCommand(
      ['run', 'beat@ws'],
      {
        jobs: [],
        store: new JobStore(':memory:'),
        machine: 'ws',
        env: {},
        dataDir: '/nonexistent',
        timers: FILE,
        runCommand: refuse,
        postRows: async () => {},
        removeRow: async () => {},
      },
      () => {},
      (l) => h.errors.push(l),
    )
    expect(code).toBe(1)
    expect(h.errors[0]).toContain('ws said: Failed to start beat.service: Access denied')
  })

  it('reads the shipped list and refuses a bad one by field', () => {
    const shipped = readTimers(new URL('../data/systemd-timers.json', import.meta.url).pathname)
    expect(shipped.timers.map(timerKind)).toContain('host-steward-heartbeat@aico')
    const one = shipped.timers[0]
    expect(() => parseTimers({ hosts: {}, timers: [{ ...one, unit: 'x.service' }] })).toThrow(
      'timers[0].unit',
    )
    expect(() => parseTimers({ hosts: {}, timers: [one, one] })).toThrow('listed twice')
    expect(() => parseTimers({ hosts: {}, timers: [{ ...one, schedule: '' }] })).toThrow(
      'timers[0].schedule',
    )
    expect(() => parseTimers({ hosts: { pve: { tz: 'Mars/Olympus' } }, timers: [one] })).toThrow(
      'hosts.pve.tz',
    )
    expect(() =>
      parseTimers({
        hosts: { pve: { exec: ['ssh'] } },
        timers: [{ ...one, host: 'pve', scope: 'user' }],
      }),
    ).toThrow('user timers')
  })
})
