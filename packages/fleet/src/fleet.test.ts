import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection, createServer, type Server, Socket } from 'node:net'
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
    { name: a.name, publicKey: a.publicKey, role: 'full' },
    { name: b.name, publicKey: b.publicKey, role: 'full' },
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
    p.setPins([{ name: p.a.name, publicKey: p.a.publicKey, role: 'full' }])
    // Each machine approves itself; neither approves the other.
    const fb = new Fleet({
      settings: p.sb,
      identity: p.b,
      pins: () => [{ name: p.b.name, publicKey: p.b.publicKey, role: 'full' }],
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
    p.setPins([{ name: p.a.name, publicKey: p.a.publicKey, role: 'full' }])
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

async function authenticatedClient(
  p: Awaited<ReturnType<typeof pair>>,
  options: Record<string, unknown> = {},
) {
  const { connect } = await import('node:tls')
  const { Connection } = await import('./connection')
  const pins = [p.a, p.b].map(({ name, publicKey }) =>
    Object.assign({ name, publicKey }, { role: 'full' as const }),
  )
  return new Promise<InstanceType<typeof Connection>>((resolve, reject) => {
    const socket = connect({
      host: '127.0.0.1',
      port: p.sb.listen.port,
      key: p.a.key.export({ format: 'pem', type: 'pkcs8' }),
      cert: p.a.cert,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    })
    cleanup.push(() => {
      socket.destroy()
    })
    socket.on('error', reject)
    socket.once('secureConnect', () => {
      try {
        new Connection(
          socket,
          Object.assign(
            {
              identity: p.a,
              pins: () => pins,
              expected: p.b.name,
              deadMs: 5000,
              open: () => {},
              ready: resolve,
              closed: () => {},
              log: () => {},
            },
            options,
          ),
        )
      } catch (error) {
        reject(error)
      }
    })
  })
}

it.each(['control', 'exec'])('refuses a worker opening %s on a full peer', async (target) => {
  const p = await pair()
  p.setPins([
    Object.assign({ name: p.a.name, publicKey: p.a.publicKey }, { role: 'worker' as const }),
    Object.assign({ name: p.b.name, publicKey: p.b.publicKey }, { role: 'full' as const }),
  ])
  await echo(p.sb.controlSocket)
  await p.fb.start()
  await p.fa.start()
  await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(true))
  const refused = await new Promise<boolean>((resolve) => {
    const socket = createConnection(join(p.sa.peerRoot, `peer-b/${target}.sock`))
    let data = false
    socket.on('error', () => {})
    socket.on('data', () => {
      data = true
      socket.destroy()
    })
    socket.on('close', () => resolve(!data))
    socket.once('connect', () =>
      socket.end(
        target === 'exec'
          ? `${JSON.stringify([process.execPath, '-e', "console.log('must not run')"])}\n`
          : 'control',
      ),
    )
    socket.once('error', () => resolve(true))
  })
  expect(refused).toBe(true)
})

it('replaces a half-open authenticated connection with the fresh connection', async () => {
  const p = await pair()
  await p.fb.start()
  const first = await authenticatedClient(p)
  const next = await authenticatedClient(p)
  await vi.waitFor(() => expect(first.socket.destroyed).toBe(true))
  expect(next.socket.destroyed).toBe(false)
  expect(p.fb.status()[0]?.connected).toBe(true)
})

it('counts only received bytes for silence, even while sending data', async () => {
  const p = await pair()
  const tls = await import('node:tls')
  const { Connection } = await import('./connection')
  const { encodeFrame } = await import('./frames')
  const pins = [p.a, p.b].map(({ name, publicKey }) =>
    Object.assign({ name, publicKey }, { role: 'full' as const }),
  )
  let accepted: import('node:tls').TLSSocket | undefined
  let writes = 0
  const server = tls.createServer(
    {
      key: p.b.key.export({ format: 'pem', type: 'pkcs8' }),
      cert: p.b.cert,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    },
    (socket) => {
      accepted = socket
      new Connection(socket, {
        identity: p.b,
        pins: () => pins,
        deadMs: 80,
        open: () => {},
        ready: () => {},
        closed: () => {},
        log: () => {},
      })
      const timer = setInterval(() => {
        if (!socket.destroyed) {
          writes++
          socket.write(encodeFrame({ type: 'event', id: 'quiet-peer', op: 'data', data: 'eA==' }))
        }
      }, 5)
      socket.once('close', () => clearInterval(timer))
    },
  )
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const client = tls.connect({
    host: '127.0.0.1',
    port: (server.address() as { port: number }).port,
    key: p.a.key.export({ format: 'pem', type: 'pkcs8' }),
    cert: p.a.cert,
    rejectUnauthorized: false,
    minVersion: 'TLSv1.3',
  })
  client.on('data', () => {})
  client.on('error', () => {})
  cleanup.push(async () => {
    client.destroy()
    accepted?.destroy()
    await new Promise<void>((r) => server.close(() => r()))
  })
  await vi.waitFor(() => expect(accepted?.destroyed).toBe(true), { timeout: 500 })
  expect(writes).toBeGreaterThan(1)
})

it('caps incoming channels without dropping the peer connection', async () => {
  const p = await pair()
  Object.assign(p.sb, { maxChannels: 2 })
  await echo(p.sb.controlSocket)
  await p.fb.start()
  const client = await authenticatedClient(p)
  const a = client.open({ type: 'control', target: 'control' })
  const b = client.open({ type: 'control', target: 'control' })
  const excess = client.open({ type: 'control', target: 'control' })
  await vi.waitFor(() => expect(excess.destroyed).toBe(true))
  expect(client.socket.destroyed).toBe(false)
  a.destroy()
  b.destroy()
})

it('pauses TLS for a full channel buffer and resumes without losing bytes', async () => {
  const p = await pair()
  await echo(p.sb.controlSocket)
  await p.fb.start()
  const client = await authenticatedClient(p, { bufferBytes: 128 })
  const pause = vi.spyOn(client.socket, 'pause')
  const stream = client.open({ type: 'control', target: 'control' })
  const payload = Buffer.alloc(512 * 1024, 0x61)
  stream.end(payload)
  await vi.waitFor(() => expect(pause).toHaveBeenCalled())
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  expect(Buffer.concat(chunks)).toEqual(payload)
})

it('flushes a final response before closing the local proxy socket', async () => {
  const p = await pair()
  const response = Buffer.from('m11a-buffered-response')
  const server = createServer((socket) => socket.once('data', () => socket.end(response)))
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  await new Promise<void>((resolve) => server.listen(p.sb.controlSocket, resolve))
  await p.fb.start()
  await p.fa.start()
  await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(true))
  const path = join(p.sa.peerRoot, 'peer-b/control.sock')
  const original = Socket.prototype._write
  const write = vi.spyOn(Socket.prototype, '_write').mockImplementation(function (
    this: Socket,
    chunk,
    encoding,
    callback,
  ) {
    const local = this as Socket & { server?: Server }
    if (local.server?.address() === path && Buffer.from(chunk).equals(response)) {
      // Keep one real net write pending, as a busy local reader does.
      setTimeout(() => original.call(this, chunk, encoding, callback), 20)
    } else original.call(this, chunk, encoding, callback)
  })
  try {
    const received = await new Promise<Buffer>((resolve, reject) => {
      const client = createConnection(path)
      const chunks: Buffer[] = []
      client.on('data', (chunk) => chunks.push(chunk))
      client.on('error', reject)
      client.once('end', () => resolve(Buffer.concat(chunks)))
      client.once('connect', () => client.end('request'))
    })
    expect(received).toEqual(response)
  } finally {
    write.mockRestore()
  }
})

