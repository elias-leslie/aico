import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readSettings } from './settings'

function settingsWith(listen: { address: string; port: number }) {
  const file = join(mkdtempSync(join(tmpdir(), 'fleet-settings-')), 'fleet.json')
  writeFileSync(file, JSON.stringify({ listen, peers: [] }))
  return () => readSettings({ AICO_FLEET_CONFIG: file }, '/control.sock')
}

it('tells a listener address not assigned yet apart from a bad endpoint', () => {
  // 192.0.2.0/24 is documentation space: never a LAN address.
  expect(settingsWith({ address: '192.0.2.1', port: 7449 })).toThrow(
    'Fleet endpoints must be literal LAN addresses',
  )
  // A private address no interface here holds: the network isn't up yet, and a retry can fix it.
  expect(settingsWith({ address: '10.255.254.253', port: 7449 })).toThrow(
    "Waiting for this machine's LAN address 10.255.254.253: it isn't assigned yet",
  )
})
