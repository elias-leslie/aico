import { describe, expect, it } from 'vitest'
import {
  lookMessage,
  lookProject,
  matches,
  NO_FILTER,
  reason,
  rollup,
  rowButtons,
  type SessionInfo,
  type StatusRow,
  silentMachines,
  sortRows,
  summaryLine,
  when,
  withSessionNames,
} from './status'

const NOW = Date.parse('2026-11-03T12:00:00')
const row = (over: Partial<StatusRow> = {}): StatusRow => ({
  id: 'aico-web',
  what: 'aico-web',
  kind: 'service',
  machine: 'davion-sidarli',
  state: 'ok',
  meaning: 'Serving.',
  updated_at: '2026-11-03T11:55:00',
  shown: 'ok',
  shown_since: null,
  actions: [
    { kind: 'run', ref: 'systemctl --user restart aico-web.service' },
    { kind: 'log', ref: 'journalctl --user -u aico-web -n 200' },
  ],
  ...over,
})
const here = { here: 'davion-sidarli', hosts: new Set(['davion-gem']) }

describe('rowButtons', () => {
  it('offers run and log only on this machine, look only on a problem', () => {
    const ok = rowButtons(row(), here)
    expect(ok.buttons.map((b) => b.kind)).toEqual(['run', 'log'])
    expect(ok.primary).toBeNull()
    const away = rowButtons(
      row({ machine: 'davion-gem', shown: 'failed', state: 'failed' }),
      here,
    )
    expect(away.buttons.map((b) => b.kind)).toEqual(['look'])
    expect(away.primary).toBe('look')
  })

  it('leads a late row with run, and an unknown one with Hosts while run waits', () => {
    expect(rowButtons(row({ shown: 'late' }), here).primary).toBe('run')
    const unknown = rowButtons(
      row({ machine: 'davion-gem', shown: 'unknown' }),
      here,
    )
    expect(unknown.buttons.map((b) => b.kind)).toEqual(['hosts', 'look'])
    expect(unknown.primary).toBe('hosts')
    const silent = rowButtons(row({ shown: 'unknown' }), here)
    expect(silent.buttons.find((b) => b.kind === 'run')?.disabled).toBe(
      'Workstation isn’t reporting, so it can’t run now',
    )
  })

  it('lets a row waiting on its machine’s return run, and says why it waits', () => {
    const waiting = row({
      machine: 'davion-gem',
      shown: 'unknown',
      unknown_why: 'back',
    })
    const buttons = rowButtons(waiting, {
      here: 'davion-gem',
      hosts: here.hosts,
    })
    expect(buttons.buttons.map((b) => [b.kind, b.disabled])).toEqual([
      ['look', null],
      ['run', null],
      ['log', null],
    ])
    expect(buttons.primary).toBe('run')
    expect(lookMessage(waiting)).toContain(
      'Proxmox host is back, but this hasn’t reported since it came back.',
    )
  })

  it('hides detail with no page behind it and the hub’s run refs', () => {
    const hub = row({
      id: 'ominull-push',
      actions: [{ kind: 'detail', ref: 'restore' }],
    })
    expect(rowButtons(hub, here).buttons).toEqual([])
  })
})

