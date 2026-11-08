import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NotifyStore, parseNotice } from '@aico/notify'
import { type StatusRow, StatusStore } from '@aico/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppApi, setDrill } from './app-api'
import { AppError, canonical, deviceIdOf, PhoneRegistry } from './app-phones'
import { publishApk } from './app-release'
import type { Ask } from './asks'
import { Router } from './http'
import { createWebServer } from './server'
import type { TerminalHub } from './terminal'

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0)
const guard = {
  allowedHostnames: ['localhost', '127.0.0.1', 'aico.example.dev'],
  allowedOrigins: [],
  phoneHosts: ['phone.example.dev'],
}
const MINUTE = 60_000

let dir: string
let server: Server
let port: number
let status: StatusStore
let notify: NotifyStore
let phones: PhoneRegistry
let asks: Ask[]
let answered: { id: string; option: number }[]
let clock: number
let device: string
let privateKey: KeyObject

const ask = (over: Partial<Ask> = {}): Ask => ({
  id: 'a1b2c3d4e5f6',
  session: null,
  requester: 'tester',
  question: 'Install the update?',
  options: ['Yes', 'Later'],
  recommended: 0,
  body: 'It takes a minute.',
  command: null,
  share: null,
  wantsFiles: null,
  files: [],
  blocking: true,
  state: 'open',
  answer: null,
  note: null,
  delivery: null,
  createdAt: NOW - 10 * MINUTE,
  updatedAt: NOW - 10 * MINUTE,
  answeredAt: null,
  ...over,
})

const row = (over: Partial<StatusRow>): StatusRow => ({
  id: 'here/check-x',
  what: 'Check x',
  kind: 'check',
  machine: 'here',
  state: 'ok',
  meaning: 'Fine.',
  ...over,
})

function reports(webAgoMin: number | null, checkAgoMin: number | null): void {
  const at = (agoMin: number) => {
    clock = NOW - agoMin * MINUTE
    return new Date(clock).toISOString()
  }
  // The machine's own row, so its other rows do not show unknown.
  status.upsert([
    row({
      id: 'here/machine',
      what: 'here',
      kind: 'machine',
      last_run: new Date(NOW).toISOString(),
      next_run: new Date(NOW + 60 * MINUTE).toISOString(),
    }),
  ])
  if (webAgoMin !== null)
    status.upsert([
      row({
        id: 'here/aico-web',
        what: 'Aico web server',
        kind: 'service',
        last_run: at(webAgoMin),
      }),
    ])
  if (checkAgoMin !== null) status.upsert([row({ last_run: at(checkAgoMin) })])
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aico-app-'))
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  privateKey = pair.privateKey
  const jwk = pair.publicKey.export({ format: 'jwk' })
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x as string, 'base64url'),
    Buffer.from(jwk.y as string, 'base64url'),
  ])
  const sigPub = point.toString('base64url')
  device = deviceIdOf(sigPub)
  const file = join(dir, 'phones.json')
  writeFileSync(
    file,
    JSON.stringify([{ id: device, sig_pub: sigPub, enc_pub: 'x', auth: 'y', fcm_token: 'old' }]),
  )
  phones = new PhoneRegistry(file, NOW / 1000 - 3600)
  clock = NOW
  status = new StatusStore(':memory:', () => clock)
  notify = new NotifyStore(':memory:')
  asks = []
  answered = []
  const api = new AppApi({
    phones,
    status,
    notify,
    asks: {
      list: async () => asks,
      answer: async (id, reply) => {
        answered.push({ id, option: reply.option })
        return ask({ id, state: 'answered' })
      },
      approvals: async () => [],
    },
    machine: 'here',
    publicHost: 'aico.example.dev',
    dataDir: dir,
    now: () => NOW,
    watchMs: 40,
  })
  const router = new Router()
  api.register(router)
  server = createWebServer(guard, router, {} as TerminalHub)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  status.close()
  notify.close()
})

interface Reply {
  status: number
  type: string
  // biome-ignore lint/suspicious/noExplicitAny: test JSON answers
  body: any
  raw: Buffer
}

