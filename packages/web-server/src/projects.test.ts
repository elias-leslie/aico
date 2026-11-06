import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Guest } from '@aico/fleet/power'
import { parseRow, type ShownRow, StatusStore } from '@aico/status'
import { openTasksDb, type Place, Registry } from '@aico/tasks'
import { describe, expect, it } from 'vitest'
import type { Ask } from './asks'
import { type GuestSource, Places } from './places'
import {
  groupDays,
  type OverviewRow,
  ProjectsService,
  parseLog,
  problemKind,
  problemsOf,
  readmeIntro,
  sortOverview,
  timeline,
} from './projects'

const T0 = Date.parse('2026-11-06T12:00:00Z')

const overviewRow = (fields: Partial<OverviewRow>): OverviewRow => ({
  id: 'p',
  name: 'P',
  archived: false,
  top: null,
  waiting: null,
  runState: null,
  problems: [],
  agents: 0,
  lastActivity: null,
  ...fields,
})

describe('sortOverview', () => {
  it('puts waiting first, then problems, then recent activity, archived last', () => {
    const sorted = sortOverview([
      overviewRow({ id: 'quiet-old', name: 'B', lastActivity: '2026-11-01T00:00:00Z' }),
      overviewRow({ id: 'quiet-new', name: 'A', lastActivity: '2026-11-06T00:00:00Z' }),
      overviewRow({
        id: 'warn',
        name: 'C',
        problems: [{ kind: 'quiet', count: 30, worst: 'unknown' }],
      }),
      overviewRow({
        id: 'failed',
        name: 'D',
        problems: [{ kind: 'fail', count: 1, worst: 'failed' }],
      }),
      overviewRow({ id: 'waiting', name: 'E', waiting: { askId: 'a', title: 'Q' } }),
      overviewRow({ id: 'gone', name: 'A0', archived: true, waiting: { askId: 'b', title: 'Q' } }),
    ])
    expect(sorted.map((row) => row.id)).toEqual([
      'waiting',
      'failed',
      'warn',
      'quiet-new',
      'quiet-old',
      'gone',
    ])
  })
})

const shown = (fields: Record<string, unknown>, state = 'failed', why?: string): ShownRow =>
  ({
    ...parseRow({
      kind: 'job',
      machine: 'm',
      state: 'ok',
      meaning: 'Fine.',
      id: 'x',
      what: 'X',
      ...fields,
    }),
    shown: state,
    updated_at: '',
    shown_since: null,
    ...(why ? { unknown_why: why } : {}),
  }) as ShownRow

describe('problems', () => {
  it('groups counted rows of the project by badge and leaves quiet ones out', () => {
    const rows = [
      shown({ id: 'b/1', what: 'Backup', kind: 'backup', project: 'p' }),
      shown({ id: 'jobs/github-publish', what: 'Publish', project: 'p' }),
      shown({ id: 'c/1', what: 'Check', project: 'p' }, 'warn'),
      shown({ id: 'c/2', what: 'Check 2', project: 'p' }),
      shown({ id: 'q/1', what: 'Quiet', project: 'p' }, 'unknown', 'missing'),
      shown({ id: 'q/2', what: 'Waiting', project: 'p' }, 'unknown', 'back'),
      shown({ id: 'o/1', what: 'Other', project: 'other' }),
    ]
    expect(problemsOf(rows, 'p').map(({ kind, count, worst }) => ({ kind, count, worst }))).toEqual(
      [
        { kind: 'fail', count: 2, worst: 'failed' },
        { kind: 'publish', count: 1, worst: 'failed' },
        { kind: 'backup', count: 1, worst: 'failed' },
        { kind: 'quiet', count: 1, worst: 'unknown' },
      ],
    )
    expect(problemKind({ kind: 'job', id: 'publish:x', shown: 'failed' })).toBe('publish')
  })
})

