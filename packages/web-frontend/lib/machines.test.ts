import { describe, expect, it } from 'vitest'
import type { HostChoice } from './hooks/use-hosts'
import type { MachineGuest } from './hooks/use-machine-guests'
import {
  autostartHint,
  buildMachines,
  machinesLine,
  sessionHostLabel,
} from './machines'
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
  it('lists every machine once, aico (CT 190) with its own session link', () => {
    const list = buildMachines(view(ROWS), HOSTS, NOW)
    expect(list.machines.map((m) => m.name)).toEqual([
      'Workstation',
      'Proxmox host',
      'agent-work',
      'aico',
      'apps',
      'ominull-hub',
    ])
    expect(machinesLine(list)).toBe(
      '6 machines, 4 on. Sessions can run on 3 of them; 2 of those are on.',
    )
  })

  it('tags session hosts and offers power only where Aico has it', () => {
    const list = buildMachines(view(ROWS), HOSTS, NOW)
    const by = Object.fromEntries(list.machines.map((m) => [m.name, m]))
    expect(by.Workstation?.sessionHost).toBe(true)
    expect(by.Workstation?.power).toBeNull()
    expect(by['Proxmox host']?.sessionHost).toBe(false)
    expect(by.aico).toMatchObject({ sessionHost: true, power: null, up: 'on' })
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
      'agent-work',
      'aico',
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
    expect(sessionHostLabel('aico')).toBe('aico')
    expect(sessionHostLabel('agent-work')).toBe('agent-work')
  })
})

const guest = (over: Partial<MachineGuest>): MachineGuest => ({
  machine: 'apps',
  vmid: 180,
  kind: 'vm',
  state: 'stopped',
  since: null,
  busy: null,
  autostart: false,
  intent: 'on-demand',
  powerable: true,
  cpus: 4,
  memoryMb: 6144,
  projects: [{ id: 'portfolio-ai', name: 'Portfolio AI' }],
  ...over,
})

describe('buildMachines with Proxmox guests', () => {
  const by = (guests: MachineGuest[] | null) =>
    Object.fromEntries(
      buildMachines(view(ROWS), HOSTS, NOW, guests).machines.map((m) => [
        m.key,
        m,
      ]),
    )

  it('puts each guest on its machine and never on the two computers', () => {
    const list = by([
      guest({}),
      guest({ machine: 'davion-gem', vmid: 1 }),
      guest({ machine: 'davion-sidarli', vmid: 2 }),
    ])
    expect(list.apps?.guest?.vmid).toBe(180)
    expect(list['davion-gem']?.guest).toBeNull()
    expect(list['davion-sidarli']?.guest).toBeNull()
  })

  it('shows the aico container (CT 190) as a machine that cannot be powered from here', () => {
    const aico = by([
      guest({
        machine: 'aico',
        vmid: 190,
        state: 'running',
        powerable: false,
        intent: 'always',
        autostart: true,
      }),
    ]).aico
    expect(aico?.guest).toMatchObject({ vmid: 190, powerable: false })
    expect(aico?.up).toBe('on')
    expect(aico?.power).toBeNull()
  })

  it('says when an off machine last reported when nothing says when it went off', () => {
    const jobinator = buildMachines(
      view([
        ...ROWS,
        row({
          id: 'jobinator-4000/machine',
          machine: 'jobinator',
          shown: 'off',
          state: 'off',
          updated_at: '2026-11-06T09:30:00Z',
        }),
      ]),
      HOSTS,
      NOW,
    ).machines.find((m) => m.key === 'jobinator')
    expect(jobinator?.note).toMatch(/^Off\. Last report /)
  })

  it('says size, uptime and projects, and only counts uptime while running', () => {
    const stopped = by([guest({})]).apps
    expect(stopped?.facts).toBe('4 CPUs, 6 GB RAM · Project: Portfolio AI')
    const running = by([
      guest({ state: 'running', since: '2026-11-04T12:00:00Z' }),
    ]).apps
    expect(running?.facts).toBe(
      'Up 2 days · 4 CPUs, 6 GB RAM · Project: Portfolio AI',
    )
  })

  it('lets Proxmox override a lagging report and shows power in progress', () => {
    // Status still says on; Proxmox says stopped.
    const stopped = by([guest({ machine: 'ominull-hub', state: 'stopped' })])
    expect(stopped['ominull-hub']?.up).toBe('off')
    expect(
      by([guest({ machine: 'ominull-hub', state: 'down' })])['ominull-hub']
        ?.note,
    ).toBe('Stopped, but meant to be on.')
    expect(by([guest({ state: 'stopped', busy: 'start' })]).apps?.up).toBe(
      'starting',
    )
    expect(
      by([
        guest({ machine: 'ominull-hub', state: 'running', busy: 'shutdown' }),
      ])['ominull-hub']?.up,
    ).toBe('stopping')
    expect(
      by([
        guest({ machine: 'ominull-hub', state: 'running', busy: 'restart' }),
      ])['ominull-hub']?.up,
    ).toBe('restarting')
  })

  it('does not undo a start Tether is following, or a link that is already up, with a stale reading', () => {
    const work = (host: HostChoice) =>
      buildMachines(view(ROWS), [host], NOW, [
        guest({ machine: 'agent-work', vmid: 200, state: 'stopped' }),
      ]).machines.find((m) => m.key === 'agent-work')
    expect(
      work({
        name: 'agent-work',
        state: 'powered_off',
        wake: { state: 'starting', step: 'powering_on' },
      })?.up,
    ).toBe('starting')
    expect(work({ name: 'agent-work', state: 'connected' })?.up).toBe('on')
  })

  it('calls a running guest behind a powered-off link a shutdown finishing, and behind an off report a boot', () => {
    const work = (state: HostChoice['state']) =>
      buildMachines(view(ROWS), [{ name: 'agent-work', state }], NOW, [
        guest({ machine: 'agent-work', vmid: 200, state: 'running' }),
      ]).machines.find((m) => m.key === 'agent-work')?.up
    expect(work('powered_off')).toBe('stopping')
    // Status still says apps is off, Proxmox says it is running: it is booting.
    expect(
      buildMachines(view(ROWS), [], NOW, [
        guest({ state: 'running' }),
      ]).machines.find((m) => m.key === 'apps')?.up,
    ).toBe('starting')
  })

  it('has no guest while Proxmox could not be read', () => {
    expect(by(null).apps?.guest).toBeNull()
  })
})

describe('autostartHint', () => {
  it('names the two facts when they disagree, and is quiet when autostart is off as expected', () => {
    expect(autostartHint(guest({ autostart: false }))).toBe('')
    expect(autostartHint(guest({ autostart: true }))).toContain('On demand')
    // On as expected is said once on the page, not on every row.
    expect(autostartHint(guest({ autostart: true, intent: 'always' }))).toBe('')
    expect(
      autostartHint(guest({ autostart: false, intent: 'always' })),
    ).toContain('Meant to be always on')
    expect(autostartHint(guest({ autostart: null }))).toContain('didn’t say')
  })
})
