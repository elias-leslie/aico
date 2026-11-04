import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import {
  createConnection,
  createServer as createUnixServer,
  type Socket,
  type Server as UnixServer,
} from 'node:net'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { connect, createServer, type Server, type TLSSocket } from 'node:tls'
import type { StatusRow } from '@aico/status'
import { Connection, type OpenChannel } from './connection'
import { serveExec } from './exec'
import { type Identity, loadIdentity, validName } from './identity'
import { type FleetSettings, localAddress } from './settings'
import { type Pin, readPins } from './trust'

export interface FleetOptions {
  settings: FleetSettings
  identity?: Identity
  pins?: () => Pin[]
  postRows?: (rows: StatusRow[]) => Promise<void>
  log?: (message: string) => void
}

/** One connection per unordered machine pair; the lower name is the dialer.
 * Both ends may open channels. Local sockets preserve callers' HTTP/stream APIs. */
export class Fleet {
  private readonly connections = new Map<string, Connection>()
  private readonly connecting = new Set<TLSSocket>()
  private readonly retry = new Map<string, NodeJS.Timeout>()
  private readonly attempts = new Map<string, number>()
  private readonly seen = new Map<string, number>()
  private readonly unix: UnixServer[] = []
  private readonly identity: Identity
  private readonly pins: () => Pin[]
  private readonly log: (message: string) => void
  private readonly postRows: (rows: StatusRow[]) => Promise<void>
  private server: Server | null = null
  private timer: NodeJS.Timeout | null = null
  private stopping = false

