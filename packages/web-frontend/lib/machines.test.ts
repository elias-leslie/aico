import { describe, expect, it } from 'vitest'
import type { HostChoice } from './hooks/use-hosts'
import { buildMachines, machinesLine, sessionHostLabel } from './machines'
import type { StatusRow, StatusView } from './status'

const NOW = Date.parse('2026-11-06T12:00:00Z')
const row = (over: Partial<StatusRow>): StatusRow => ({
  id: 'x/machine',
  what: 'x',
  kind: 'machine',
  machine: 'x',
  state: 'ok',
  meaning: 'Up.',
  updated_at: '2026-11-06T11:58:00Z',
  shown: 'ok',
  shown_since: null,
  ...over,
})
const view = (rows: StatusRow[]): StatusView => ({
  generated_at: '',
  summary: {
    problems: 0,
    worst: null,
    counts: { failed: 0, late: 0, unknown: 0, warn: 0 },
    quiet: 0,
    healthy: 0,
    top: [],
  },
  rows,
  machine: 'davion-sidarli',
})
const ROWS = [
  row({ id: 'davion-sidarli/machine', machine: 'davion-sidarli' }),
  row({ id: 'davion-gem/machine', machine: 'davion-gem' }),
  row({ id: 'fleet/davion-sidarli/aico', machine: 'aico' }),
  row({
    id: 'fleet/davion-sidarli/agent-work',
    machine: 'agent-work',
    shown: 'off',
    state: 'off',
  }),
  row({ id: 'ominull.machine', machine: 'ominull-hub' }),
  row({ id: 'apps/machine', machine: 'apps', shown: 'off', state: 'off' }),
]
const HOSTS: HostChoice[] = [
  { name: 'agent-work', state: 'powered_off', canSleep: true, sessions: 0 },
  { name: 'aico', state: 'connected', canSleep: false, sessions: 0 },
]

describe('buildMachines', () => {
  it('lists every machine once, the Proxmox host merging its session link', () => {
    const list = buildMachines(view(ROWS), HOSTS, NOW)
    expect(list.machines.map((m) => m.name)).toEqual([
      'Workstation',
      'Proxmox host',
      'agent-work',
      'apps',
      'ominull-hub',
    ])
    expect(machinesLine(list)).toBe('5 machines; 3 can run sessions.')
  })

  it('tags session hosts and offers power only where Aico has it', () => {
    const list = buildMachines(view(ROWS), HOSTS, NOW)
    const by = Object.fromEntries(list.machines.map((m) => [m.name, m]))
    expect(by.Workstation?.sessionHost).toBe(true)
    expect(by.Workstation?.power).toBeNull()
    expect(by['Proxmox host']?.sessionHost).toBe(true)
    expect(by['Proxmox host']?.power).toBeNull()
    expect(by['agent-work']).toMatchObject({
      up: 'off',
      power: 'on',
      sessionHost: true,
    })
    expect(by['ominull-hub']).toMatchObject({
      up: 'on',
      sessionHost: false,
      power: null,
    })
  })

  it('offers Power off on a connected host that can sleep', () => {
    const list = buildMachines(
      view(ROWS),
      [{ name: 'agent-work', state: 'connected', canSleep: true, sessions: 2 }],
      NOW,
    )
    const m = list.machines.find((x) => x.name === 'agent-work')
    expect(m).toMatchObject({ up: 'on', power: 'off', sessions: 2 })
  })

  it('still lists the session hosts when Status could not be read', () => {
    const list = buildMachines(null, HOSTS, NOW)
    expect(list.partial).toBe(true)
    expect(list.machines.map((m) => m.name)).toEqual([
      'Workstation',
      'Proxmox host',
      'agent-work',
    ])
    expect(machinesLine(list)).toContain('The other machines couldn’t be read')
  })

  it('does not call a host a non-host when the hosts could not be read', () => {
    const list = buildMachines(view(ROWS), null, NOW)
    expect(list.hostsUnknown).toBe(true)
    const by = Object.fromEntries(list.machines.map((m) => [m.name, m]))
    expect(by['agent-work']?.sessionHost).toBe(true)
    expect(by.Workstation?.sessionHost).toBe(true)
    expect(machinesLine(list)).toContain('couldn’t be checked')
  })

  it('shows a machine that stopped reporting as not reporting, with why', () => {
    const list = buildMachines(
      view([
        ...ROWS.slice(0, 1),
        row({ id: 'ominull.machine', machine: 'ominull-hub', shown: 'late' }),
      ]),
      [],
      NOW,
    )
    const hub = list.machines.find((m) => m.key === 'ominull-hub')
    expect(hub?.up).toBe('late')
    expect(hub?.note).toContain('Last report')
  })
})

describe('sessionHostLabel', () => {
  it('names this computer and the Proxmox link the same as Machines', () => {
    expect(sessionHostLabel(null)).toBe('Workstation')
    expect(sessionHostLabel('aico')).toBe('Proxmox host')
    expect(sessionHostLabel('agent-work')).toBe('agent-work')
  })
})
