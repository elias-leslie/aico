import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { PhoneRegistry } from './app-phones'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('keeps the exact displayed-message receipt through a registry restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-receipts-'))
  dirs.push(dir)
  const path = join(dir, 'phones.json')
  writeFileSync(path, JSON.stringify([{ id: 'fixture', sig_pub: 'fixture' }]))
  const registry = new PhoneRegistry(path)
  await registry.ack(
    'fixture',
    { acks: [{ t: 'm', id: 'test-event', received_at: 100, shown: true }] },
    101,
  )
  expect(new PhoneRegistry(path).get('fixture')?.last_message_ack).toEqual({
    id: 'test-event',
    received_at: 100,
    shown: true,
  })
  await registry.ack(
    'fixture',
    { acks: [{ t: 'm', id: 'old', received_at: 90, shown: true }] },
    102,
  )
  await registry.ack(
    'fixture',
    { acks: [{ t: 'm', id: 'bad', received_at: 'wrong', shown: true }] },
    103,
  )
  expect(registry.get('fixture')?.last_message_ack?.id).toBe('test-event')
})
