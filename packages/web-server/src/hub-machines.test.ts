import { StatusStore } from '@aico/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hubMachines } from './hub-machines'
import type { MachineGuest } from './machines'

const AT = new Date().toISOString()
const NEXT = new Date(Date.now() + 600_000).toISOString()

function guest(
  machine: string,
  state: MachineGuest['state'],
  intent: MachineGuest['intent'] = null,
) {
  return {
    machine,
    vmid: 100,
    kind: 'vm',
    state,
    since: state === 'running' ? AT : null,
    busy: null,
    failed: null,
    autostart: null,
    intent,
    powerable: true,
    cpus: null,
    memoryMb: null,
    projects: [],
  } as MachineGuest
}

describe('hubMachines', () => {
  let status: StatusStore
  beforeEach(() => {
    status = new StatusStore(':memory:')
  })
  afterEach(() => status.close())

  const report = (id: string, machine: string, state: 'ok' | 'off' = 'ok') =>
    status.upsert([
      {
        id,
        what: machine,
        kind: 'machine',
        machine,
        state,
        meaning: 'x',
        last_run: AT,
        next_run: NEXT,
      },
    ])

  it('says a reporting machine is up and counts it as a fleet machine', () => {
    report('here/machine', 'here')
    status.syncIntents([{ machine: 'here', intent: 'always' }])
    expect(hubMachines([], status)).toMatchObject([
      { machine: 'here', intent: 'always', up: true, reports: true },
    ])
  })

  it('does not count a machine only a watcher writes a link row for as reporting', () => {
    report('fleet/here/peer', 'peer')
    expect(hubMachines([], status)).toMatchObject([{ machine: 'peer', up: true, reports: false }])
    // Its own row as well: it reports.
    report('peer/machine', 'peer')
    expect(hubMachines([], status)).toMatchObject([{ machine: 'peer', up: true, reports: true }])
  })

  it('leaves out the hub row: it says nothing about a machine to watch', () => {
    report('ominull.machine', 'ominull-hub')
    expect(hubMachines([], status)).toEqual([])
  })

  it('takes a guest from the hypervisor: running, stopped, or not known', () => {
    const view = hubMachines(
      [guest('on', 'running', 'on-demand'), guest('off', 'stopped'), guest('dunno', 'unknown')],
      status,
    )
    expect(view).toMatchObject([
      { machine: 'dunno', up: null, reports: false },
      { machine: 'off', up: false, reports: false },
      { machine: 'on', intent: 'on-demand', up: true, reports: false },
    ])
  })

  it('sends a guest stopped against its intent as not known, so the hub keeps watching it', () => {
    expect(hubMachines([guest('core', 'down', 'always')], status)).toMatchObject([
      { machine: 'core', intent: 'always', up: null },
    ])
  })

  it('counts a guest starting as up, so its agent gets its grace from now', () => {
    expect(hubMachines([guest('boot', 'starting', 'on-demand')], status)).toMatchObject([
      { machine: 'boot', up: true },
    ])
  })

  it('keeps the machine row when the hypervisor has no reading', () => {
    report('here/machine', 'here')
    expect(hubMachines([guest('here', 'unknown')], status)).toMatchObject([
      { machine: 'here', up: true, reports: true },
    ])
  })

  it('leaves out every row of the hub machine', () => {
    report('ominull.machine', 'ominull-hub')
    report('fleet/ominull-hub', 'ominull-hub')
    expect(hubMachines([], status)).toEqual([])
  })

  it('lets the hypervisor win over a machine row, keeping that the machine reports', () => {
    report('both/machine', 'both')
    expect(hubMachines([guest('both', 'stopped')], status)).toMatchObject([
      { machine: 'both', up: false, reports: true },
    ])
  })
})
