import { generateKeyPairSync } from 'node:crypto'
import type { Stats } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { publicKeyOf } from './identity'
import { addApprovedPin, type Pin, PinCache, parsePins } from './trust'

const pin: Pin = {
  name: 'peer',
  publicKey: publicKeyOf(generateKeyPairSync('ed25519').publicKey),
  role: 'full',
}
it('requires an explicit approved role', () => {
  expect(parsePins([pin])).toEqual([pin])
  expect(() => parsePins([{ ...pin, role: undefined }])).toThrow('role')
})
it('never reuses an approval after revocation or for a role change', () => {
  const approved = addApprovedPin({ pins: [], usedAskIds: [] }, pin, 'owner-yes')
  expect(() => addApprovedPin({ ...approved, pins: [] }, pin, 'owner-yes')).toThrow('already used')
  expect(() => addApprovedPin(approved, { ...pin, role: 'worker' }, 'owner-yes')).toThrow(
    'already used',
  )
})
it('serves cached pins, refreshes replacements and fails closed on invalid files', () => {
  const read = vi.fn(() => [pin])
  let stamp = 1
  const stat = () =>
    ({ ino: stamp, ctimeMs: stamp, mtimeMs: stamp, size: 100, mode: 0o100644 }) as Stats
  const cache = new PinCache('test', read, stat)
  cache.refresh()
  for (let i = 0; i < 20; i++) {
    expect(cache.get()).toEqual([pin])
    cache.refresh()
  }
  expect(read).toHaveBeenCalledTimes(1)
  stamp++
  read.mockReturnValue([])
  cache.refresh()
  expect(cache.get()).toEqual([])
  expect(read).toHaveBeenCalledTimes(2)
  stamp++
  read.mockImplementation(() => {
    throw new Error('invalid pins')
  })
  expect(() => cache.refresh()).toThrow('invalid pins')
  expect(cache.get()).toEqual([])
})