  constructor(private readonly options: FleetOptions) {
    const s = options.settings
    this.identity = options.identity ?? loadIdentity(s.stateDir, s.machine)
    this.pins = options.pins ?? (() => readPins(s.allowlist))
    this.log = options.log ?? ((message) => console.log(`[fleet] ${message}`))
    this.postRows =
      options.postRows ??
      (async (rows) => {
        const res = await fetch(s.statusUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(rows),
          signal: AbortSignal.timeout(s.deadMs),
        })
        if (!res.ok) throw new Error(`Status answered ${res.status}`)
      })
  }

  async start(): Promise<void> {
    const s = this.options.settings
    if (!localAddress(s.listen.address))
      throw new Error('Fleet listener must bind a local LAN address')
    const pins = this.pins()
    if (!pins.some((pin) => pin.name === s.machine && pin.publicKey === this.identity.publicKey))
      throw new Error('This machine key is not approved')
    for (const peer of s.peers) {
      if (!validName(peer.name) || peer.name === s.machine)
        throw new Error('Invalid fleet peer name')
      const dir = join(s.peerRoot, peer.name)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (const target of ['control', 'sync', 'exec'] as const) {
        const path = join(dir, `${target}.sock`)
        await this.listenUnix(path, (socket) => this.forward(peer.name, target, socket))
      }
    }
    const tls = {
      key: this.identity.key.export({ format: 'pem', type: 'pkcs8' }),
      cert: this.identity.cert,
      minVersion: 'TLSv1.3' as const,
      maxVersion: 'TLSv1.3' as const,
      rejectUnauthorized: false,
    }
    this.server = createServer({ ...tls, requestCert: true }, (socket) => this.accept(socket))
    this.server.on('tlsClientError', (error) => this.log(`TLS refused: ${error.message}`))
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(s.listen.port, s.listen.address, () => {
        this.server?.off('error', reject)
        resolve()
      })
    })
    this.server.on('error', (error) => this.log(`Listener failed: ${error.message}`))
    for (const peer of s.peers) if (s.machine < peer.name) this.dial(peer.name)
    this.timer = setInterval(() => {
      for (const connection of this.connections.values()) connection.recheck()
      void this.report()
    }, s.statusMs)
    this.timer.unref()
    await this.report()
  }

  private accept(socket: TLSSocket, expected?: string): void {
    try {
      new Connection(socket, {
        identity: this.identity,
        pins: this.pins,
        ...(expected ? { expected } : {}),
        deadMs: this.options.settings.deadMs,
        log: this.log,
        open: (stream, request, peer) => this.openLocal(stream, request, peer),
        ready: (connection) => {
          if (!this.options.settings.peers.some((peer) => peer.name === connection.peer)) {
            socket.destroy(new Error('Peer has no configured endpoint'))
            return
          }
          const current = this.connections.get(connection.peer)
          if (current && current !== connection) {
            socket.destroy(new Error('Duplicate fleet connection'))
            return
          }
          this.connections.set(connection.peer, connection)
          this.attempts.delete(connection.peer)
          this.log(`${connection.peer}: connected`)
          void this.report()
        },
        closed: (connection) => {
          if (this.connections.get(connection.peer) === connection) {
            this.seen.set(connection.peer, connection.lastSeen)
            this.connections.delete(connection.peer)
            this.log(`${connection.peer}: disconnected`)
          }
          if (expected) this.schedule(expected)
          void this.report()
        },
      })
    } catch (error) {
      this.log(`Peer refused: ${(error as Error).message}`)
      socket.destroy()
      if (expected) this.schedule(expected)
    }
  }

  private dial(name: string): void {
    if (this.stopping || this.connections.has(name)) return
    const s = this.options.settings
    const peer = s.peers.find((entry) => entry.name === name)
    if (!peer) return
    const socket = connect({
      host: peer.endpoint.address,
      port: peer.endpoint.port,
      key: this.identity.key.export({ format: 'pem', type: 'pkcs8' }),
      cert: this.identity.cert,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      rejectUnauthorized: false,
    })
    this.connecting.add(socket)
    socket.setTimeout(s.deadMs, () => socket.destroy(new Error('Fleet connection is silent')))
    socket.once('secureConnect', () => this.accept(socket, name))
    socket.on('error', () => {})
    socket.once('close', () => {
      this.connecting.delete(socket)
      this.schedule(name)
    })
  }

  private schedule(name: string): void {
    if (this.stopping || this.retry.has(name) || this.connections.has(name)) return
    const s = this.options.settings
    const attempt = this.attempts.get(name) ?? 0
    this.attempts.set(name, attempt + 1)
    const ceiling = Math.min(s.retryMaxMs, s.retryMinMs * 2 ** Math.min(attempt, 30))
    const timer = setTimeout(
      () => {
        this.retry.delete(name)
        this.dial(name)
      },
      ceiling * (0.5 + Math.random() / 2),
    )
    timer.unref()
    this.retry.set(name, timer)
  }

  private async listenUnix(path: string, connection: (socket: Socket) => void): Promise<void> {
    if (existsSync(path)) {
      if (!lstatSync(path).isSocket()) throw new Error(`Refusing to replace non-socket ${path}`)
      const live = await new Promise<boolean>((resolve) => {
        const socket = createConnection(path)
        socket.once('connect', () => {
          socket.destroy()
          resolve(true)
        })
        socket.once('error', () => resolve(false))
      })
      if (live) throw new Error(`Another link holds ${path}`)
      unlinkSync(path)
    }
    const server = createUnixServer({ allowHalfOpen: true }, connection)
    this.unix.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        chmodSync(path, 0o600)
        resolve()
      })
    })
    server.on('error', (error) => this.log(`Local fleet socket failed: ${error.message}`))
  }

  private forward(name: string, target: string, socket: Socket): void {
    socket.on('error', () => {})
    const connect = (argv?: string[]) => {
      try {
        const connection = this.connections.get(name)
        if (!connection) throw new Error('Fleet peer is disconnected')
        const channel = connection.open({
          type: target === 'sync' ? 'sync' : argv ? 'terminal-view' : 'control',
          target,
          ...(argv ? { argv } : {}),
        })
        socket.pipe(channel).pipe(socket)
        socket.once('close', () => channel.destroy())
        channel.once('error', () => socket.destroy())
      } catch {
        socket.destroy()
      }
    }
    if (target !== 'exec') {
      connect()
      return
    }
    let pending: Buffer = Buffer.alloc(0)
    const hello = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk])
      if (pending.length > 65536) {
        socket.destroy()
        return
      }
      const end = pending.indexOf(10)
      if (end < 0) return
      socket.pause()
      socket.off('data', hello)
      try {
        const argv: unknown = JSON.parse(pending.subarray(0, end).toString())
        if (
          !Array.isArray(argv) ||
          !argv.length ||
          argv.some((word) => typeof word !== 'string' || word.includes('\0'))
        )
          throw new Error('Invalid argv')
        if (pending.length > end + 1) socket.unshift(pending.subarray(end + 1))
        connect(argv as string[])
        socket.resume()
      } catch {
        socket.destroy()
      }
    }
    socket.on('data', hello)
  }

  private openLocal(channel: Duplex, request: OpenChannel, _peer: string): void {
    const s = this.options.settings
    if (request.target === 'exec' && request.argv) {
      serveExec(channel, request.argv)
      return
    }
    const path =
      request.target === 'control'
        ? s.controlSocket
        : request.target === 'sync'
          ? s.syncSocket
          : null
    if (!path) {
      channel.destroy(new Error('Unknown fleet target'))
      return
    }
    const socket = createConnection({ path, allowHalfOpen: true })
    socket.on('error', (error) => channel.destroy(error))
    channel.on('error', () => socket.destroy())
    channel.once('close', () => socket.destroy())
    channel.pipe(socket).pipe(channel)
  }

  status(): { name: string; connected: boolean; lastSeen: number | null }[] {
    return this.options.settings.peers.map(({ name }) => ({
      name,
      connected: this.connections.has(name),
      lastSeen: this.connections.get(name)?.lastSeen ?? this.seen.get(name) ?? null,
    }))
  }

  private async report(): Promise<void> {
    if (this.stopping) return
    const s = this.options.settings
    const rows: StatusRow[] = this.status().map((peer) => ({
      id: `fleet/${s.machine}/${peer.name}`,
      what: `Link to ${peer.name}`,
      kind: 'machine',
      machine: peer.name,
      state: peer.connected ? 'ok' : 'warn',
      meaning: peer.connected
        ? `Connected to ${peer.name}.`
        : peer.lastSeen
          ? `Disconnected from ${peer.name}. Reconnecting.`
          : `Waiting for ${peer.name} to connect.`,
      ...(peer.lastSeen ? { last_run: new Date(peer.lastSeen).toISOString() } : {}),
      next_run: new Date((peer.lastSeen ?? Date.now()) + s.deadMs).toISOString(),
      actions: [{ kind: 'detail', ref: 'tether hosts' }],
    }))
    try {
      if (rows.length) await this.postRows(rows)
    } catch (error) {
      this.log(`Could not write link Status: ${(error as Error).message}`)
    }
  }

  async close(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    for (const timer of this.retry.values()) clearTimeout(timer)
    for (const socket of this.connecting) socket.destroy()
    for (const connection of this.connections.values()) connection.socket.destroy()
    await Promise.all(
      [...this.unix, ...(this.server ? [this.server] : [])].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    )
  }
}
