import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as portServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Fleet } from '@aico/fleet/fleet'
import { loadIdentity } from '@aico/fleet/identity'
import type { FleetSettings } from '@aico/fleet/settings'
import { expect, it, vi } from 'vitest'
import { leaseCall, remoteAuthority, serveLeases } from './fleet-leases'
import type { JobDef } from './jobs'
import { JobStore, StaleLease } from './leases'
import { Runner } from './runner'

it('carries fenced claims, renewals and late result refusal over two real TLS peers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-job-'))
  const home = loadIdentity(join(root, 'home'), 'runner-home')
  const peer = loadIdentity(join(root, 'peer'), 'lease-holder')
  const pins = [home, peer].map(({ name, publicKey }) => ({
    name,
    publicKey,
    role: 'full' as const,
  }))
  const getPort = async () => {
    const server = portServer()
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    await new Promise<void>((r) => server.close(() => r()))
    return port
  }
  const homePort = await getPort()
  const peerPort = await getPort()
  const settings = (
    machine: string,
    port: number,
    other: string,
    otherPort: number,
  ): FleetSettings => ({
    machine,
    stateDir: join(root, machine),
    allowlist: '',
    listen: { address: '127.0.0.1', port },
    peers: [{ name: other, endpoint: { address: '127.0.0.1', port: otherPort } }],
    controlSocket: join(root, `${machine}.sock`),
    syncSocket: join(root, `${machine}-sync.sock`),
    jobsSocket: join(root, `${machine}-jobs.sock`),
    peerRoot: join(root, machine),
    retryMinMs: 10,
    retryMaxMs: 50,
    deadMs: 5000,
    statusMs: 100,
    statusUrl: 'http://127.0.0.1:1',
  })
  const hs = settings(home.name, homePort, peer.name, peerPort)
  const ps = settings(peer.name, peerPort, home.name, homePort)
  const hf = new Fleet({
    settings: hs,
    identity: home,
    pins: () => pins,
    postRows: async () => {},
    log: () => {},
  })
  const pf = new Fleet({
    settings: ps,
    identity: peer,
    pins: () => pins,
    postRows: async () => {},
    log: () => {},
  })
  const store = new JobStore(join(root, 'jobs.db'))
  const job: JobDef = {
    kind: 'takeover',
    what: 'Takeover proof',
    project: 'aico',
    home: home.name,
    lease_host: peer.name,
    workers: [home.name, peer.name],
    lease_s: 1,
    every_min: 1,
    run: { command: ['true'] },
  }
  store.ensure(job.kind, Date.now())
  const server = await serveLeases(ps.jobsSocket as string, store, [job], peer.name)
  try {
    await hf.start()
    await pf.start()
    await vi.waitFor(() => expect(hf.status()[0]?.connected).toBe(true))
    const remote = remoteAuthority(join(hs.peerRoot, peer.name, 'jobs.sock'))
    await expect(
      remote.claim(job.kind, { holder: 'forged', machine: peer.name }, 0, 0),
    ).rejects.toThrow('pinned machine')
    const old = await remote.claim(job.kind, { holder: 'home-runner', machine: home.name }, 0, 0)
    expect(old?.fence).toBe(1)
    if (!old) throw new Error('No home lease')
    expect(await remote.renew(old, 0, 0)).toBe(true)
    const backup = new Runner({
      store,
      jobs: [job],
      machine: peer.name,
      holder: 'peer-runner',
      act: async () => ({ state: 'ok', meaning: 'Peer finished after home stopped.' }),
      postRows: async () => {},
      log: () => {},
    })
    await backup.tick()
    await backup.idle()
    expect(store.get(job.kind)?.fence).toBe(1)
    await vi.waitFor(
      async () => {
        await backup.tick()
        await backup.idle()
        expect(store.get(job.kind)?.lastMachine).toBe(peer.name)
      },
      { timeout: 3000 },
    )
    await expect(
      remote.complete(old, { state: 'ok', meaning: 'Late home result' }, Date.now(), 0),
    ).rejects.toBeInstanceOf(StaleLease)
    await expect(remote.renew(old, 0, 0)).rejects.toBeInstanceOf(StaleLease)
    expect(store.get(job.kind)).toMatchObject({
      fence: 2,
      lastMachine: peer.name,
      lastMeaning: 'Peer finished after home stopped.',
    })
  } finally {
    await hf.close()
    await pf.close()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
    store.close()
    rmSync(root, { recursive: true })
  }
})

it('uses authority configuration and clock for claims, never caller TTL or schedule', () => {
  const store = new JobStore(':memory:')
  const job: JobDef = {
    kind: 'job',
    what: 'Job',
    project: 'aico',
    home: 'home',
    workers: ['home', 'peer'],
    lease_host: 'holder',
    every_min: 1,
    lease_s: 10,
    run: { command: ['true'] },
  }
  store.ensure('job', 1000)
  expect(() =>
    leaseCall(
      store,
      [job],
      'holder',
      { op: 'claim', kind: 'job', who: { holder: 'x', machine: 'unknown' } },
      'peer',
      1000,
    ),
  ).toThrow('pinned machine')
  expect(
    leaseCall(
      store,
      [job],
      'holder',
      { op: 'claim', kind: 'job', who: { holder: 'p', machine: 'peer' } },
      'peer',
      1000,
    ),
  ).toBeNull()
  const lease = leaseCall(
    store,
    [job],
    'holder',
    { op: 'claim', kind: 'job', who: { holder: 'h', machine: 'home' } },
    'home',
    1000,
  )
  expect(lease).toMatchObject({ fence: 1 })
  expect(store.get('job')?.leaseExpires).toBe(11000)
  store.close()
})