/** A request signed the way the app signs it; `tweak` changes the headers after signing. */
function call(
  method: string,
  path: string,
  options: { body?: unknown; ts?: number; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const payload = Buffer.from(options.body === undefined ? '' : JSON.stringify(options.body))
  const ts = String(options.ts ?? Math.floor(NOW / 1000))
  const sig = sign('sha256', Buffer.from(canonical(method, path, ts, payload)), {
    key: privateKey,
    dsaEncoding: 'der',
  }).toString('base64url')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          'x-nightshift-device': device,
          'x-nightshift-ts': ts,
          'x-nightshift-sig': sig,
          ...options.headers,
        },
      },
      (res) => {
        const parts: Buffer[] = []
        res.on('data', (chunk: Buffer) => parts.push(chunk))
        res.on('end', () => {
          const raw = Buffer.concat(parts)
          const type = String(res.headers['content-type'] ?? '')
          resolve({
            status: res.statusCode ?? 0,
            type,
            body: type.includes('json') ? JSON.parse(raw.toString() || 'null') : null,
            raw,
          })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

describe('signed calls', () => {
  it('removes exactly the named phone and preserves other paired phones', async () => {
    const other = {
      ...(phones.get(device) as NonNullable<ReturnType<typeof phones.get>>),
      id: 'other-test-phone',
      fcm_token: 'other-token',
    }
    await phones.register(other)
    const reply = await call('DELETE', `/api/phone-app/${device}`)
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ removed: true })
    expect(phones.get(device)).toBeNull()
    expect(phones.get(other.id)).toEqual(other)
    expect((await call('DELETE', `/api/phone-app/${device}`)).body).toEqual({ removed: false })
  })

  it('reports phone receipt metadata to the owner without pairing keys or tokens', async () => {
    const ack = { id: 'test-message', received_at: NOW / 1000, shown: true }
    await phones.ack(device, { acks: [{ t: 'm', ...ack }] }, NOW / 1000)
    const reply = await call('GET', '/api/phone-app')
    expect(reply.body.phones[0].last_message_ack).toEqual(ack)
    expect(Object.keys(reply.body.phones[0]).sort()).toEqual([
      'id',
      'last_ack',
      'last_message_ack',
      'name',
    ])
  })

  it('refuses a missing, wrong or old signature with {error}', async () => {
    const plain = await call('GET', '/api/app/health', { headers: { 'x-nightshift-sig': 'AAAA' } })
    expect(plain.status).toBe(401)
    expect(plain.body.error).toMatch(/signature/)
    const stranger = await call('GET', '/api/app/health', {
      headers: { 'x-nightshift-device': 'nobody' },
    })
    expect(stranger.status).toBe(401)
    expect(stranger.body.error).toMatch(/unknown device/)
    const late = await call('GET', '/api/app/health', { ts: Math.floor(NOW / 1000) - 400 })
    expect(late.status).toBe(401)
    expect(late.body.error).toMatch(/clock/)
  })

  it('does not accept a signature made for another path or body', async () => {
    const reply = await call('POST', '/api/app/token', {
      body: { fcm_token: 'new' },
      headers: { 'x-nightshift-sig': 'MEUCIQ' },
    })
    expect(reply.status).toBe(401)
  })
})

describe('health', () => {
  it('is fresh when aico-web and a host check both reported lately, as the older of the two', async () => {
    reports(2, 20)
    const reply = await call('GET', '/api/app/health')
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({
      ok: true,
      now: NOW / 1000,
      checked_at: (NOW - 20 * MINUTE) / 1000,
    })
    expect(reply.body.line).toMatch(/^last check \d\d:\d\d, phone confirmed never$/)
  })

  it('has no checked_at when the host checks have not reported, so the phone sees it stale', async () => {
    reports(2, null)
    const reply = await call('GET', '/api/app/health')
    expect(reply.body.checked_at).toBeNull()
  })

  it('goes stale when aico-web itself stopped reporting', async () => {
    reports(90, 1)
    const reply = await call('GET', '/api/app/health')
    expect(reply.body.checked_at).toBe((NOW - 90 * MINUTE) / 1000)
  })

  it('records the probe, and answers 503 {drill:true} during a drill', async () => {
    reports(1, 1)
    await call('GET', '/api/app/health')
    expect(phones.get(device)?.last_probe).toBe(NOW / 1000)
    setDrill(dir, 10, NOW)
    const drill = await call('GET', '/api/app/health')
    expect(drill.status).toBe(503)
    expect(drill.body).toEqual({ drill: true })
    setDrill(dir, null, NOW)
    expect((await call('GET', '/api/app/health')).status).toBe(200)
  })

  it('moves the probe only for a request signed later than the last one', async () => {
    reports(1, 1)
    const at = NOW / 1000
    await call('GET', '/api/app/health', { ts: at - 30 })
    expect(phones.get(device)?.last_probe).toBe(at - 30)
    await call('GET', '/api/app/health', { ts: at - 60 }) // a copy of an older request
    expect(phones.get(device)?.last_probe).toBe(at - 30)
    await call('GET', '/api/app/health', { ts: at - 30 })
    expect(phones.get(device)?.last_probe).toBe(at - 30)
    await call('GET', '/api/app/health', { ts: at + 100 }) // never ahead of this clock
    expect(phones.get(device)?.last_probe).toBe(at)
  })

  it('says why the phone cannot buzz, after an ack says notifications are off', async () => {
    reports(1, 1)
    await call('POST', '/api/app/ack', {
      body: { acks: [], state: { notifications: false, app_version: '0.3.0' } },
    })
    const reply = await call('GET', '/api/app/health')
    expect(reply.body.line).toMatch(/phone can't buzz: notifications are off/)
    expect(reply.body.phone_confirmed_at).toBe(NOW / 1000)
  })
})

describe('items', () => {
  it('lists Status problems, open questions with a button per option, and recent notices', async () => {
    reports(1, 1)
    status.upsert([
      row({
        id: 'here/check-bad',
        what: 'Backups',
        kind: 'backup',
        state: 'failed',
        meaning: 'Last run failed.',
      }),
    ])
    asks = [ask(), ask({ id: '000000000001', question: 'Row ask', state: 'open' })]
    notify.setRowAsk('here/check-bad', '000000000001', NOW)
    const stored = notify.accept(
      parseNotice({
        v: 1,
        source: 'tester',
        kind: 'alert',
        severity: 'warning',
        title: 'Disk is filling',
        body: '90 percent.',
        push: 'phone',
        interrupt: 'needs-you',
        open: 'https://aico.example.dev/status',
      }),
      'local',
      [device],
      NOW - 5 * MINUTE,
    )
    notify.accept(
      parseNotice({
        v: 1,
        source: 'tester',
        kind: 'info',
        severity: 'info',
        title: 'Desktop only',
        body: 'x',
      }),
      'local',
      [],
      NOW,
    )

    const reply = await call('GET', '/api/app/items')
    expect(reply.status).toBe(200)
    const needs = reply.body.needs_you
    expect(needs.map((r: { id: string }) => r.id)).toEqual(['k:here/check-bad', 'q:a1b2c3d4e5f6'])
    expect(needs[0]).toMatchObject({
      title: 'Backups failed',
      severity: 'critical',
      state: 'Failed',
      item: null,
    })
    expect(needs[0].actions[0]).toMatchObject({
      id: 'open',
      url: 'https://aico.example.dev/status',
    })
    const question = needs[1]
    expect(question).toMatchObject({ item: 'a1b2c3d4e5f6', state: 'Needs your answer', age: '10m' })
    expect(question.actions.map((a: { label: string }) => a.label)).toEqual([
      'Yes',
      'Later',
      'Open in Aico',
    ])
    expect(question.actions[0].id).toMatch(/^choice:0:[0-9a-f]{8}$/)
    expect(reply.body.recent).toHaveLength(1)
    expect(reply.body.recent[0]).toMatchObject({
      id: `n:${stored.id}`,
      item: stored.id,
      title: 'Disk is filling',
      age: '5m ago',
      url: 'https://aico.example.dev/status',
    })
    expect(reply.body.health.ok).toBe(true)
  })

  it('shows an empty list as empty', async () => {
    const reply = await call('GET', '/api/app/items')
    expect(reply.body.needs_you).toEqual([])
    expect(reply.body.recent).toEqual([])
  })
})

describe('act', () => {
  async function choiceFor(index: number): Promise<string> {
    asks = [ask()]
    const items = await call('GET', '/api/app/items')
    return items.body.needs_you[0].actions[index].id
  }

  it('answers the question with the option the button names', async () => {
    const action = await choiceFor(1)
    const reply = await call('POST', '/api/app/items/a1b2c3d4e5f6/act', { body: { action } })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ ok: true, text: 'Answered: Later.' })
    expect(answered).toEqual([{ id: 'a1b2c3d4e5f6', option: 1 }])
  })

  it('takes the older route by row id too', async () => {
    const action = await choiceFor(0)
    const reply = await call('POST', '/api/app/act', { body: { row: 'q:a1b2c3d4e5f6', action } })
    expect(reply.body.ok).toBe(true)
    expect(answered).toEqual([{ id: 'a1b2c3d4e5f6', option: 0 }])
  })

  it('says no longer open when the ask closed or its options changed', async () => {
    const action = await choiceFor(0)
    asks = [ask({ state: 'answered' })]
    const closed = await call('POST', '/api/app/items/a1b2c3d4e5f6/act', { body: { action } })
    expect(closed.status).toBe(409)
    expect(closed.body.error).toBe('No longer open.')
    asks = [ask({ options: ['No', 'Never'] })]
    const changed = await call('POST', '/api/app/items/a1b2c3d4e5f6/act', {
      body: { action },
      ts: NOW / 1000 + 1,
    })
    expect(changed.status).toBe(409)
    expect(changed.body.error).toBe('No longer open.')
    expect(answered).toEqual([])
  })

  it('answers the plain 404 the app looks for when there is no such item', async () => {
    const reply = await call('POST', '/api/app/items/ffffffffffff/act', {
      body: { action: 'mark-read' },
    })
    expect(reply.status).toBe(404)
    expect(reply.body).toEqual({ error: 'not found' })
    const noAction = await call('POST', '/api/app/items/ffffffffffff/act', { body: {} })
    expect(noAction.status).toBe(400)
  })

  it('marks a notice read, and refuses an action it does not offer', async () => {
    const stored = notify.accept(
      parseNotice({
        v: 1,
        source: 'tester',
        kind: 'alert',
        severity: 'warning',
        title: 'T',
        body: 'B',
        push: 'phone',
        interrupt: 'needs-you',
      }),
      'local',
      [device],
      NOW,
    )
    const read = await call('POST', `/api/app/items/${stored.id}/act`, {
      body: { action: 'mark-read' },
    })
    expect(read.body).toMatchObject({ ok: true, text: 'Marked read.' })
    expect(notify.readMarks().reads.has(stored.id)).toBe(true)
    const odd = await call('POST', `/api/app/items/${stored.id}/act`, { body: { action: 'mute' } })
    expect(odd.status).toBe(400)
  })
})

