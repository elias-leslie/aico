import { describe, expect, it } from 'vitest'
import {
  lookMessage,
  lookProject,
  matches,
  NO_FILTER,
  rollup,
  rowButtons,
  type StatusRow,
  silentMachines,
  sortRows,
  summaryLine,
  when,
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
      'davion-sidarli isn’t reporting, so it can’t run now',
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
      'davion-gem is back; this hasn’t reported since.',
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

  it('names the row and why in a look message, and picks its project', () => {
    const off = row({
      shown: 'unknown',
      unknown_why: 'off',
      machine: 'davion-gem',
    })
    expect(lookMessage(off)).toBe(
      'Status row aico-web is unknown: davion-gem is off, so this can’t report. Serving. Find out why and fix it.',
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