describe('filters and words', () => {
  const rows = [
    row({ id: 'a', what: 'b-check', shown: 'ok' }),
    row({
      id: 'b',
      what: 'a-backup',
      kind: 'backup',
      shown: 'failed',
      project: 'aico',
    }),
    row({
      id: 'c',
      what: 'c-vm',
      kind: 'vm',
      machine: 'davion-gem',
      shown: 'unknown',
    }),
  ]

  it('filters by state, kind, machine, project and search; sorts problems first', () => {
    expect(
      rows.filter((r) => matches(r, { ...NO_FILTER, states: ['failed'] })),
    ).toHaveLength(1)
    expect(
      rows.filter((r) => matches(r, { ...NO_FILTER, machine: 'davion-gem' })),
    ).toHaveLength(1)
    expect(
      rows.filter((r) => matches(r, { ...NO_FILTER, project: 'aico' })),
    ).toHaveLength(1)
    expect(
      rows.filter((r) => matches(r, { ...NO_FILTER, search: 'VM' })),
    ).toHaveLength(1)
    expect(sortRows(rows, 'problems').map((r) => r.id)).toEqual(['b', 'c', 'a'])
    expect(sortRows(rows, 'what').map((r) => r.id)).toEqual(['b', 'a', 'c'])
    expect(rollup(rows)).toMatchObject({
      ok: 1,
      failed: 1,
      unknown: 1,
      late: 0,
    })
  })

  it('says the badge line and the time a row leads with', () => {
    expect(
      summaryLine({
        problems: 3,
        worst: 'failed',
        counts: { failed: 1, late: 0, unknown: 0, warn: 2 },
        quiet: 0,
        healthy: 4,
        top: [],
      }),
    ).toBe('3 problems: 1 failed, 2 warnings')
    const late = when(
      row({
        shown: 'late',
        shown_since: '2026-11-03T04:30:00',
        last_run: '2026-11-02T04:30:00',
      }),
      NOW,
    )
    expect(late).toMatchObject({
      lead: 'Late since 4:30 AM',
      sub: 'Last ran yesterday 4:30 AM',
    })
  })

  it('shows a row of a machine turned off on purpose as off with its last report, not a problem', () => {
    const apps = row({
      id: 'apps/job',
      machine: 'apps',
      kind: 'job',
      shown: 'off',
      shown_since: '2026-11-03T11:00:00',
      machine_off: true,
      meaning: 'Last run completed.',
      updated_at: '2026-11-03T10:35:00',
      actions: [{ kind: 'run', ref: 'x' }],
    })
    expect(reason(apps)).toBe('apps is off.')
    expect(when(apps, NOW)).toMatchObject({
      lead: 'Last report 10:35 AM',
      sub: 'apps off since 11:00 AM',
      short: 'reported 10:35 AM',
    })
    const hosts = { here: 'davion-sidarli', hosts: new Set(['apps']) }
    const buttons = rowButtons(apps, hosts)
    expect(buttons.buttons.map((b) => b.kind)).toEqual(['hosts'])
    expect(buttons.primary).toBeNull()
    expect(rollup([apps]).off).toBe(1)
    expect(reason(row({ shown: 'off', state: 'off' }))).toBe('')
  })

  it('names the row and why in a look message, and picks its project', () => {
    const off = row({
      shown: 'unknown',
      unknown_why: 'late',
      machine: 'davion-gem',
    })
    expect(lookMessage(off)).toBe(
      'Status row aico-web is unknown: Proxmox host stopped reporting. Serving. Find out why and fix it.',
    )
    const projects = [
      { id: 'nightshift', root_path: '/srv/workspaces/projects/nightshift' },
    ]
    const owned = row({
      actions: [
        { kind: 'look', ref: '/srv/workspaces/projects/nightshift/checks' },
      ],
    })
    expect(lookProject(owned, projects, 'aico')).toBe('nightshift')
    expect(lookProject(row({ project: 'gone' }), projects, 'aico')).toBe('aico')
  })

  it('lists a machine that went late with its row count', () => {
    const list = [
      row({
        id: 'm',
        kind: 'machine',
        machine: 'davion-gem',
        shown: 'late',
        shown_since: 'x',
      }),
      row({ id: 'v', machine: 'davion-gem', shown: 'unknown' }),
    ]
    expect(silentMachines(list)).toEqual([
      { machine: 'davion-gem', since: 'x', rows: 1 },
    ])
  })
})

