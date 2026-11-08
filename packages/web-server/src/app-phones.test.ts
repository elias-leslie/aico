import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  confirmPhonesMerge,
  mergePhones,
  mergePhonesFile,
  type Phone,
  PhoneRegistry,
} from './app-phones'

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

it('merges phones: a read error a good ack cleared on one side stays cleared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-readerr-'))
  dirs.push(dir)
  const a = new PhoneRegistry(join(dir, 'a.json'))
  const fixture = [phone('p')]
  writeFileSync(join(dir, 'a.json'), JSON.stringify(fixture))
  await a.ack('p', { acks: [{ t: 'e', error: 'decrypt' }] }, 100)
  const withError = a.all() as Phone[]
  expect(withError[0]).toMatchObject({ read_error: 'decrypt', read_error_at: 100 })
  // The other machine got the good ack later.
  writeFileSync(join(dir, 'b.json'), JSON.stringify(withError))
  const b = new PhoneRegistry(join(dir, 'b.json'))
  await b.ack('p', { acks: [{ t: 'm', id: 'x', received_at: 1, shown: true }] }, 200)
  const cleared = b.all() as Phone[]
  expect(cleared[0]?.read_error).toBeUndefined()
  // Either direction of the sync keeps it cleared.
  expect(mergePhones(withError, cleared, 0)[0]?.read_error).toBeUndefined()
  expect(mergePhones(cleared, withError, 0)[0]?.read_error).toBeUndefined()
  // A later error on the other side still wins over the older clear.
  const later = [phone('p', { read_error: 'late', read_error_at: 300 })]
  expect(mergePhones(cleared, later, 0)[0]).toMatchObject({
    read_error: 'late',
    read_error_at: 300,
  })
  expect(mergePhones(later, cleared, 0)[0]).toMatchObject({
    read_error: 'late',
    read_error_at: 300,
  })
})

it('keeps a phone paired here when the reply to the merge never reached the sender', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-sync-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  writeFileSync(
    file,
    JSON.stringify([phone('old', { added_at: 1 }), phone('new', { added_at: 150 })]),
  )
  writeFileSync(`${file}.sync.json`, JSON.stringify({ at: 100 }))
  const sender = [phone('old', { added_at: 1 })]
  // First sync: the phone paired here is kept and returned, but the reply is lost (no confirm).
  expect(mergePhonesFile(file, sender, 200).map((p) => p.id)).toEqual(['old', 'new'])
  // The sender never got it, so its list still lacks the phone: it must survive again.
  expect(mergePhonesFile(file, sender, 300).map((p) => p.id)).toEqual(['old', 'new'])
  // Once a reply is confirmed, the sender's list decides.
  confirmPhonesMerge(file)
  expect(mergePhonesFile(file, sender, 400).map((p) => p.id)).toEqual(['old'])
})
