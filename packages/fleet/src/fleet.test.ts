import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createConnection, createServer, type Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestExec } from './exec'
import { Fleet } from './fleet'
import { loadIdentity } from './identity'
import { LoginStore, labIdentity, loginMachine } from './logins'
import { pushLoginGrants } from './logins-delivery'
import { requestLoginWire } from './logins-wire'
import type { FleetSettings } from './settings'
import { lanAddress } from './settings'
import type { Pin } from './trust'
import * as trust from './trust'

const pushedLogins = vi.hoisted(() => vi.fn(async () => []))
vi.mock('./secrets', () => ({ pushToolLogins: pushedLogins }))

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
async function pair(reporting?: {
  postRows: NonNullable<import('./fleet').FleetOptions['postRows']>
  peerPower: NonNullable<import('./fleet').FleetOptions['peerPower']>
}) {
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
      env: { HOME: join(root, 'home-a'), AICO_FLEET_CONFIG: join(root, 'no-config') },
      identity: a,
      pins: () => pins,
      postRows: async () => {},
      log: () => {},
      ...reporting,
    })
  const makeB = () =>
    new Fleet({
      settings: sb,
      env: { HOME: join(root, 'home-b'), AICO_FLEET_CONFIG: join(root, 'no-config') },
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

it('pushes tool logins after a full peer authenticates a new link', async () => {
  pushedLogins.mockClear()
  const p = await pair()
  await p.fb.start()
  await p.fa.start()
  await vi.waitFor(() => expect(pushedLogins).toHaveBeenCalledWith(p.sa, p.b.name))
})

it('carries a complete signed-release-sized input and its final exec result', async () => {
  const p = await pair()
  await p.fb.start()
  await p.fa.start()
  await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(true))
  const result = await requestExec(
    join(p.sa.peerRoot, p.b.name, 'exec.sock'),
    [
      process.execPath,
      '-e',
      'let size=0;process.stdin.on("data",data=>size+=data.length);process.stdin.on("end",()=>console.log(size))',
    ],
    Buffer.alloc(2 * 1024 * 1024, 120),
  )
  expect(result.code).toBe(0)
  expect(result.stdout.trim()).toBe(String(2 * 1024 * 1024))
})

it('carries complete Logins responses over the real fleet link and binds worker writes to their assigned target', async () => {
  const p = await pair()
  p.setPins([
    { name: p.a.name, publicKey: p.a.publicKey, role: 'full' },
    { name: p.b.name, publicKey: p.b.publicKey, role: 'worker' },
  ])
  await p.fb.start()
  await p.fa.start()
  await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(true))
  const store = new LoginStore({ HOME: join(p.root, 'home-a') }),
    owner = { owner: true, role: 'owner', machine: loginMachine() }
  store.set('large', 'fixture-'.repeat(2000), { machines: [p.b.name] }, owner)
  const socket = join(p.sb.peerRoot, p.a.name, 'logins.sock')
  const call = async (operation: string, args: unknown[], role = 'implementation') =>
    JSON.parse(
      await requestLoginWire(
        socket,
        JSON.stringify({
          operation,
          args,
          caller: { owner: true, role, machine: 'spoofed-full', session: 'hunt-one' },
        }),
      ),
    )
  const value = await call('value', ['large'])
  expect(value.ok).toBe(true)
  expect(Buffer.from(value.value, 'base64').toString()).toBe('fixture-'.repeat(2000))
  expect((await call('list', [], 'hunting')).value).toEqual([])
  expect((await call('grant', ['large', 'role', 'hunting', true], 'hunting')).ok).toBe(false)
  const identity = labIdentity('example-local', 'viewer')
  store.assign('hunt-one', ['example-local'], owner)
  const metadata = {
    kind: 'lab login',
    lab: {
      target: 'example-local',
      actor: 'viewer',
      kind: 'synthetic',
      expires_at: null,
      fields: ['password'],
    },
  }
  const bundle = JSON.stringify({
    schema_version: 1,
    reference: identity.reference,
    kind: 'synthetic',
    expires_at: null,
    values: { password: 'fixture-new-password' },
  })
  const saved = await call('set', [identity.name, bundle, metadata, false], 'hunting')
  expect(saved.ok).toBe(true)
  expect(JSON.stringify(saved)).not.toContain('fixture-new-password')
  expect(store.list().some((entry) => entry.name === identity.name)).toBe(true)
})

it('forwards a full-peer merge to an already-connected downstream worker', async () => {
  const p = await pair(),
    c = loadIdentity(join(p.root, 'c'), 'peer-c'),
    cPort = await port()
  const pins: Pin[] = [
    { name: p.a.name, publicKey: p.a.publicKey, role: 'full' },
    { name: p.b.name, publicKey: p.b.publicKey, role: 'full' },
    { name: c.name, publicKey: c.publicKey, role: 'worker' },
  ]
  p.setPins(pins)
  const pinReader = vi.spyOn(trust, 'readPins').mockImplementation(() => pins)
  p.sb.peers.push({ name: c.name, endpoint: { address: '127.0.0.1', port: cPort } })
  const sc: FleetSettings = {
    ...p.sb,
    mode: 'worker',
    machine: c.name,
    stateDir: join(p.root, 'c'),
    peerRoot: join(p.root, 'peer-c'),
    listen: { address: '127.0.0.1', port: cPort },
    peers: [{ name: p.b.name, endpoint: p.sb.listen }],
  }
  const fc = new Fleet({
    settings: sc,
    env: { HOME: join(p.root, 'home-c'), AICO_FLEET_CONFIG: join(p.root, 'no-config') },
    identity: c,
    pins: () => pins,
    postRows: async () => {},
    log: () => {},
  })
  cleanup.push(
    () => pinReader.mockRestore(),
    () => fc.close(),
  )
  await fc.start()
  await p.fb.start()
  await p.fa.start()
  await vi.waitFor(() => expect(fc.status()[0]?.connected).toBe(true))
  await vi.waitFor(() => expect(p.fa.status()[0]?.connected).toBe(true))
  const env = { HOME: join(p.root, 'home-a') },
    store = new LoginStore(env),
    owner = { owner: true, role: 'owner', machine: loginMachine() }
  store.set('through-b', 'fixture-private-value', { machines: [c.name] }, owner)
  await pushLoginGrants(p.sa, p.b.name, env)
  expect(
    new LoginStore({ HOME: join(p.root, 'home-c') }).list().map((entry) => entry.name),
  ).toEqual(['through-b'])
  await pushLoginGrants(p.sa, p.b.name, env)
  expect(new LoginStore({ HOME: join(p.root, 'home-c') }).list()).toHaveLength(1)
})

it('reports actual stopped guests as off and restores warning when the power reading fails', async () => {
  let power: string | null = 'stopped'
  let latest: import('@aico/status').StatusRow[] = []
  const p = await pair({
    postRows: async (rows) => {
      latest = rows
    },
    peerPower: async () => {
      if (power === null) throw new Error('Proxmox unavailable')
      return new Map([['peer-b', power]])
    },
  })
  await p.fa.start()
  expect(latest[0]).toMatchObject({ state: 'off' })
  expect(latest[0]?.next_run).toBeDefined()
  power = 'running'
  await vi.waitFor(() => expect(latest[0]?.state).toBe('warn'))
  power = 'stopped'
  await vi.waitFor(() => expect(latest[0]?.state).toBe('off'))
  power = null
  await vi.waitFor(() => expect(latest[0]?.state).toBe('warn'))
  await p.fb.start()
  await vi.waitFor(() => expect(latest[0]?.state).toBe('ok'))
})
