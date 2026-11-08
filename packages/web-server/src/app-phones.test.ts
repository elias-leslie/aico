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
    writeFileSync(
      `${path}.sync.json`,
      JSON.stringify({ at: 1, pending: 2, pending_receipt: 'reply' }),
    )
    const registry = new PhoneRegistry(path)
    const actions: Record<typeof operation, () => Promise<unknown>> = {
      pair: () => registry.register(phone('new')),
      remove: () => registry.remove('old'),
      ack: () => registry.ack('old', {}, 100),
      merge: () => mergePhonesFile(path, [phone('sent')], 200),
      confirm: () => confirmPhonesMerge(path, 'reply'),
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
  expect((await mergePhonesFile(file, sender, 200)).phones.map((p) => p.id)).toEqual(['old', 'new'])
  // The sender never got it, so its list still lacks the phone: it must survive again.
  const reply = await mergePhonesFile(file, sender, 300)
  expect(reply.phones.map((p) => p.id)).toEqual(['old', 'new'])
  // Once a reply is confirmed, the sender's list decides.
  await confirmPhonesMerge(file, reply.receipt)
  expect((await mergePhonesFile(file, sender, 400)).phones.map((p) => p.id)).toEqual(['old'])
})

it('keeps a phone paired after the merge in its same second, until a reply actually includes it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-confirm-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  const sender = [phone('old', { added_at: 1 })]
  writeFileSync(file, JSON.stringify(sender))
  writeFileSync(`${file}.sync.json`, JSON.stringify({ at: 100 }))
  const first = await mergePhonesFile(file, sender, 200)
  expect(first.phones.map((p) => p.id)).toEqual(['old'])
  // The reply above contains only "old"; this pairing happened later in the same wall-clock second.
  await new PhoneRegistry(file).register(phone('new', { added_at: 200 }))
  await confirmPhonesMerge(file, first.receipt)
  const second = await mergePhonesFile(file, sender, 300)
  expect(second.phones.map((p) => p.id)).toEqual(['old', 'new'])
  // Once a confirmed reply contains it, a removal on the sender is authoritative again.
  await confirmPhonesMerge(file, second.receipt)
  expect((await mergePhonesFile(file, sender, 400)).phones.map((p) => p.id)).toEqual(['old'])
})

it('only acknowledges the receipt of the exact pending reply, even within one second', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-reply-receipt-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  const first = await mergePhonesFile(file, [phone('sent')], 200)
  await new PhoneRegistry(file).register(phone('paired-here', { added_at: 200 }))
  const second = await mergePhonesFile(file, [phone('sent')], 200)
  expect(second.receipt).not.toBe(first.receipt)
  const cursor = readFileSync(`${file}.sync.json`, 'utf8')
  const phones = readFileSync(file, 'utf8')
  for (const receipt of [undefined, 'wrong-receipt', first.receipt]) {
    await confirmPhonesMerge(file, receipt)
    expect(readFileSync(`${file}.sync.json`, 'utf8')).toBe(cursor)
    expect(readFileSync(file, 'utf8')).toBe(phones)
  }
  await confirmPhonesMerge(file, second.receipt)
  expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8'))).toMatchObject({
    at: 200,
    ids: ['sent', 'paired-here'],
  })
  expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8'))).not.toHaveProperty('pending')
})

it('leaves a legacy pending cursor unconfirmed until a new exchange returns a receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-legacy-receipt-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  const phones = [phone('sent')]
  writeFileSync(file, JSON.stringify(phones))
  const cursor = JSON.stringify({ at: 100, pending: 200, pending_ids: ['sent'] })
  writeFileSync(`${file}.sync.json`, cursor)
  for (const receipt of [undefined, 'unknown-receipt']) {
    await confirmPhonesMerge(file, receipt)
    expect(readFileSync(`${file}.sync.json`, 'utf8')).toBe(cursor)
  }
  const fresh = await mergePhonesFile(file, phones, 300)
  await confirmPhonesMerge(file, fresh.receipt)
  expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8'))).toMatchObject({
    at: 300,
    ids: ['sent'],
  })
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
  expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8')).received_pairs).toEqual({
    kept: [null],
    'sent-new': [null],
  })
  expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8'))).not.toHaveProperty('pending')
  failed.mockRestore()
  // No reply was produced, so there is no confirm. A retry with the sender phone removed is safe.
  expect(
    (await mergePhonesFile(file, [phone('kept')], 300)).phones.map((phone) => phone.id),
  ).toEqual(['kept', 'paired-here'])
})

it('distinguishes a fresh local pairing of a known phone from the pairing the sender already knew', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-repairing-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  const first = await mergePhonesFile(file, [phone('same-phone', { added_at: 1 })], 200)
  await confirmPhonesMerge(file, first.receipt)
  // The sender removed its old pairing, but this receiver paired that installation again afterward,
  // in the same second as the last reply. The next reply must carry this new pairing first.
  await new PhoneRegistry(file).register(
    phone('same-phone', { added_at: 200, auth: 'new-pairing-auth' }),
  )
  const second = await mergePhonesFile(file, [], 300)
  expect(second.phones.map((phone) => phone.id)).toEqual(['same-phone'])
  await confirmPhonesMerge(file, second.receipt)
  // Once that exact pairing was acknowledged, a later sender removal wins again.
  expect((await mergePhonesFile(file, [], 400)).phones).toEqual([])
})

