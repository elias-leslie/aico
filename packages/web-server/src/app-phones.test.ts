import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as durableFile from '@aico/shared/durable-file'
import { withFileLock } from '@aico/shared/durable-file'
import { afterEach, expect, it, vi } from 'vitest'
import {
  confirmPhonesMerge,
  mergePhones,
  mergePhonesFile,
  type Phone,
  PhoneRegistry,
} from './app-phones'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
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

it.each(['pair', 'remove', 'ack', 'merge', 'confirm'] as const)(
  '%s waits for another process holding the phone writer lock',
  async (operation) => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-phone-lock-'))
    dirs.push(dir)
    const path = join(dir, 'phones.json')
    writeFileSync(path, JSON.stringify([phone('old')]))
    writeFileSync(`${path}.sync.json`, JSON.stringify({ at: 1, pending: 2 }))
    const registry = new PhoneRegistry(path)
    const actions: Record<typeof operation, () => Promise<unknown>> = {
      pair: () => registry.register(phone('new')),
      remove: () => registry.remove('old'),
      ack: () => registry.ack('old', {}, 100),
      merge: () => mergePhonesFile(path, [phone('sent')], 200),
      confirm: () => confirmPhonesMerge(path),
    }
    const before = readFileSync(path, 'utf8')
    const cursor = readFileSync(`${path}.sync.json`, 'utf8')
    let pending: Promise<unknown> | undefined
    let finished = false
    await withFileLock(path, async () => {
      pending = actions[operation]().then(() => {
        finished = true
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(finished).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(readFileSync(`${path}.sync.json`, 'utf8')).toBe(cursor)
    })
    await pending
    expect(finished).toBe(true)
  },
)

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

it('keeps a phone paired here when the reply to the merge never reached the sender', async () => {
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
  expect((await mergePhonesFile(file, sender, 200)).map((p) => p.id)).toEqual(['old', 'new'])
  // The sender never got it, so its list still lacks the phone: it must survive again.
  expect((await mergePhonesFile(file, sender, 300)).map((p) => p.id)).toEqual(['old', 'new'])
  // Once a reply is confirmed, the sender's list decides.
  await confirmPhonesMerge(file)
  expect((await mergePhonesFile(file, sender, 400)).map((p) => p.id)).toEqual(['old'])
})

it('keeps a phone paired after the merge in its same second, until a reply actually includes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-confirm-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  const sender = [phone('old', { added_at: 1 })]
  writeFileSync(file, JSON.stringify(sender))
  writeFileSync(`${file}.sync.json`, JSON.stringify({ at: 100 }))
  expect((await mergePhonesFile(file, sender, 200)).map((p) => p.id)).toEqual(['old'])
  // The reply above contains only "old"; this pairing happened later in the same wall-clock second.
  await new PhoneRegistry(file).register(phone('new', { added_at: 200 }))
  await confirmPhonesMerge(file)
  expect((await mergePhonesFile(file, sender, 300)).map((p) => p.id)).toEqual(['old', 'new'])
  // Once a confirmed reply contains it, a removal on the sender is authoritative again.
  await confirmPhonesMerge(file)
  expect((await mergePhonesFile(file, sender, 400)).map((p) => p.id)).toEqual(['old'])
})

it('keeps sender origin and the last whole list when the list write fails after its cursor was saved', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-merge-cut-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  const ours = [phone('kept', { added_at: 1 }), phone('paired-here', { added_at: 150 })]
  writeFileSync(file, JSON.stringify(ours))
  writeFileSync(`${file}.sync.json`, JSON.stringify({ at: 100, ids: ['kept'] }))
  const write = durableFile.writeFileDurable
  const failed = vi
    .spyOn(durableFile, 'writeFileDurable')
    .mockImplementation((path, data, options) => {
      if (path === file) throw new Error('list write interrupted')
      write(path, data, options)
    })
  await expect(
    mergePhonesFile(file, [phone('kept'), phone('sent-new', { added_at: 150 })], 200),
  ).rejects.toThrow('list write interrupted')
  expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(ours)
  expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8')).known_pairs).toEqual({
    kept: null,
    'sent-new': null,
  })
  failed.mockRestore()
  // No reply was produced, so there is no confirm. A retry with the sender phone removed is safe.
  expect((await mergePhonesFile(file, [phone('kept')], 300)).map((phone) => phone.id)).toEqual([
    'kept',
    'paired-here',
  ])
})

it('distinguishes a fresh local pairing of a known phone from the pairing the sender already knew', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-repairing-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  await mergePhonesFile(file, [phone('same-phone', { added_at: 1 })], 200)
  await confirmPhonesMerge(file)
  // The sender removed its old pairing, but this receiver paired that installation again afterward,
  // in the same second as the last reply. The next reply must carry this new pairing first.
  await new PhoneRegistry(file).register(
    phone('same-phone', { added_at: 200, auth: 'new-pairing-auth' }),
  )
  expect((await mergePhonesFile(file, [], 300)).map((phone) => phone.id)).toEqual(['same-phone'])
  await confirmPhonesMerge(file)
  // Once that exact pairing was acknowledged, a later sender removal wins again.
  expect(await mergePhonesFile(file, [], 400)).toEqual([])
})

it('an empty or broken phone list refuses pairing and never reads as no phones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phones-empty-'))
  dirs.push(dir)
  const path = join(dir, 'phones.json')
  for (const broken of ['', '[{"id":"a"']) {
    writeFileSync(path, broken)
    const registry = new PhoneRegistry(path)
    expect(registry.all()).toBeNull()
    await expect(
      registry.register({ id: 'new', sig_pub: 's', enc_pub: 'e', auth: 'a' }),
    ).rejects.toMatchObject({ status: 503 })
    expect(() => registry.verify('GET', '/x', {}, Buffer.alloc(0), 1)).toThrow(/cannot be read/)
    expect(readFileSync(path, 'utf8')).toBe(broken)
  }
})