describe('a signed POST is used once', () => {
  const body = { fcm_token: 'once' }
  const path = '/api/app/token'
  const signOnce = (ts = String(Math.floor(NOW / 1000))) =>
    sign('sha256', Buffer.from(canonical('POST', path, ts, Buffer.from(JSON.stringify(body)))), {
      key: privateKey,
      dsaEncoding: 'der',
    })
  const send = (sig: string) => call('POST', path, { body, headers: { 'x-nightshift-sig': sig } })

  it('answers a copy of the same signed request with 409, and a new signature is a new request', async () => {
    const sig = signOnce().toString('base64url')
    expect((await send(sig)).status).toBe(200)
    const copy = await send(sig)
    expect(copy.status).toBe(409)
    expect(copy.body.error).toMatch(/already used/)
    expect((await call('POST', path, { body, ts: NOW / 1000 + 1 })).status).toBe(200)
  })

  it('does not let a respelled signature through as a new key', async () => {
    const sig = signOnce().toString('base64url')
    expect((await send(sig)).status).toBe(200)
    for (const spelled of [`${sig}=`, `${sig}!`]) expect((await send(spelled)).status).toBe(409)
  })

  it('refuses a respelled signature before any use, and that does not burn the real one', async () => {
    const sig = signOnce().toString('base64url')
    for (const spelled of [`${sig}=`, `${sig}!`]) expect((await send(spelled)).status).toBe(401)
    expect((await send(sig)).status).toBe(200)
  })

  it('treats the other half of the same signature (r, n-s) as the same request', async () => {
    const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n
    const der = signOnce()
    // DER: 30 len 02 rl r 02 sl s
    const rl = der[3] as number
    const r = der.subarray(4, 4 + rl)
    const s = BigInt(`0x${der.subarray(6 + rl).toString('hex')}`)
    const flipped = n - s
    const sBytes = Buffer.from(flipped.toString(16).padStart(64, '0'), 'hex')
    const sInt = sBytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), sBytes]) : sBytes
    const body2 = Buffer.concat([
      Buffer.from([2, r.length]),
      r,
      Buffer.from([2, sInt.length]),
      sInt,
    ])
    const other = Buffer.concat([Buffer.from([0x30, body2.length]), body2])
    expect(other.equals(der)).toBe(false)
    expect((await send(der.toString('base64url'))).status).toBe(200)
    expect((await send(other.toString('base64url'))).status).toBe(409)
  })

  it('does not reopen after a restart: a POST signed before the process started is refused', () => {
    const file = phones.path
    const later = new PhoneRegistry(file, NOW / 1000 + 10)
    const bodyBuf = Buffer.from(JSON.stringify(body))
    const ts = String(Math.floor(NOW / 1000))
    const sig = sign('sha256', Buffer.from(canonical('POST', path, ts, bodyBuf)), {
      key: privateKey,
      dsaEncoding: 'der',
    }).toString('base64url')
    const headers = {
      'x-nightshift-device': device,
      'x-nightshift-ts': ts,
      'x-nightshift-sig': sig,
    }
    let caught: unknown
    try {
      later.verify('POST', path, headers, bodyBuf, NOW / 1000 + 20)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).status).toBe(409)
    // a GET is not remembered at all, so it is not held back
    const get = {
      ...headers,
      'x-nightshift-sig': sign('sha256', Buffer.from(canonical('GET', path, ts, Buffer.alloc(0))), {
        key: privateKey,
        dsaEncoding: 'der',
      }).toString('base64url'),
    }
    expect(later.verify('GET', path, get, Buffer.alloc(0), NOW / 1000 + 20).id).toBe(device)
  })
})

