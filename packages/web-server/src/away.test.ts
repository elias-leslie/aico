import { createServer, type Server } from 'node:http'
import { StatusStore } from '@aico/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AwayStart, type AwayStatus, refusalOf, registerAwayRoutes } from './away'
import { Router } from './http'

const T0 = Date.parse('2026-11-07T12:00:00Z')

let server: Server
let base: string
let status: StatusStore
let start: AwayStart
let ready: AwayStatus

beforeEach(async () => {
  status = new StatusStore(':memory:', () => T0)
  start = async () => null
  ready = { enabled: true }
  const router = new Router()
  registerAwayRoutes(router, {
    status,
    guestMachines: async () => ['ominull-hub', 'apps'],
    start: () => start(),
    setup: async () => ready,
    now: () => T0,
  })
  server = createServer((req, res) => {
    void router.handle(req, res, new URL(req.url || '/', 'http://localhost'))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No address')
  base = `http://127.0.0.1:${address.port}`
})
afterEach(() => server.close())

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

describe('POST /api/machines/outage', () => {
  it('marks the machines planned off, dated after the settle time, with the guests when asked', async () => {
    const answer = await post('/api/machines/outage', {
      machines: ['davion-gem', 'aico'],
      guests: true,
      settleSeconds: 120,
    })
    expect(answer.status).toBe(200)
    expect([...status.plannedOutages()]).toEqual([
      ['davion-gem', T0 + 120_000],
      ['aico', T0 + 120_000],
      ['ominull-hub', T0 + 120_000],
      ['apps', T0 + 120_000],
    ])
  })

  it('takes the mark back with clear, guests too', async () => {
    await post('/api/machines/outage', { machines: ['davion-gem'], guests: true })
    expect(status.plannedOutages().size).toBe(3)
    const answer = await post('/api/machines/outage', {
      machines: ['davion-gem'],
      guests: true,
      clear: true,
    })
    expect(answer.status).toBe(200)
    expect(status.plannedOutages().size).toBe(0)
  })

  it('refuses a request that is not from a program on this machine, and bad input', async () => {
    const foreign = await post(
      '/api/machines/outage',
      { machines: ['davion-gem'] },
      { origin: 'https://aico.example' },
    )
    expect(foreign.status).toBe(403)
    expect((await post('/api/machines/outage', {})).status).toBe(422)
    expect((await post('/api/machines/outage', { machines: ['a b'] })).status).toBe(422)
    expect(
      (await post('/api/machines/outage', { machines: ['x'], settleSeconds: -1 })).status,
    ).toBe(422)
    expect(status.plannedOutages().size).toBe(0)
  })
})

describe('GET and POST /api/machines/away when remote power is not set up', () => {
  const reason = 'Remote power isn’t set up yet.'
  it('says so, and the button refuses without starting anything', async () => {
    ready = { enabled: false, reason }
    let started = false
    start = async () => {
      started = true
      return null
    }
    expect(await (await fetch(`${base}/api/machines/away`)).json()).toEqual(ready)
    const answer = await post('/api/machines/away', {})
    expect(answer.status).toBe(409)
    expect(((await answer.json()) as { detail: string }).detail).toBe(reason)
    expect(started).toBe(false)
  })
})

describe('POST /api/machines/away', () => {
  it('says started when the shutdown is still going after the wait', async () => {
    const answer = await post('/api/machines/away', {})
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ started: true })
  })

  it('gives an early refusal as the answer, in plain words', async () => {
    start = async () => ({
      code: 1,
      output: "Away: davion-gem\naico away: The power plug at 192.168.87.217 didn't answer\n",
    })
    const answer = await post('/api/machines/away', {})
    expect(answer.status).toBe(502)
    expect(((await answer.json()) as { detail: string }).detail).toBe(
      "The power plug at 192.168.87.217 didn't answer",
    )
  })

  it('refuses a second start while the first is running', async () => {
    let release: (value: null) => void = () => {}
    start = () => new Promise((resolve) => (release = resolve))
    const first = post('/api/machines/away', {})
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((await post('/api/machines/away', {})).status).toBe(409)
    release(null)
    expect((await first).status).toBe(200)
  })
})

it('takes the last line of the output as the reason', () => {
  expect(refusalOf('Away: x\naico away: nope\n')).toBe('nope')
  expect(refusalOf('')).toBe('The shutdown did not start.')
})

describe('POST /api/machines/:machine/shut-down', () => {
  it('starts without the away setting, and gives a refusal that comes at once', async () => {
    const asked: string[] = []
    let answer: { code: number; output: string } | null = null
    const router = new Router()
    registerAwayRoutes(router, {
      status,
      guestMachines: async () => [],
      setup: async () => ({ enabled: false, reason: 'no' }),
      shutDown: async (machine) => {
        asked.push(machine)
        return answer
      },
    })
    const own = createServer((req, res) => {
      void router.handle(req, res, new URL(req.url ?? '/', 'http://x'))
    })
    await new Promise<void>((done) => own.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${(own.address() as { port: number }).port}/api/machines/davion-sidarli/shut-down`
    expect((await fetch(url, { method: 'POST' })).status).toBe(200)
    expect(asked).toEqual(['davion-sidarli'])
    answer = { code: 1, output: 'aico power: davion-sidarli is already off.' }
    const refused = await fetch(url, { method: 'POST' })
    expect(refused.status).toBe(502)
    expect(await refused.text()).toContain('davion-sidarli is already off.')
    await new Promise((done) => own.close(done))
  })
})
