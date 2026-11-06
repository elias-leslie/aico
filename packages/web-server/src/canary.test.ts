import { parseNotice } from '@aico/notify'
import { expect, it } from 'vitest'
import { CanaryEvents, CanaryLimiter, describeCanary } from './canary'

it('uses the private registry placement without exposing token management data', () => {
  const result = describeCanary({ token: 'fixture', src_ip: '192.0.2.10' }, [
    { token: 'fixture', name: 'Decoy', path: 'fixture placement', type: 'dns' },
  ])
  expect(result).toEqual({
    title: 'Canary tripped: Decoy',
    body: 'dns at fixture placement. Source 192.0.2.10.',
    name: 'Decoy',
    src: '192.0.2.10',
    anySource: true,
  })
  expect(() => describeCanary({ token: 'unknown' }, [])).toThrow('not registered')
})
it('handles honeypot messages and ignores startup events', () => {
  expect(describeCanary({ message: { logtype: 1001 } }, [])).toBeNull()
  expect(
    describeCanary(
      {
        message: JSON.stringify({
          logtype: 4002,
          node_id: 'lab',
          src_host: '192.0.2.20',
          dst_port: 22,
        }),
      },
      [],
    )?.title,
  ).toBe('Honeypot tripped: lab')
})

it('the on-demand drill emits a valid test notice without asking the phone to buzz for info', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { serveRoutes } = await import('./testing')
  const { registerCanaryRoutes } = await import('./canary')
  const folder = mkdtempSync(join(tmpdir(), 'canary-drill-'))
  writeFileSync(join(folder, 'registry.json'), JSON.stringify({ tokens: [] }))
  const notices: unknown[] = []
  const server = await serveRoutes((router) =>
    registerCanaryRoutes(
      router,
      {
        receive: (notice) => {
          parseNotice(notice)
          notices.push(notice)
          return {} as never
        },
      },
      folder,
    ),
  )
  try {
    const response = await fetch(`${server.base}/api/canary/drill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    expect(notices).toEqual([
      expect.objectContaining({ title: 'TEST: canary hook drill', severity: 'info', push: 'tray' }),
    ])
  } finally {
    await server.close()
    rmSync(folder, { recursive: true, force: true })
  }
})

it('limits each caller to 20 events a minute and all callers to 120', () => {
  let now = 0
  const limiter = new CanaryLimiter(() => now)
  for (let i = 0; i < 20; i++) expect(limiter.take('a')).toBe(true)
  expect(limiter.take('a')).toBe(false)
  for (let c = 0; c < 5; c++) for (let i = 0; i < 20; i++) limiter.take(`b${c}`)
  expect(limiter.take('c')).toBe(false)
  now = 61_000
  expect(limiter.take('a')).toBe(true)
})

it('keeps every trip but sends a repeat from the same source only after 3 min', async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const folder = mkdtempSync(join(tmpdir(), 'canary-events-'))
  let now = 1_000_000
  const events = new CanaryEvents(folder, () => now)
  const trip = { title: 't', body: 'b', name: 'Decoy', src: '192.0.2.1' }
  try {
    expect(events.record(trip, 'canary').repeat).toBe(false)
    expect(events.record(trip, 'canary').repeat).toBe(true)
    expect(events.record({ ...trip, src: '192.0.2.2' }, 'canary').repeat).toBe(false)
    expect(events.record({ ...trip, src: '192.0.2.3', anySource: true }, 'canary').repeat).toBe(
      false,
    )
    expect(events.record({ ...trip, src: '192.0.2.4', anySource: true }, 'canary').repeat).toBe(
      true,
    )
    now += 181_000
    expect(events.record(trip, 'canary').repeat).toBe(false)
    const lines = readFileSync(join(folder, 'events.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(6)
    expect(JSON.parse(lines[1] as string)).toMatchObject({ canary: 'Decoy', repeat: true })
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})

it('a burst of trips on one decoy is one notice key with a cooldown', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { serveRoutes } = await import('./testing')
  const { registerCanaryRoutes } = await import('./canary')
  const folder = mkdtempSync(join(tmpdir(), 'canary-hook-'))
  const secret = 'x'.repeat(40)
  writeFileSync(join(folder, 'hook-secret'), secret)
  writeFileSync(
    join(folder, 'registry.json'),
    JSON.stringify({ tokens: [{ token: 'fixture', name: 'Decoy', path: 'p', type: 'web' }] }),
  )
  const notices: { key?: string; cooldown?: number }[] = []
  const server = await serveRoutes((router) =>
    registerCanaryRoutes(
      router,
      {
        receive: (notice) => {
          parseNotice(notice)
          notices.push(notice as never)
          return {} as never
        },
      },
      folder,
    ),
  )
  const post = (src: string) =>
    fetch(`${server.base}/hooks/canary/${secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'fixture', src_ip: src }),
    })
  try {
    for (const src of ['192.0.2.1', '192.0.2.1', '192.0.2.2'])
      expect((await post(src)).status).toBe(200)
    expect(notices).toHaveLength(2)
    expect(notices[0]?.key).toBe(notices[1]?.key)
    expect(notices[0]?.key).toMatch(/^canary:[0-9a-f]{10}$/)
    expect(notices[0]?.cooldown).toBe(600)
    let status = 200
    for (let i = 0; i < 20 && status === 200; i++) status = (await post(`192.0.2.${10 + i}`)).status
    expect(status).toBe(429)
  } finally {
    await server.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