describe('the phone host', () => {
  const onPhoneHost = (method: string, path: string) =>
    call(method, path, { headers: { host: 'phone.example.dev' } })

  it('answers the phone routes there, signed like anywhere else', async () => {
    expect((await onPhoneHost('GET', '/api/app/health')).status).toBe(200)
    const unsigned = await call('GET', '/api/app/health', {
      headers: { host: 'phone.example.dev', 'x-nightshift-sig': 'AAAA' },
    })
    expect(unsigned.status).toBe(401)
  })

  it('refuses every other path there, however it is written', async () => {
    for (const path of [
      '/api/status',
      '/api/app',
      '/api/app/../status',
      '/api/app/%2e%2e/status',
      '/api/app/%2E%2E/status',
      '/api/app/x/%2fstatus',
      '/api/app//health',
      '/api/app/..%5cstatus',
      '/',
    ]) {
      const reply = await onPhoneHost('GET', path)
      expect([path, reply.status]).toEqual([path, 403])
    }
    const page = await onPhoneHost('GET', '/api/app/health?x=1')
    expect(page.status).toBe(200)
  })

  it('keeps the owner routes on the owner hosts', async () => {
    expect((await call('GET', '/api/app/health')).status).toBe(200)
  })
})

describe('token and ack', () => {
  it('keeps the rotated FCM token and what the phone last said', async () => {
    const token = await call('POST', '/api/app/token', { body: { fcm_token: 'fresh' } })
    expect(token.body).toEqual({ ok: true })
    expect(phones.get(device)).toMatchObject({ fcm_token: 'fresh', token_at: NOW / 1000 })
    expect((await call('POST', '/api/app/token', { body: {} })).status).toBe(400)

    const ack = await call('POST', '/api/app/ack', {
      body: {
        acks: [{ id: 'x', t: 'e', error: 'BadTag' }],
        state: { notifications: true, channels: { critical: 4, bogus: 1 }, app_version: '0.3.0' },
      },
    })
    expect(ack.body).toEqual({ ok: true })
    const phone = phones.get(device)
    expect(phone).toMatchObject({ last_ack: NOW / 1000, read_error: 'BadTag' })
    expect(phone?.state?.channels).toEqual({ critical: 4 })
    await call('POST', '/api/app/ack', { body: { acks: [{ id: 'y', t: 'm' }] } })
    expect(phones.get(device)?.read_error).toBeUndefined()
  })

  it('refuses a body that is not a JSON object', async () => {
    const reply = await call('POST', '/api/app/ack', { body: [1] })
    expect(reply.status).toBe(400)
  })
})

