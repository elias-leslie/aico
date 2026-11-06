import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AccessConfig, AccessVerifier, viaCloudflare } from './access'
import { Router } from './http'
import { createWebServer } from './server'
import { TerminalHub } from './terminal'
import { FakeTether } from './testing'

const TEAM = 'team.cloudflareaccess.com'
const AUD = 'a'.repeat(64)
const PHONE_AUD = 'b'.repeat(64)
const config: AccessConfig = {
  teamDomain: TEAM,
  audiences: { 'app.example': AUD, 'phone.example': PHONE_AUD },
}
const NOW = 1_800_000_000_000

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...pair.publicKey.export({ format: 'jwk' }), kid: 'k1' }

function token(claims: Record<string, unknown> = {}, key: KeyObject = pair.privateKey, kid = 'k1') {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc({
    aud: [AUD],
    iss: `https://${TEAM}`,
    type: 'app',
    exp: NOW / 1000 + 600,
    nbf: NOW / 1000 - 10,
    ...claims,
  })}`
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), key).toString('base64url')}`
}

const edge = (jwt?: string, host = 'app.example') => ({
  host,
  'cf-ray': '8f0000000000-IAD',
  'cf-connecting-ip': '203.0.113.9',
  ...(jwt === undefined ? {} : { 'cf-access-jwt-assertion': jwt }),
})

function verifier(fetched: { count: number } = { count: 0 }, cfg: AccessConfig | null = config) {
  return new AccessVerifier(
    cfg,
    async (team) => {
      fetched.count += 1
      expect(team).toBe(TEAM)
      return [jwk]
    },
    () => NOW,
  )
}

describe('Access at the origin', () => {
  it('tells tunnel requests by the headers only the Cloudflare edge sets', () => {
    expect(viaCloudflare({ host: 'app.example' })).toBe(false)
    expect(viaCloudflare({ 'cf-ray': 'x' })).toBe(true)
    expect(viaCloudflare({ 'cf-connecting-ip': '203.0.113.9' })).toBe(true)
  })

  it('leaves requests from this machine alone', async () => {
    const access = verifier()
    expect(await access.check({ host: '127.0.0.1:3002' })).toBeNull()
    expect(await access.check({ host: 'app.example', 'x-forwarded-for': '127.0.0.1' })).toBeNull()
  })

  it("accepts a valid token for the requested host's Access app", async () => {
    const fetched = { count: 0 }
    const access = verifier(fetched)
    expect(await access.check(edge(token()))).toBeNull()
    expect(await access.check(edge(token({ aud: PHONE_AUD }), 'phone.example:443'))).toBeNull()
    expect(fetched.count).toBe(1)
  })

  it('refuses a tunnel request without a valid token', async () => {
    const access = verifier()
    const refused = [
      edge(),
      edge(''),
      edge('not.a.token'),
      edge(token({}, other.privateKey)),
      edge(token({}, pair.privateKey, 'unknown')),
      edge(token({ aud: [PHONE_AUD] })),
      edge(token(), 'phone.example'),
      edge(token(), 'unlisted.example'),
      edge(token({ iss: 'https://evil.cloudflareaccess.com' })),
      edge(token({ type: 'meta' })),
      edge(token({ exp: NOW / 1000 - 120 })),
      edge(token({ exp: undefined })),
      edge(token({ nbf: NOW / 1000 + 600 })),
      edge(`${token().split('.').slice(0, 2).join('.')}.`),
    ]
    for (const headers of refused) expect(await access.check(headers)).toBe('access_required')
  })

  it('refuses every tunnel request when no Access app is configured', async () => {
    expect(await verifier(undefined, null).check(edge(token()))).toBe('access_required')
  })

  it('refetches the team keys for an unknown key at most once a minute', async () => {
    const fetched = { count: 0 }
    const access = verifier(fetched)
    await access.check(edge(token({}, pair.privateKey, 'new')))
    await access.check(edge(token({}, pair.privateKey, 'new')))
    expect(fetched.count).toBe(1)
  })
})

describe('the web server', () => {
  let server: Server
  let port: number

  beforeEach(async () => {
    const router = new Router().on('GET', '/api/ping', () => ({ ok: true }))
    const tether = new FakeTether()
    server = createWebServer(
      {
        allowedHostnames: ['127.0.0.1', 'app.example'],
        allowedOrigins: [],
        access: config,
      },
      router,
      new TerminalHub({ tether: tether.client, historyLines: 10, touched: () => {} }),
      undefined,
      verifier(),
    )
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  const get = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      request({ port, host: '127.0.0.1', path: '/api/ping', headers }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
        .on('error', reject)
        .end()
    })

  it('serves local requests and tunnel requests with a valid token, refuses the rest', async () => {
    expect(await get({ host: '127.0.0.1' })).toBe(200)
    expect(await get({ host: 'app.example' })).toBe(200)
    expect(await get(edge(token()))).toBe(200)
    expect(await get(edge())).toBe(403)
    expect(await get(edge(token({}, other.privateKey)))).toBe(403)
  })

  it('refuses a tunnel WebSocket without a token', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      request({
        port,
        host: '127.0.0.1',
        path: '/api/terminal/x',
        headers: { ...edge(), connection: 'Upgrade', upgrade: 'websocket' },
      })
        .on('response', (res) => resolve(res.statusCode ?? 0))
        .on('upgrade', () => resolve(101))
        .on('error', reject)
        .end()
    })
    expect(status).toBe(403)
  })
})
