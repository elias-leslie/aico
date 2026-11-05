import { expect, it } from 'vitest'
import { describeCanary } from './canary'

it('uses the private registry placement without exposing token management data', () => {
  const result = describeCanary({ token: 'fixture', src_ip: '192.0.2.10' }, [
    { token: 'fixture', name: 'Decoy', path: 'fixture placement', type: 'dns' },
  ])
  expect(result).toEqual({
    title: 'Canary tripped: Decoy',
    body: 'dns at fixture placement. Source 192.0.2.10.',
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
