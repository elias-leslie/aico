import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  b64u,
  encrypt,
  FcmSender,
  itemPlaintext,
  PAYLOAD_MAX,
  readAccessToken,
  readDevices,
  unb64u,
} from './fcm'
import { parseNotice } from './notice'

/** The app's side of RFC 8291 (Rfc8291.decrypt in the Android app). */
function decrypt(record: Buffer, receiver: ReturnType<typeof createECDH>, auth: Buffer): Buffer {
  const salt = record.subarray(0, 16)
  const idLength = record.readUInt8(20)
  const sender = record.subarray(21, 21 + idLength)
  const body = record.subarray(21 + idLength)
  const secret = receiver.computeSecret(sender)
  const info = (label: string) => Buffer.from(`Content-Encoding: ${label}\0`)
  const ikm = Buffer.from(
    hkdfSync(
      'sha256',
      secret,
      auth,
      Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), sender]),
      32,
    ),
  )
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, info('aes128gcm'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, info('nonce'), 12))
  const decipher = createDecipheriv('aes-128-gcm', key, nonce)
  decipher.setAuthTag(body.subarray(body.length - 16))
  const plain = Buffer.concat([
    decipher.update(body.subarray(0, body.length - 16)),
    decipher.final(),
  ])
  expect(plain.at(-1)).toBe(2)
  expect(record.readUInt32BE(16)).toBe(4096)
  return plain.subarray(0, -1)
}

function phone() {
  const keys = createECDH('prime256v1')
  keys.generateKeys()
  const auth = randomBytes(16)
  return { keys, auth, encPub: b64u(keys.getPublicKey()), authText: b64u(auth) }
}

const notice = parseNotice({
  v: 1,
  source: 'ominull',
  severity: 'critical',
  title: 'Port scan from the lab',
  body: 'lab-01 swept 40 hosts on port 22.',
  detail: 'lab-01 swept 40 hosts on port 22. The sweep started at 20:15.',
  key: 'alerts:abc',
  fields: [{ label: 'Host', value: 'lab-01' }],
  actions: ['expected', 'not-expected'],
})

describe('encrypt', () => {
  it('makes one record the app can read', () => {
    const p = phone()
    const record = encrypt(p.encPub, p.authText, Buffer.from('hello phone'))
    expect(decrypt(record, p.keys, p.auth).toString()).toBe('hello phone')
  })
})

describe('itemPlaintext', () => {
  it('is the app item: channel, tag, group, a tap to Aico, the detail without the body', () => {
    const item = JSON.parse(
      itemPlaintext('a1b2', notice, 1_700_000_000_000, 'aico.example').toString(),
    )
    expect(item).toMatchObject({
      v: 1,
      id: 'a1b2',
      title: 'Port scan from the lab',
      severity: 'critical',
      channel: 'critical',
      tag: 'alerts:abc',
      group: 'ominull',
      kind: 'manual',
      ts: 1_700_000_000,
      url: 'https://aico.example/',
      public: 'Aico: critical alert',
    })
    expect(item.detail).toBe('The sweep started at 20:15.\nHost: lab-01')
    expect(item.actions).toEqual([
      { id: 'open', label: 'Open', tier: 'view', url: 'https://aico.example/' },
    ])
  })

  it('cuts the detail first to fit FCM', () => {
    const long = parseNotice({
      v: 1,
      source: 'aico',
      title: 'Long',
      body: 'Short body.',
      detail: 'é'.repeat(3000),
    })
    const data = itemPlaintext('a1', long, 0, null)
    expect(data.length).toBeLessThanOrEqual(PAYLOAD_MAX)
    const item = JSON.parse(data.toString())
    expect(item.body).toBe('Short body.')
    expect(item.detail.endsWith('…')).toBe(true)
    expect(item.url).toBeUndefined()
  })
})