describe('update and apk', () => {
  function buildApk(code: number, name: string): string {
    const out = join(dir, 'build')
    mkdirSync(out, { recursive: true })
    writeFileSync(
      join(out, 'app-release.apk'),
      Buffer.concat([Buffer.from('PK'), Buffer.alloc(300, code)]),
    )
    writeFileSync(
      join(out, 'output-metadata.json'),
      JSON.stringify({
        elements: [{ outputFile: 'app-release.apk', versionCode: code, versionName: name }],
      }),
    )
    return join(out, 'app-release.apk')
  }

  it('has nothing to offer before a publish', async () => {
    const reply = await call('GET', '/api/app/update')
    expect(reply.status).toBe(404)
    expect(reply.body.error).toMatch(/nothing/)
    expect((await call('GET', '/api/app/apk')).status).toBe(404)
  })

  it('offers the published version, and serves the bytes the record names', async () => {
    const release = publishApk(dir, buildApk(13, '0.3.0'))
    const update = await call('GET', '/api/app/update')
    expect(update.body).toEqual({
      version_code: 13,
      version_name: '0.3.0',
      sha256: release.sha256,
      size: 302,
      download: '/api/app/apk',
    })
    const apk = await call('GET', '/api/app/apk')
    expect(apk.type).toBe('application/vnd.android.package-archive')
    expect(apk.raw.length).toBe(302)
    expect(readFileSync(join(dir, 'app', 'aico.apk')).equals(apk.raw)).toBe(true)
  })

  it('does not publish something that is not an APK', () => {
    const bad = join(dir, 'bad.apk')
    writeFileSync(bad, 'nope')
    expect(() => publishApk(dir, bad)).toThrow(/not an APK/)
  })
})

