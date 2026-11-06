import { describe, expect, it } from 'vitest'
import { RELAY_DEVICE, type RelayRun, relaySender } from './phone-relay'

const item = Buffer.from(JSON.stringify({ v: 1, id: 'abc123', title: 'Backups failed' }))

function relay(code: number | null, out: string) {
  const calls: { argv: string[]; input: string }[] = []
  const exec: RelayRun = async (argv, input) => {
    calls.push({ argv, input })
    return { code, out }
  }
  return { sender: relaySender('pve-alerts', exec), calls }
}

describe('relaySender', () => {
  it('hands the finished item to the Proxmox sender over the ssh alias', async () => {
    const { sender, calls } = relay(0, '{"ok": true, "accepted": 1}\n')
    expect(sender.devices()).toEqual([RELAY_DEVICE])
    expect(await sender.send(RELAY_DEVICE, item, 60)).toBe('sent')
    expect(calls[0]?.argv.at(-1)).toBe('pve-alerts')
    expect(JSON.parse(calls[0]?.input ?? '')).toEqual({
      v: 1,
      source: 'aico',
      kind: 'relay',
      item: { v: 1, id: 'abc123', title: 'Backups failed' },
    })
  })

  it('retries when ssh never reached Proxmox or a phone did not take it', async () => {
    expect(await relay(255, '').sender.send(RELAY_DEVICE, item, 60)).toBe('retry')
    expect(await relay(75, '{"ok": false}').sender.send(RELAY_DEVICE, item, 60)).toBe('retry')
  })

  it('stops on a refusal and is unsure when the answer is lost', async () => {
    expect(await relay(2, '').sender.send(RELAY_DEVICE, item, 60)).toBe('rejected:2')
    expect(await relay(null, '').sender.send(RELAY_DEVICE, item, 60)).toBe('unsure')
  })
})
