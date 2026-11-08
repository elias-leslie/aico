import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { mergePhones, type Phone, PhoneRegistry } from './app-phones'

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

const phone = (id: string, fields: Partial<Phone> = {}): Phone => ({
  id,
  sig_pub: 'sig',
  enc_pub: 'enc',
  auth: 'auth',
  ...fields,
})

it('merges phones: the sender decides who exists, each keeps the newer of what both heard', () => {
  const sent = [
    phone('kept', { fcm_token: 'old', token_at: 10, last_ack: 100, state_at: 50 }),
    phone('new-there'),
  ]
  const here = [
    phone('kept', { fcm_token: 'fresh', token_at: 20, last_ack: 90, state_at: 40 }),
    phone('removed-there', { added_at: 5 }),
    phone('paired-here', { added_at: 500 }),
  ]
  const merged = mergePhones(sent, here, 100)
  expect(merged.map((p) => p.id)).toEqual(['kept', 'new-there', 'paired-here'])
  expect(merged[0]).toMatchObject({ fcm_token: 'fresh', token_at: 20, last_ack: 100, state_at: 50 })
})

it('merges phones: a removed token stays gone unless the phone sent a newer one', () => {
  const merged = mergePhones(
    [phone('a', { fcm_token: 'x', token_at: 30, token_gone: 31 })],
    [phone('a', { fcm_token: 'x', token_at: 20 })],
    0,
  )
  expect(merged[0]).toMatchObject({ token_at: 30, token_gone: 31 })
})