/** Opens the live feed as the test phone; `closed` settles when the server ends it. */
function openFeed(): Promise<{ closed: Promise<void>; open: () => boolean; drop: () => void }> {
  const path = '/api/app/stream'
  const ts = String(Math.floor(NOW / 1000))
  const sig = sign('sha256', Buffer.from(canonical('GET', path, ts, Buffer.alloc(0))), {
    key: privateKey,
    dsaEncoding: 'der',
  }).toString('base64url')
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: {
          host: `127.0.0.1:${port}`,
          'x-nightshift-device': device,
          'x-nightshift-ts': ts,
          'x-nightshift-sig': sig,
        },
      },
      (res) => {
        let over = false
        const closed = new Promise<void>((done) => {
          res.on('end', () => {
            over = true
            done()
          })
          res.on('close', () => {
            over = true
            done()
          })
        })
        res.resume()
        resolve({ closed, open: () => !over, drop: () => req.destroy() })
      },
    )
    req.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
    })
    req.end()
  })
}

describe('live feeds', () => {
  it('keeps one feed per phone: a new one closes the oldest', async () => {
    const first = await openFeed()
    const second = await openFeed()
    await first.closed
    expect(first.open()).toBe(false)
    expect(second.open()).toBe(true)
    const third = await openFeed()
    await second.closed
    expect(third.open()).toBe(true)
    third.drop()
  })

  it('closes a phone feed once the phone is unpaired', async () => {
    const feed = await openFeed()
    writeFileSync(phones.path, '[]')
    await feed.closed
    expect(feed.open()).toBe(false)
  })
})