it('releases its upstream socket after the peer closes a channel', async () => {
  const p = await pair()
  let upstream: Socket | undefined
  let forwarded: Socket | undefined
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    upstream = socket
    socket.on('error', () => {})
    socket.once('data', () => socket.write('opened'))
  })
  cleanup.push(async () => {
    upstream?.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve) => server.listen(p.sb.controlSocket, resolve))
  await p.fb.start()
  const client = await authenticatedClient(p)
  const original = Socket.prototype._write
  const write = vi.spyOn(Socket.prototype, '_write').mockImplementation(function (
    this: Socket,
    chunk,
    encoding,
    callback,
  ) {
    // The last plain request write is the fleet's connection to our service.
    if (
      Buffer.from(chunk).toString() === 'request' &&
      !(this as Socket & { server?: Server }).server
    )
      forwarded = this
    original.call(this, chunk, encoding, callback)
  })
  try {
    const stream = client.open({ type: 'control', target: 'control' })
    const opened = new Promise<void>((resolve) => stream.once('data', () => resolve()))
    stream.write('request')
    await opened
    stream.destroy()
    expect(forwarded).toBeDefined()
    await vi.waitFor(() => expect(forwarded?.destroyed).toBe(true))
  } finally {
    write.mockRestore()
  }
})