it('keeps an unconfirmed local re-pair when the sender still sends the acknowledged old pairing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-pairing-conflict-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  const old = phone('same-phone', { added_at: 1, auth: 'old-auth', last_ack: 999 })
  const first = await mergePhonesFile(file, [old], 200)
  await confirmPhonesMerge(file, first.receipt)
  const registry = new PhoneRegistry(file)
  // Re-pair after the last reply, within its same second, with new encryption material.
  await registry.register(
    phone('same-phone', { added_at: 200, auth: 'new-auth', enc_pub: 'new-enc' }),
  )
  const fresh = registry.get('same-phone')
  expect(fresh?.pairing_id).toBeTruthy()
  const second = await mergePhonesFile(file, [old], 300)
  expect(second.phones).toEqual([fresh])
  await confirmPhonesMerge(file, second.receipt)
  expect((await mergePhonesFile(file, [], 400)).phones).toEqual([])
})

it('takes a new sender pairing over the receiver copy of an acknowledged old pairing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aico-phone-new-sender-'))
  dirs.push(dir)
  const file = join(dir, 'phones.json')
  const old = phone('same-phone', { pairing_id: 'old-pair', auth: 'old-auth', last_ack: 999 })
  const first = await mergePhonesFile(file, [old], 200)
  await confirmPhonesMerge(file, first.receipt)
  const fresh = phone('same-phone', {
    pairing_id: 'new-sender-pair',
    auth: 'new-auth',
    last_ack: 1,
  })
  const second = await mergePhonesFile(file, [fresh], 300)
  expect(second.phones).toEqual([fresh])
  expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8')).received_pairs).toEqual({
    'same-phone': ['new-sender-pair'],
  })
  await confirmPhonesMerge(file, second.receipt)
  expect((await mergePhonesFile(file, [], 400)).phones).toEqual([])
})

it.each(['phone list', 'reply cursor'])(
  'does not advance the acknowledged pairing when a new sender %s write fails',
  async (stage) => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-phone-sender-write-failure-'))
    dirs.push(dir)
    const file = join(dir, 'phones.json')
    const old = phone('same-phone', { pairing_id: 'old-pair', auth: 'old-auth' })
    const fresh = phone('same-phone', { pairing_id: 'new-pair', auth: 'new-auth' })
    const first = await mergePhonesFile(file, [old], 200)
    await confirmPhonesMerge(file, first.receipt)
    const write = durableFile.writeFileDurable
    let cursorWrites = 0
    const failed = vi
      .spyOn(durableFile, 'writeFileDurable')
      .mockImplementation((path, data, options) => {
        if (path === `${file}.sync.json`) cursorWrites++
        if (
          (stage === 'phone list' && path === file) ||
          (stage === 'reply cursor' && path === `${file}.sync.json` && cursorWrites === 2)
        )
          throw new Error('merge write failed')
        write(path, data, options)
      })
    await expect(mergePhonesFile(file, [fresh], 300)).rejects.toThrow('merge write failed')
    failed.mockRestore()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([stage === 'phone list' ? old : fresh])
    const interrupted = JSON.parse(readFileSync(`${file}.sync.json`, 'utf8'))
    expect(interrupted.known_pairs).toEqual({ 'same-phone': 'old-pair' })
    expect(interrupted.received_pairs).toEqual({
      'same-phone': ['old-pair', 'new-pair'],
    })
    expect(interrupted).not.toHaveProperty('pending')
    // Retry the same request: the unchanged old local record must not be mistaken for a fresh pairing.
    const second = await mergePhonesFile(file, [fresh], 400)
    expect(second.phones).toEqual([fresh])
    expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8')).known_pairs).toEqual({
      'same-phone': 'old-pair',
    })
    await confirmPhonesMerge(file, second.receipt)
    expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8')).known_pairs).toEqual({
      'same-phone': 'new-pair',
    })
  },
)

it.each(['current', 'legacy'])(
  'does not resurrect a received pairing when its replacement list write fails (%s cursor)',
  async (cursorFormat) => {
    const dir = mkdtempSync(join(tmpdir(), 'aico-phone-replacement-cut-'))
    dirs.push(dir)
    const file = join(dir, 'phones.json')
    const acknowledged = phone('same-phone', { pairing_id: 'pair-a', auth: 'auth-a' })
    const received = phone('same-phone', { pairing_id: 'pair-b', auth: 'auth-b' })
    const replacement = phone('same-phone', { pairing_id: 'pair-c', auth: 'auth-c' })
    const first = await mergePhonesFile(file, [acknowledged], 200)
    await confirmPhonesMerge(file, first.receipt)
    // B reached the receiver, but its reply never reached the sender, so A remains acknowledged.
    expect((await mergePhonesFile(file, [received], 300)).phones).toEqual([received])
    if (cursorFormat === 'legacy') {
      const cursor = JSON.parse(readFileSync(`${file}.sync.json`, 'utf8'))
      writeFileSync(
        `${file}.sync.json`,
        JSON.stringify({ ...cursor, received_pairs: { 'same-phone': 'pair-b' } }),
      )
    }
    const write = durableFile.writeFileDurable
    const failed = vi
      .spyOn(durableFile, 'writeFileDurable')
      .mockImplementation((path, data, options) => {
        if (path === file) throw new Error('replacement list write interrupted')
        write(path, data, options)
      })
    await expect(mergePhonesFile(file, [replacement], 400)).rejects.toThrow(
      'replacement list write interrupted',
    )
    failed.mockRestore()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([received])
    const interrupted = JSON.parse(readFileSync(`${file}.sync.json`, 'utf8'))
    expect(interrupted.known_pairs).toEqual({ 'same-phone': 'pair-a' })
    expect(interrupted.received_pairs).toEqual({ 'same-phone': ['pair-b', 'pair-c'] })
    // C never reached the list. Removing the phone at the sender must still remove received B.
    expect((await mergePhonesFile(file, [], 500)).phones).toEqual([])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([])
    expect(JSON.parse(readFileSync(`${file}.sync.json`, 'utf8')).received_pairs).toEqual({})
  },
)

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
