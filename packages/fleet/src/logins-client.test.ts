import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LoginStore, loginMachine } from './logins'
import { LoginClient, loginRpc } from './logins-client'
import { writePrivate } from './secret-files'
import { fleetFile } from './settings'

const mocks = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('./logins-wire', () => ({ requestLoginWire: mocks.exec }))
vi.mock('./trust', () => ({
  readPins: (path: string) => [
    { name: loginMachine(), role: path === '/full-pins' ? 'full' : 'worker' },
    { name: 'full-peer', role: 'full' },
  ],
}))
const dirs: string[] = []
const owner = { owner: true, role: 'owner', machine: loginMachine() }
function environment(worker = true) {
  const home = mkdtempSync(join(tmpdir(), 'aico-login-peer-'))
  dirs.push(home)
  const env = { HOME: home }
  if (worker)
    writePrivate(
      fleetFile(env),
      JSON.stringify({
        machine: loginMachine(),
        stateDir: '/state',
        allowlist: '/pins',
        mode: 'worker',
        listen: { address: '127.0.0.1', port: 11001 },
        peers: [{ name: 'full-peer', endpoint: { address: '127.0.0.1', port: 11002 } }],
        controlSocket: '/control',
        syncSocket: '/sync',
        peerRoot: `/run/user/${process.getuid?.()}/aico/fleet`,
        retryMinMs: 10,
        retryMaxMs: 20,
        deadMs: 50,
        statusMs: 50,
        statusUrl: 'http://127.0.0.1/status',
      }),
    )
  return env
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})
it('uses granted read copies when disconnected and refuses every local write', async () => {
  mocks.exec.mockRejectedValue(new Error('fixture-disconnected'))
  const env = environment(),
    client = new LoginClient(env)
  client.local.set('saved', 'fixture-private-value', {}, owner)
  expect((await client.list(owner)).map((e) => e.name)).toEqual(['saved'])
  expect(client.offline).toBe(true)
  expect((await client.value('saved', owner)).toString()).toBe('fixture-private-value')
  await expect(client.set('new', 'fixture-private-value', {}, owner)).rejects.toThrow('read-only')
  await expect(
    client.assign('hunt-one', ['example-local'], { ...owner, owner: false, role: 'coordinator' }),
  ).rejects.toThrow('read-only')
  expect(client.local.list().map((e) => e.name)).toEqual(['saved'])
})
it('sends worker writes to a full peer only through encrypted protocol data and keeps role checks there', async () => {
  const env = environment(),
    fullEnv = environment(false)
  mocks.exec.mockImplementation(async (_socket: string, input: string) => loginRpc(input, fullEnv))
  const client = new LoginClient(env)
  await client.set('saved', 'fixture-private-value', {}, owner)
  expect(client.local.list()).toEqual([])
  expect(new LoginStore(fullEnv).show('saved', owner).name).toBe('saved')
  const [socket, input] = mocks.exec.mock.calls[0] as [string, string]
  expect(socket).not.toContain('fixture-private-value')
  expect(JSON.parse(input).caller).toEqual(owner)
  await expect(
    client.value('saved', { role: 'hunting', session: 'hunt-one', machine: loginMachine() }),
  ).rejects.toThrow('unavailable')
})
it('replicates a reveal record and last-used metadata to other full peers', async () => {
  const env = environment()
  const config = JSON.parse((await import('node:fs')).readFileSync(fleetFile(env), 'utf8'))
  config.allowlist = '/full-pins'
  writePrivate(fleetFile(env), JSON.stringify(config))
  new LoginStore(env).set('saved', 'fixture-private-value', {}, owner)
  mocks.exec.mockResolvedValue(JSON.stringify({ ok: true }))
  const client = new LoginClient(env)
  expect((await client.value('saved', owner, 'reveal')).toString()).toBe('fixture-private-value')
  expect(mocks.exec).toHaveBeenCalled()
  const snapshot = JSON.parse(mocks.exec.mock.calls[0][1]).snapshot
  expect(snapshot.audit.some((event: { action: string }) => event.action === 'reveal')).toBe(true)
  expect(snapshot.entries[0].entry.lastUsed).not.toBeNull()
})
it('does not push snapshots for machine reads', async () => {
  const env = environment()
  const config = JSON.parse((await import('node:fs')).readFileSync(fleetFile(env), 'utf8'))
  config.allowlist = '/full-pins'
  writePrivate(fleetFile(env), JSON.stringify(config))
  new LoginStore(env).set('saved', 'fixture-private-value', {}, owner)
  mocks.exec.mockResolvedValue(JSON.stringify({ ok: true }))
  const client = new LoginClient(env)
  for (let i = 0; i < 5; i++) await client.value('saved', owner, 'VM operation')
  await client.value('saved', owner)
  expect(mocks.exec).not.toHaveBeenCalled()
})