describe('live feed', () => {
  it('opens with retry and hello, then a reset for an id from the future', async () => {
    const text = await new Promise<string>((resolve, reject) => {
      const path = '/api/app/stream'
      const ts = String(Math.floor(NOW / 1000))
      const sig = sign('sha256', Buffer.from(canonical('GET', path, ts, Buffer.alloc(0))), {
        key: privateKey,
        dsaEncoding: 'der',
      }).toString('base64url')
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          headers: {
            host: `127.0.0.1:${port}`,
            'last-event-id': String(NOW + 10 * MINUTE),
            'x-nightshift-device': device,
            'x-nightshift-ts': ts,
            'x-nightshift-sig': sig,
          },
        },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream')
          let got = ''
          res.on('data', (chunk) => {
            got += chunk
            if (got.includes('event: hello')) {
              req.destroy()
              resolve(got)
            }
          })
        },
      )
      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
      })
      req.end()
    })
    expect(text).toContain('retry: 3000')
    expect(text.indexOf('event: reset')).toBeLessThan(text.indexOf('event: hello'))
  })
})

// contracts/phone-api-fixtures.json: the shapes the phone app parses (its tests read the same file).
describe('the phone API contract', () => {
  const fixtures = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../contracts/phone-api-fixtures.json', import.meta.url)),
      'utf8',
    ),
  )

  /** Keys and value types; an array is the sorted set of its elements' shapes. */
  function shape(value: unknown): unknown {
    if (value === null) return 'null'
    if (Array.isArray(value))
      return [...new Set(value.map((item) => JSON.stringify(shape(item))))].sort()
    if (typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as object)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, shape(item)]),
      )
    return typeof value
  }

  it('health, items, act, errors and the drill answer in those shapes', async () => {
    reports(1, 1)
    status.upsert([
      row({
        id: 'here/backups',
        what: 'Backups',
        kind: 'backup',
        state: 'failed',
        meaning: 'Failed.',
      }),
    ])
    asks = [ask()]
    notify.accept(
      parseNotice({
        v: 1,
        source: 'tester',
        kind: 'alert',
        severity: 'warning',
        title: 'Disk is filling',
        body: '90 percent.',
        push: 'phone',
        interrupt: 'needs-you',
        open: 'https://aico.example.dev/status',
      }),
      'local',
      [device],
      NOW,
    )
    // phone_confirmed_at is null until a phone has acked; the fixture's items sample is that case.
    const items = (await call('GET', '/api/app/items')).body
    expect(shape(items)).toEqual(shape(fixtures.items))
    await call('POST', '/api/app/ack', { body: { acks: [] } })
    expect(shape((await call('GET', '/api/app/health')).body)).toEqual(shape(fixtures.health))
    const choice = items.needs_you[1].actions[0].id
    const act = (
      await call('POST', '/api/app/act', { body: { row: 'q:a1b2c3d4e5f6', action: choice } })
    ).body
    expect(shape(act)).toEqual(shape(fixtures.act))
    asks = [ask({ state: 'answered' })]
    const closed = await call('POST', '/api/app/act', {
      body: { row: 'q:a1b2c3d4e5f6', action: choice },
      ts: NOW / 1000 + 1,
    })
    expect(closed.status).toBe(409)
    expect(closed.body).toEqual(fixtures.error)
    setDrill(dir, 5, NOW)
    expect((await call('GET', '/api/app/health')).body).toEqual(fixtures.drill)
  })

  it('update answers in the manifest shape', async () => {
    publishApk(
      dir,
      (() => {
        const out = join(dir, 'build')
        mkdirSync(out, { recursive: true })
        writeFileSync(
          join(out, 'app-release.apk'),
          Buffer.concat([Buffer.from('PK'), Buffer.alloc(40)]),
        )
        writeFileSync(
          join(out, 'output-metadata.json'),
          JSON.stringify({
            elements: [{ outputFile: 'app-release.apk', versionCode: 13, versionName: '0.3.0' }],
          }),
        )
        return join(out, 'app-release.apk')
      })(),
    )
    expect(shape((await call('GET', '/api/app/update')).body)).toEqual(shape(fixtures.update))
  })
})