describe('what a problem costs', () => {
  const warn = (id: string, kind = 'check', over: Partial<StatusRow> = {}) =>
    row({
      id,
      what: id,
      kind,
      state: 'warn',
      shown: 'warn',
      actions: [],
      ...over,
    })

  it('lists lost work and security before service trouble, and swap and disk last', () => {
    const mixed = [
      warn('davion-sidarli/check-perf'),
      warn('usage/opencode-go'),
      warn('ominull.maintenance'),
      warn('davion-sidarli/check-sudo'),
      warn('portfolio-ai/worker', 'service', {
        state: 'failed',
        shown: 'failed',
      }),
      warn('davion-sidarli/check-memory'),
      warn('davion-sidarli/check-storage', 'check', {
        state: 'failed',
        shown: 'failed',
      }),
      row({ id: 'davion-sidarli/aico-web', what: 'aico-web' }),
      warn('davion-sidarli/backup/drive/aico', 'backup', {
        state: 'failed',
        shown: 'failed',
      }),
    ]
    expect(sortRows(mixed, 'problems').map((r) => r.id)).toEqual([
      'davion-sidarli/backup/drive/aico',
      'davion-sidarli/check-memory',
      'davion-sidarli/check-sudo',
      'portfolio-ai/worker',
      'ominull.maintenance',
      'davion-sidarli/check-storage',
      'davion-sidarli/check-perf',
      'usage/opencode-go',
      'davion-sidarli/aico-web',
    ])
  })

  it('keeps the other sorts as they were', () => {
    const rows = [warn('b-check-perf'), warn('a-check-sudo')]
    expect(sortRows(rows, 'what').map((r) => r.id)).toEqual([
      'a-check-sudo',
      'b-check-perf',
    ])
  })
})

describe('sessions a row names', () => {
  const names: SessionInfo['names'] = new Map([
    ['fa41c0c8', 'Aico: Status page'],
  ])

  it('swaps an id for the session’s name, and a session that is gone for “has ended”', () => {
    expect(
      withSessionNames('Session fa41c0c8: jobs killed again and again', names),
    ).toBe('Session “Aico: Status page”: jobs killed again and again')
    expect(
      withSessionNames('chrome (18 MiB) killed in Session 0badc0de', names),
    ).toBe('chrome (18 MiB) killed in A session that has ended')
    expect(withSessionNames('userdel (Agent in session 0badc0de)', names)).toBe(
      'userdel (Agent in a session that has ended)',
    )
    expect(withSessionNames('userdel (Agent in session fa41c0c8)', names)).toBe(
      'userdel (Agent in session “Aico: Status page”)',
    )
  })

  it('does not call a session gone while the list is not known', () => {
    expect(withSessionNames('Session fa41c0c8: killed', null)).toBe(
      'A session: killed',
    )
    expect(withSessionNames('The session ended well', names)).toBe(
      'The session ended well',
    )
    expect(withSessionNames('session decade', names)).toBe('session decade')
  })

  it('offers Resume for a stopped session and Open for a listed one, and nothing for an unknown id', () => {
    const memory = row({
      id: 'davion-sidarli/check-memory',
      kind: 'check',
      state: 'warn',
      shown: 'warn',
      actions: [
        {
          kind: 'run',
          ref: 'sudo -n systemctl start host-steward-check.service',
        },
        { kind: 'session', ref: 'fa41c0c8' },
        { kind: 'session', ref: '0badc0de' },
        { kind: 'session', ref: 'deadbeef' },
      ],
    })
    const sessions: SessionInfo = {
      names: new Map([
        ['fa41c0c8', 'Restore drill'],
        ['0badc0de', 'Skill sync'],
      ]),
      resumable: new Set(['fa41c0c8']),
    }
    const { buttons, primary } = rowButtons(memory, { ...here, sessions })
    expect(buttons.map((b) => [b.kind, b.ref])).toEqual([
      ['resume', 'fa41c0c8'],
      ['open', '0badc0de'],
      ['look', ''],
      ['run', 'sudo -n systemctl start host-steward-check.service'],
    ])
    expect(primary).toBe('resume')
    // Before the session list is read, nothing is offered for the ids (and no click can miss).
    expect(rowButtons(memory, here).buttons.map((b) => b.kind)).toEqual([
      'look',
      'run',
    ])
  })
})