describe('timeline', () => {
  const log = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => {
      const at = Math.floor(T0 / 1000) - (from + i) * 7200
      return `${String(from + i).padStart(40, 'a')}\x1f${at}\x1fCommit ${from + i}`
    }).join('\n')

  it('parses commits, versions and groups them by day', () => {
    const commits = parseLog(`${'a'.repeat(40)}\x1f${T0 / 1000}\x1fRelease 1.8.107 (hub only)`)
    expect(commits[0]).toMatchObject({ release: '1.8.107', subject: 'Release 1.8.107 (hub only)' })
    const days = groupDays(parseLog(log(5)))
    expect(days.flatMap((day) => day.commits)).toHaveLength(5)
    expect(days[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('pages: one more than the limit means more, fewer means the end', async () => {
    const git = async (_root: string, args: string[]) =>
      args[0] === 'log' ? log(Number(args[2])) : ''
    const page = await timeline(git, '/r', undefined, 3)
    expect(page.end).toBe(false)
    expect(page.days.flatMap((d) => d.commits)).toHaveLength(3)
    const last = async (_r: string, args: string[]) => (args[0] === 'log' ? log(2) : '')
    expect((await timeline(last, '/r', undefined, 3)).end).toBe(true)
  })

  it('treats a missing checkout as unavailable and a bad cursor as an error', async () => {
    const broken = async () => {
      throw new Error('fatal: not a git repository')
    }
    expect(await timeline(broken, '/nope', undefined, 5)).toEqual({
      days: [],
      end: true,
      available: false,
    })
    await expect(timeline(broken, '/r', 'abcdef1', 5)).rejects.toMatchObject({ status: 422 })
  })
})

describe('readmeIntro', () => {
  it('takes the first prose paragraph', () => {
    const dir = mkdtempSync(join(tmpdir(), 'readme-'))
    expect(readmeIntro(dir)).toBeNull()
    writeFileSync(
      join(dir, 'README.md'),
      '# Title\n\n[![ci](x)](y)\n\nIt does the thing\nacross two lines.\n\n## More\n',
    )
    expect(readmeIntro(dir)).toBe('It does the thing across two lines.')
  })
})

// -- Power --------------------------------------------------------------------------------

const CT: Place = {
  kind: 'ct',
  id: 191,
  label: 'CT 191',
  power: true,
  intent: 'on-demand',
  machine: 'jobinator',
}

function guests(initial: Partial<Guest> = {}) {
  const list: Guest[] = [
    {
      vmid: 191,
      type: 'lxc',
      node: 'gem',
      name: 'jobinator',
      status: 'running',
      uptime: 5000,
      ...initial,
    },
    { vmid: 180, type: 'qemu', node: 'gem', name: 'apps', status: 'stopped', uptime: 0 },
  ]
  const calls: string[] = []
  const source: GuestSource & { fail?: boolean; down?: boolean } = {
    async list() {
      if (source.down) throw new Error('ssh: connect timed out')
      return list
    },
    async act(guest, action) {
      if (source.fail) throw new Error('boom')
      calls.push(`${guest.vmid}:${action}`)
    },
  }
  return { list, calls, source }
}

function places(source: GuestSource | null, clock = { now: T0 }, place: Place = CT) {
  const status = new StatusStore(':memory:', () => clock.now)
  const p = new Places({
    guests: source,
    status,
    declared: () => [place],
    machine: 'davion-sidarli',
    pollMs: 30_000,
    busyMs: 600_000,
    now: () => clock.now,
  })
  return { p, status, clock }
}

const ALWAYS: Place = { ...CT, intent: 'always' }

describe('Places power', () => {
  it('maps the buttons to start, a clean shutdown and a clean reboot; never a hard stop', async () => {
    const g = guests()
    const { p } = places(g.source)
    await p.power(CT, 'restart')
    expect(g.calls).toEqual(['191:reboot'])
    await expect(p.power(CT, 'shutdown')).rejects.toMatchObject({ status: 409 })
    expect(g.calls.every((call) => !call.endsWith(':stop'))).toBe(true)
  })

  it('marks an on-demand place stopped before a shutdown, reads stopped, and start clears the stop', async () => {
    const g = guests()
    const { p, status } = places(g.source)
    await p.refresh()
    const view = await p.power(CT, 'shutdown')
    expect(g.calls).toEqual(['191:shutdown'])
    expect(view.busy).toBe('shutdown')
    expect(status.intents()[0]).toMatchObject({ machine: 'jobinator', stoppedAt: T0 })
    g.list[0]!.status = 'stopped'
    g.list[0]!.uptime = 0
    await p.refresh()
    await p.refresh()
    expect(p.view(CT)).toMatchObject({ state: 'stopped', busy: null })
    await p.power(CT, 'start')
    expect(g.calls).toEqual(['191:shutdown', '191:start'])
    expect(p.view(CT).state).toBe('starting')
    expect(status.intents()[0]).toMatchObject({ stoppedAt: null })
  })

  it('reads an always-on place that is off as down, and a stopped one the owner shut as stopped', async () => {
    const g = guests({ status: 'stopped', uptime: 0 })
    const { p, status } = places(g.source, { now: T0 }, ALWAYS)
    await p.refresh()
    expect(p.view(ALWAYS).state).toBe('down')
    status.markStopped('jobinator', T0)
    expect(p.view(ALWAYS).state).toBe('stopped')
  })

  it('does not hold the marks when Proxmox refuses', async () => {
    const g = guests()
    g.source.fail = true
    const { p, status } = places(g.source)
    await expect(p.power(CT, 'shutdown')).rejects.toMatchObject({ status: 502 })
    expect(status.intents()[0]).toMatchObject({ stoppedAt: null })
  })

  it('refuses places the page does not power, restart of a stopped guest, and a busy guest', async () => {
    const g = guests({ status: 'stopped', uptime: 0 })
    const { p } = places(g.source)
    await expect(p.power({ ...CT, power: false }, 'start')).rejects.toMatchObject({ status: 422 })
    await expect(
      p.power({ kind: 'host', label: 'Workstation', power: false, intent: 'always' }, 'shutdown'),
    ).rejects.toMatchObject({ status: 422 })
    await expect(p.power(CT, 'restart')).rejects.toMatchObject({ status: 409 })
    await p.power(CT, 'start')
    await expect(p.power(CT, 'start')).rejects.toMatchObject({ status: 409 })
  })

  it('shutting down a stopped guest only records the owner meant it', async () => {
    const g = guests({ status: 'stopped', uptime: 0 })
    const { p, status } = places(g.source, { now: T0 }, ALWAYS)
    expect(p.view(ALWAYS).state).toBe('unknown') // not read yet
    await p.refresh()
    expect(p.view(ALWAYS).state).toBe('down')
    await p.power(ALWAYS, 'shutdown')
    expect(g.calls).toEqual([])
    expect(status.expectedOff().has('jobinator')).toBe(true)
    expect(p.view(ALWAYS).state).toBe('stopped')
  })

  it('is unknown with the last good time when Proxmox does not answer', async () => {
    const g = guests()
    const clock = { now: T0 }
    const { p } = places(g.source, clock)
    await p.refresh()
    expect(p.view(CT)).toMatchObject({ state: 'running', asOf: new Date(T0).toISOString() })
    g.source.down = true
    clock.now = T0 + 60_000
    await p.refresh()
    const view = p.view(CT)
    expect(view.state).toBe('unknown')
    expect(view.asOf).toBe(new Date(T0).toISOString())
    await expect(p.power(CT, 'shutdown')).rejects.toMatchObject({ status: 503 })
  })

  it('derives expectations from observed power with no marks, and keeps them when Proxmox is unreachable', async () => {
    const g = guests({ status: 'stopped', uptime: 0 })
    const clock = { now: T0 }
    const { p, status } = places(g.source, clock)
    status.upsert([
      parseRow({
        id: 'jobinator/machine',
        what: 'jobinator',
        kind: 'machine',
        machine: 'jobinator',
        state: 'ok',
        meaning: 'Fine.',
        next_run: new Date(T0 - 3_600_000).toISOString(),
      }),
    ])
    clock.now = T0 + 3_600_000
    await p.refresh()
    // Stopped outside the page: off, not late, no marks.
    expect(status.intents()[0]).toMatchObject({ stoppedAt: null, power: 'off' })
    expect(status.read().rows[0]?.shown).toBe('off')
    expect(p.view(CT).state).toBe('stopped')
    // Started outside the page: expected on, so the silent machine row is late.
    g.list[0]!.status = 'running'
    g.list[0]!.uptime = 60
    clock.now += 60_000
    await p.refresh()
    expect(status.isExpectedOff('jobinator')).toBe(false)
    expect(status.read().rows[0]?.shown).toBe('late')
    // Proxmox unreachable: the last reading stays, as of its own time.
    const seenAt = clock.now
    g.source.down = true
    clock.now += 600_000
    await p.refresh()
    expect(status.intents()[0]).toMatchObject({ power: 'on', powerAt: seenAt })
    expect(status.isExpectedOff('jobinator')).toBe(false)
  })

  it('does not flip a stopped on-demand place to late when Proxmox cannot be reached', async () => {
    const g = guests({ status: 'stopped', uptime: 0 })
    const clock = { now: T0 }
    const { p, status } = places(g.source, clock)
    await p.refresh()
    g.source.down = true
    clock.now += 600_000
    await p.refresh()
    expect(status.intents()[0]).toMatchObject({ power: 'off', powerAt: T0 })
    expect(status.isExpectedOff('jobinator')).toBe(true)
  })

  it('ends a machine with no report of its own once it is running again', async () => {
    const g = guests()
    const clock = { now: T0 }
    const { p, status } = places(g.source, clock, ALWAYS)
    await p.refresh()
    status.markStopped('jobinator', T0 - 3_600_000)
    g.list[0]!.uptime = 60
    await p.refresh()
    expect(status.intents()[0]?.stoppedAt).toBeNull()
  })
})

// -- The service ----------------------------------------------------------------------------

describe('ProjectsService', () => {
  it('builds the overview from roadmap, status, sessions, asks and places', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-'))
    writeFileSync(join(dir, 'ROADMAP.md'), '# One\nIt is one.\n## Now\n- Ship it (plan: a.md)\n')
    const registry = new Registry(openTasksDb(':memory:'))
    registry.register({ id: 'one', root: dir, name: 'One' })
    registry.register({ id: 'two', root: join(dir, 'missing'), name: 'Two' })
    registry.setRuntime('one', [CT])
    const g = guests()
    const { p, status } = places(g.source)
    await p.refresh()
    status.upsert([
      parseRow({
        id: 'm/machine',
        what: 'm',
        kind: 'machine',
        machine: 'm',
        state: 'ok',
        meaning: 'Fine.',
        next_run: new Date(T0 + 3_600_000).toISOString(),
      }),
      parseRow({
        id: 'b/1',
        what: 'Backup',
        kind: 'backup',
        machine: 'm',
        state: 'failed',
        meaning: 'Late.',
        project: 'one',
      }),
    ])
    const ask = {
      id: 'abcdefabcdef',
      session: 's1',
      requester: null,
      question: 'Which way?',
      blocking: true,
      state: 'open',
      createdAt: 1,
    } as Ask
    const service = new ProjectsService({
      registry,
      status,
      tether: {
        listSessions: async () =>
          [
            {
              id: 's1',
              projectId: 'one',
              tool: 'claude-code',
              status: 'running',
              state: 'blocked',
              label: 'S1',
              name: null,
            },
            {
              id: 's2',
              projectId: 'one',
              tool: 'shell',
              status: 'running',
              label: 'S2',
              name: null,
            },
            {
              id: 's3',
              projectId: 'one',
              tool: 'codex',
              status: 'running',
              state: 'working',
              label: 'S3',
              name: null,
            },
          ] as never,
      },
      asks: { list: async () => [ask] },
      places: p,
      git: async () => '',
      activityMs: 1000,
    })
    const overview = await service.overview()
    expect(overview.map((row) => row.id)).toEqual(['one', 'two'])
    expect(overview[0]).toMatchObject({
      top: 'Ship it',
      runState: 'running',
      agents: 2,
      waiting: { askId: 'abcdefabcdef', title: 'Which way?' },
      problems: [{ kind: 'backup', count: 1, worst: 'failed' }],
    })
    expect(overview[1]).toMatchObject({ top: null, runState: null, agents: 0 })
    const detail = await service.detail('one')
    expect(detail).toMatchObject({
      overview: 'It is one.',
      now: [{ text: 'Ship it', plan: 'a.md' }],
      roadmap: { found: true },
      agents: [
        { sessionId: 's1', blocked: true },
        { sessionId: 's3', blocked: false },
      ],
    })
    expect((await service.detail('two')).roadmap.found).toBe(false)
    await expect(service.detail('nope')).rejects.toMatchObject({ status: 404 })
    await expect(service.power('one', 5, 'start')).rejects.toMatchObject({ status: 404 })
  })
})
