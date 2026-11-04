import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Fleet } from './fleet'
import { loadIdentity } from './identity'
import type { FleetSettings } from './settings'
import { lanAddress } from './settings'
import type { Pin } from './trust'

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
})
async function port(): Promise<number> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const p = (server.address() as { port: number }).port
  await new Promise<void>((r) => server.close(() => r()))
  return p
}
async function pair() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-'))
  cleanup.push(() => rmSync(root, { recursive: true }))
  const a = loadIdentity(join(root, 'a'), 'peer-a')
  const b = loadIdentity(join(root, 'b'), 'peer-b')
  let pins: Pin[] = [
    { name: a.name, publicKey: a.publicKey },
    { name: b.name, publicKey: b.publicKey },
  ]
  const aPort = await port()
  const bPort = await port()
  const settings = (
    name: string,
    listenPort: number,
    other: string,
    peerPort: number,
  ): FleetSettings => ({
    machine: name,
    stateDir: join(root, name),
    allowlist: '',
    listen: { address: '127.0.0.1', port: listenPort },
    peers: [{ name: other, endpoint: { address: '127.0.0.1', port: peerPort } }],
    controlSocket: join(root, `${name}.sock`),
    syncSocket: join(root, `${name}-sync.sock`),
    peerRoot: join(root, name),
    retryMinMs: 20,
    retryMaxMs: 50,
    deadMs: 5000,
    statusMs: 25,
    statusUrl: 'http://127.0.0.1:1',
  })
  const sa = settings(a.name, aPort, b.name, bPort)
  const sb = settings(b.name, bPort, a.name, aPort)
  const makeA = () =>
    new Fleet({
      settings: sa,
      identity: a,
      pins: () => pins,
      postRows: async () => {},
      log: () => {},
    })
  const makeB = () =>
    new Fleet({
      settings: sb,
      identity: b,
      pins: () => pins,
      postRows: async () => {},
      log: () => {},
    })
  const fa = makeA()
  let fb = makeB()
  cleanup.push(
    () => fa.close(),
    () => fb.close(),
  )
  return {
    root,
    a,
    b,
    sa,
    sb,
    fa,
    get fb() {
      return fb
    },
    replaceB() {
      fb = makeB()
      return fb
    },
    setPins(next: Pin[]) {
      pins = next
    },
  }
}
function echo(path: string): Promise<Server> {
  const server = createServer((socket) => socket.pipe(socket))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return new Promise((resolve) => server.listen(path, () => resolve(server)))
}
function exchange(path: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.on('error', reject)
    socket.once('connect', () => socket.write(input))
    socket.once('data', (data) => {
      socket.destroy()
      resolve(data.toString())
    })
  })
}
describe('pinned TLS fleet peers', () => {
  it('authenticates once, multiplexes control and sync in both directions, and reconnects', async () => {
    const p = await pair()
    await echo(p.sb.controlSocket)
    await echo(p.sa.syncSocket)
    await p.fb.start()
    await p.fa.start()
    await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(true))
    expect(await exchange(join(p.sa.peerRoot, 'peer-b/control.sock'), 'control')).toBe('control')
    expect(await exchange(join(p.sb.peerRoot, 'peer-a/sync.sock'), 'sync')).toBe('sync')
    expect(statSync(join(p.root, 'a/fleet-key.pem')).mode & 0o777).toBe(0o600)
    await p.fb.close()
    await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(false))
    await p.replaceB().start()
    await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(true))
  })
  it('carries command stdin, literal argv, stdout, stderr and exit status', async () => {
    const p = await pair()
    await p.fb.start()
    await p.fa.start()
    await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(true))
    const packets = await new Promise<Buffer>((resolve, reject) => {
      const socket = createConnection(join(p.sa.peerRoot, 'peer-b/exec.sock'))
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.on('error', reject)
      socket.on('end', () => resolve(Buffer.concat(chunks)))
      socket.once('connect', () =>
        socket.end(
          `${JSON.stringify([process.execPath, '-e', "process.stdin.on('data', d => process.stdout.write(d)); process.stdin.on('end', () => { process.stderr.write(process.argv[1]); process.exitCode = 7 })", '$3'])}\ninput`,
        ),
      )
    })
    const output = new Map<number, string>()
    for (let at = 0; at < packets.length; ) {
      const size = packets.readUInt32BE(at + 1)
      const fd = packets[at] as number
      output.set(fd, (output.get(fd) ?? '') + packets.subarray(at + 5, at + 5 + size).toString())
      at += 5 + size
    }
    expect(output.get(1)).toBe('input')
    expect(output.get(2)).toBe('$3')
    expect(output.get(3)).toBe('7')
  })
  it('refuses an unknown key before any application channel opens', async () => {
    const p = await pair()
    p.setPins([{ name: p.a.name, publicKey: p.a.publicKey }])
    // Each machine approves itself; neither approves the other.
    const fb = new Fleet({
      settings: p.sb,
      identity: p.b,
      pins: () => [{ name: p.b.name, publicKey: p.b.publicKey }],
      postRows: async () => {},
      log: () => {},
    })
    cleanup.push(() => fb.close())
    await fb.start()
    await p.fa.start()
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    expect(p.fa.status()[0]?.connected).toBe(false)
    expect(fb.status()[0]?.connected).toBe(false)
  })
  it('disconnects and refuses a revoked key without restarting the daemon', async () => {
    const p = await pair()
    await p.fb.start()
    await p.fa.start()
    await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(true))
    p.setPins([{ name: p.a.name, publicKey: p.a.publicKey }])
    await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(false))
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    expect(p.fa.status()[0]?.connected).toBe(false)
  })
  it('refuses public, wildcard and DNS listener addresses', () => {
    for (const address of ['0.0.0.0', '::', '8.8.8.8', 'example.com'])
      expect(lanAddress(address)).toBe(false)
    expect(lanAddress('192.168.1.5')).toBe(true)
  })
})