describe('FcmSender', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-fcm-'))
  const tokenFile = join(dir, 'token.json')
  const devicesFile = join(dir, 'devices.json')
  const now = 1_700_000_000_000
  const p = phone()
  writeFileSync(
    devicesFile,
    JSON.stringify([
      { id: 'dev1', fcm_token: 'tok', enc_pub: p.encPub, auth: p.authText },
      { id: 'dev2', fcm_token: 'tok2', enc_pub: p.encPub, auth: p.authText, token_gone: 1 },
      { id: 'dev3', enc_pub: p.encPub, auth: p.authText },
    ]),
  )
  const token = (expiresAt: number) =>
    writeFileSync(
      tokenFile,
      JSON.stringify({ access_token: 'at', expires_at: expiresAt / 1000, project_id: 'proj' }),
    )

  it('reads only phones that can take a push, and only a token good for a minute', () => {
    expect(readDevices(devicesFile)?.map((d) => d.id)).toEqual(['dev1'])
    expect(readDevices(join(dir, 'missing.json'))).toBeNull()
    token(now + 30_000)
    expect(readAccessToken(tokenFile, now)).toBeNull()
    token(now + 3600_000)
    expect(readAccessToken(tokenFile, now)).toEqual({ project: 'proj', token: 'at' })
  })

  it('posts the encrypted item and maps the answers', async () => {
    token(now + 3600_000)
    const device = readDevices(devicesFile)?.[0]
    if (!device) throw new Error('no device')
    const calls: { url: string; init: RequestInit }[] = []
    const answer = (status: number, body: unknown = {}) =>
      new FcmSender(
        { tokenFile, devicesFile },
        (async (url: string, init: RequestInit) => {
          calls.push({ url, init })
          return new Response(JSON.stringify(body), { status })
        }) as typeof fetch,
        () => now,
      )
    expect(await answer(200).send(device, Buffer.from('{"v":1}'), 600)).toBe('sent')
    const sent = JSON.parse(String(calls[0]?.init.body))
    expect(calls[0]?.url).toBe('https://fcm.googleapis.com/v1/projects/proj/messages:send')
    expect(sent.message.token).toBe('tok')
    expect(sent.message.android).toEqual({ priority: 'HIGH', ttl: '600s' })
    expect(decrypt(unb64u(sent.message.data.ct), p.keys, p.auth).toString()).toBe('{"v":1}')
    const unregistered = { error: { details: [{ errorCode: 'UNREGISTERED' }] } }
    expect(await answer(404, unregistered).send(device, Buffer.from('x'), 1)).toBe('gone')
    expect(await answer(503).send(device, Buffer.from('x'), 1)).toBe('retry')
    expect(await answer(429).send(device, Buffer.from('x'), 1)).toBe('retry')
    expect(await answer(400).send(device, Buffer.from('x'), 1)).toBe('rejected:400')
    const failing = (error: unknown) =>
      new FcmSender(
        { tokenFile, devicesFile },
        (async () => {
          throw error
        }) as typeof fetch,
        () => now,
      )
    const fetchFailed = (code: string) =>
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error(code), { code }),
      })
    // No connection made: the request never left, so it goes again.
    expect(await failing(fetchFailed('ECONNREFUSED')).send(device, Buffer.from('x'), 1)).toBe(
      'retry',
    )
    expect(await failing(fetchFailed('EAI_AGAIN')).send(device, Buffer.from('x'), 1)).toBe('retry')
    // It may have reached FCM: never sent twice.
    expect(await failing(fetchFailed('ECONNRESET')).send(device, Buffer.from('x'), 1)).toBe(
      'unsure',
    )
    expect(await failing(fetchFailed('UND_ERR_SOCKET')).send(device, Buffer.from('x'), 1)).toBe(
      'unsure',
    )
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(await failing(timeout).send(device, Buffer.from('x'), 1)).toBe('unsure')
    token(now - 1)
    expect(await answer(200).send(device, Buffer.from('x'), 1)).toBe('no-token')
  })
})
