import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import {
  createConnection,
  createServer as createUnixServer,
  type Socket,
  type Server as UnixServer,
} from 'node:net'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { connect, createServer, type Server, type TLSSocket } from 'node:tls'
import type { StatusRow } from '@aico/status'
import { Connection, type OpenChannel } from './connection'
import { serveExec } from './exec'
import { hostForwards, hostsFilePath, loadHosts } from './hosts'
import { type Identity, loadIdentity, validName } from './identity'
import { loginPeerRpc } from './logins-client'
import { serveLoginWire } from './logins-wire'
import { guestPower, POWER_UNREAD_OFF, peerStatusRow, withHostPower } from './power'
import { type PveRequest, pveRequest } from './proxmox'
import { pushToolLogins } from './secrets'
import { type FleetSettings, localAddress, readSettings } from './settings'
import { type Pin, PinCache } from './trust'

export interface FleetOptions {
  settings: FleetSettings
  env?: NodeJS.ProcessEnv
  identity?: Identity
  pins?: () => Pin[]
  postRows?: (rows: StatusRow[]) => Promise<void>
  log?: (message: string) => void
  failed?: (error: Error) => void
  peerPower?: () => Promise<ReadonlyMap<string, string>>
  /** The loopback ports this machine lends to a peer: `forwards` in that host's hosts.json
   * entry, read at each ask. */
  forwards?: (peer: string) => number[]
  /** The address a lent port is reached on here (default loopback; tests move it). */
  lendHost?: string
}

/** The loopback listeners a worker holds for one connection to a machine that lends ports. */
interface Forwarding {
  servers: Map<number, UnixServer>
  failed: Set<number>
  timer: NodeJS.Timeout
}

const FORWARDS_ASK_MS = 10_000
const FORWARDS_BYTES = 4096

/** One connection per unordered machine pair; the lower name is the dialer.
 * Both ends may open channels. Local sockets preserve callers' HTTP/stream APIs. */
function lastPower(
  reading: { at: number; value: ReadonlyMap<string, string> } | null | undefined,
  peer: { name: string; lastSeen: number | null },
  staleMs: number,
): string | undefined {
  if (!reading || reading.at <= (peer.lastSeen ?? 0)) return undefined
  const power = reading.value.get(peer.name)
  if (Date.now() - reading.at < staleMs) return power
  return power === 'stopped' ? POWER_UNREAD_OFF : undefined
}

export class Fleet {
  private pve?: PveRequest
  private readonly connections = new Map<string, Connection>()
  private readonly connecting = new Set<TLSSocket>()
  private readonly accepted = new Set<TLSSocket>()
  private readonly retry = new Map<string, NodeJS.Timeout>()
  private readonly attempts = new Map<string, number>()
  private readonly seen = new Map<string, number>()
  private readonly unix: UnixServer[] = []
  private readonly local = new Set<Socket>()
  private readonly forwarding = new Map<Connection, Forwarding>()
  private readonly identity: Identity
  private readonly pins: () => Pin[]
  private readonly pinCache?: PinCache
  private readonly stable = new Map<string, NodeJS.Timeout>()
  private readonly log: (message: string) => void
  private readonly postRows: (rows: StatusRow[]) => Promise<void>
  private server: Server | null = null
  private timer: NodeJS.Timeout | null = null
  private stopping = false
  private reporting = false
  /** The last good reading stays when a read fails: a failed read says nothing about a guest. */
  private power: { at: number; value: ReadonlyMap<string, string> } | null = null
  private powerTriedAt = 0
  /** A first reading has finished. Until then a peer with no link isn't reported: at every start it
   * would read as waiting for a moment, though it's off. Bounded by powerTimeoutMs if a read hangs. */
  private powerAnswered = false
  /** Guests read running after a reading that had them off, with since when. */
  private readonly runningSince = new Map<string, number>()
  private powerProbe: Promise<void> | null = null
  private readonly startedAt = Date.now()

  constructor(private readonly options: FleetOptions) {
    const s = options.settings
    this.identity = options.identity ?? loadIdentity(s.stateDir, s.machine)
    this.pinCache = options.pins ? undefined : new PinCache(s.allowlist)
    this.pins = options.pins ?? (this.pinCache as PinCache).get
    this.log = options.log ?? ((message) => console.log(`[fleet] ${message}`))
    this.postRows =
      options.postRows ??
      (async (rows) => {
        if (s.mode === 'worker') return
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
    this.pinCache?.refresh()
    this.pins() // Refuse a missing or malformed allowlist before listening.
    for (const peer of s.peers) {
      if (!validName(peer.name) || peer.name === s.machine)
        throw new Error('Invalid fleet peer name')
      const dir = join(s.peerRoot, peer.name)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      for (const target of ['control', 'sync', 'exec', 'jobs', 'logins'] as const) {
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
        // Port 0 takes any free port; record it so peers configured in this process can reach it.
        const bound = this.server?.address()
        if (s.listen.port === 0 && bound && typeof bound === 'object') s.listen.port = bound.port
        resolve()
      })
    })
    this.server.on('error', (error) => {
      this.log(`Listener failed: ${error.message}`)
      this.options.failed?.(error)
    })
    for (const peer of s.peers) if (s.machine < peer.name) this.dial(peer.name)
    this.timer = setInterval(() => {
      try {
        this.pinCache?.refresh()
      } catch (error) {
        this.log(`Pins unavailable: ${(error as Error).message}`)
      }
      for (const connection of this.connections.values()) connection.recheck()
      void this.report()
    }, s.statusMs)
    this.timer.unref()
    await this.report()
  }

  private accept(socket: TLSSocket, expected?: string): void {
    this.accepted.add(socket)
    socket.once('close', () => this.accepted.delete(socket))
    try {
      new Connection(socket, {
        identity: this.identity,
        pins: this.pins,
        ...(expected ? { expected } : {}),
        deadMs: this.options.settings.deadMs,
        maxChannels: this.options.settings.maxChannels,
        bufferBytes: this.options.settings.bufferBytes,
        log: this.log,
        open: (stream, request, peer) => this.openLocal(stream, request, peer),
        ready: (connection) => {
          if (!this.options.settings.peers.some((peer) => peer.name === connection.peer)) {
            socket.destroy(new Error('Peer has no configured endpoint'))
            return
          }
          const current = this.connections.get(connection.peer)
          this.connections.set(connection.peer, connection)
          if (current && current !== connection) current.socket.destroy()
          clearTimeout(this.stable.get(connection.peer))
          const stable = setTimeout(() => {
            if (this.connections.get(connection.peer) === connection)
              this.attempts.delete(connection.peer)
            this.stable.delete(connection.peer)
          }, this.options.settings.stableMs ?? 30000)
          stable.unref()
          this.stable.set(connection.peer, stable)
          this.log(`${connection.peer}: connected`)
          if (this.options.settings.mode === 'worker') this.startForwards(connection)
          void this.report()
          if (
            this.pins().find((pin) => pin.name === this.options.settings.machine)?.role === 'full'
          ) {
            try {
              const current =
                readSettings(
                  this.options.env ?? process.env,
                  this.options.settings.controlSocket,
                ) ?? this.options.settings
              void pushToolLogins(current, connection.peer).catch(() =>
                this.log(`${connection.peer}: tool login delivery failed`),
              )
            } catch {
              this.log(`${connection.peer}: could not read tool grants`)
            }
          }
        },
        closed: (connection) => {
          this.stopForwards(connection)
          if (this.connections.get(connection.peer) === connection) {
            clearTimeout(this.stable.get(connection.peer))
            this.stable.delete(connection.peer)
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
    // Before TLS authentication, bound only the absence of received wire bytes.
    let lastSeen = Date.now()
    const received = () => {
      lastSeen = Date.now()
    }
    socket.on('data', received)
    const silence = setInterval(
      () => {
        if (Date.now() - lastSeen >= s.deadMs)
          socket.destroy(new Error('Fleet connection is silent'))
      },
      Math.min(1000, s.deadMs / 2),
    )
    silence.unref()
    socket.once('close', () => clearInterval(silence))
    socket.once('secureConnect', () => {
      clearInterval(silence)
      socket.off('data', received)
      this.accept(socket, name)
    })
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
    const server = createUnixServer({ allowHalfOpen: true }, (socket) => {
      this.local.add(socket)
      socket.once('close', () => this.local.delete(socket))
      connection(socket)
    })
    this.unix.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        chmodSync(path, 0o600)
        resolve()
      })
    })
    server.on('error', (error) => {
      this.log(`Local fleet socket failed: ${error.message}`)
      this.options.failed?.(error)
    })
  }

  private forward(name: string, target: string, socket: Socket): void {
    socket.on('error', () => {})
    const connect = (argv?: string[]) => {
      try {
        const connection = this.connections.get(name)
        if (!connection) throw new Error('Fleet peer is disconnected')
        const channel = connection.open({
          type: target === 'sync' ? 'sync' : argv ? 'terminal-view' : 'control',
          target: target === 'logins' ? 'jobs' : target,
          ...(argv ? { argv } : {}),
        })
        socket.pipe(channel).pipe(socket)
        socket.once('close', () => channel.destroy())
        channel.once('error', () => socket.destroy())
        channel.once('close', () => socket.end(() => socket.destroy()))
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

  private openLocal(channel: Duplex, request: OpenChannel, peer: string): void {
    const s = this.options.settings
    const pin = this.pins().find((entry) => entry.name === peer)
    if (
      !pin ||
      (pin.role !== 'full' && !['sync', 'jobs', 'forwards', 'tcp'].includes(request.target))
    ) {
      channel.destroy(new Error('Peer role does not allow this action'))
      return
    }
    if (request.target === 'forwards') {
      channel.end(JSON.stringify({ ports: this.lent(peer) }))
      return
    }
    if (request.target === 'tcp') {
      // Only a port this machine lends to that peer, re-read now: an edit of hosts.json applies
      // to the next connection.
      const port = request.port
      if (!port || !this.lent(peer).includes(port)) {
        channel.destroy(new Error('Port is not lent to this peer'))
        return
      }
      const socket = createConnection({
        host: this.options.lendHost ?? '127.0.0.1',
        port,
        allowHalfOpen: true,
      })
      this.pipeSocket(socket, channel)
      return
    }
    if (request.target === 'exec' && request.argv) {
      serveExec(channel, request.argv)
      return
    }
    const path =
      request.target === 'control'
        ? s.controlSocket
        : request.target === 'sync'
          ? s.syncSocket
          : request.target === 'jobs'
            ? (s.jobsSocket ?? join(dirname(s.syncSocket), 'jobs.sock'))
            : null
    if (!path) {
      channel.destroy(new Error('Unknown fleet target'))
      return
    }
    const forward = () => {
      const socket = createConnection({ path, allowHalfOpen: true })
      socket.on('error', (error) => channel.destroy(error))
      channel.on('error', () => socket.destroy())
      channel.once('close', () => socket.end(() => socket.destroy()))
      if (request.target === 'jobs') socket.write(`${peer}\n`)
      channel.pipe(socket).pipe(channel)
    }
    if (request.target === 'jobs') {
      // Use the existing worker-safe carrier. Older peers reject the request locally,
      // keeping their fleet link up while the signed worker update is installed.
      channel.once('data', (head: Buffer) => {
        channel.pause()
        channel.unshift(head)
        if (head[0] === 0x7b)
          serveLoginWire(channel, (input) =>
            loginPeerRpc(
              input,
              peer,
              pin.role,
              this.options.env || process.env,
              s,
              this.pins().find((entry) => entry.name === s.machine)?.role === 'full',
            ),
          )
        else forward()
        channel.resume()
      })
    } else forward()
  }

  private lent(peer: string): number[] {
    return this.options.forwards
      ? this.options.forwards(peer)
      : hostForwards(hostsFilePath(this.options.env ?? process.env), peer)
  }

  private pipeSocket(socket: Socket, channel: Duplex): void {
    this.local.add(socket)
    socket.once('close', () => this.local.delete(socket))
    socket.on('error', () => channel.destroy())
    channel.on('error', () => socket.destroy())
    channel.once('close', () => socket.end(() => socket.destroy()))
    socket.once('close', () => channel.destroy())
    channel.pipe(socket).pipe(channel)
  }

  /** A worker asks the machine it linked to which of that machine's loopback ports it lends, and
   * listens on the same ports here; each connection to one is carried to the peer's port over the
   * link. A machine that lends nothing (no hosts.json entry or no `forwards`) leaves this idle. The
   * answer is read again every minute and listeners follow it; a dropped link closes them. */
  private startForwards(connection: Connection): void {
    const state: Forwarding = {
      servers: new Map(),
      failed: new Set(),
      timer: setInterval(() => void this.syncForwards(connection, state), 60_000),
    }
    state.timer.unref()
    this.forwarding.set(connection, state)
    void this.syncForwards(connection, state)
  }

  private stopForwards(connection: Connection): void {
    const state = this.forwarding.get(connection)
    if (!state) return
    clearInterval(state.timer)
    for (const server of state.servers.values()) server.close()
    this.forwarding.delete(connection)
  }

  private async syncForwards(connection: Connection, state: Forwarding): Promise<void> {
    let ports: number[]
    try {
      ports = await this.askForwards(connection)
    } catch (error) {
      if (this.forwarding.get(connection) === state)
        this.log(`${connection.peer}: could not read its lent ports: ${(error as Error).message}`)
      return
    }
    if (this.forwarding.get(connection) !== state) return
    for (const [port, server] of state.servers)
      if (!ports.includes(port)) {
        server.close()
        state.servers.delete(port)
        this.log(`${connection.peer}: stopped forwarding 127.0.0.1:${port}`)
      }
    for (const port of ports) {
      if (state.servers.has(port)) continue
      const server = createUnixServer({ allowHalfOpen: true }, (socket) =>
        this.carry(connection, port, socket),
      )
      const bound = await new Promise<boolean>((resolve) => {
        server.once('error', (error) => {
          if (!state.failed.has(port))
            this.log(`${connection.peer}: cannot listen on 127.0.0.1:${port}: ${error.message}`)
          state.failed.add(port)
          resolve(false)
        })
        server.listen(port, '127.0.0.1', () => resolve(true))
      })
      if (!bound) continue
      if (this.forwarding.get(connection) !== state) {
        server.close()
        return
      }
      state.failed.delete(port)
      state.servers.set(port, server)
      this.log(`${connection.peer}: forwarding 127.0.0.1:${port} to ${connection.peer}`)
    }
  }

  private askForwards(connection: Connection): Promise<number[]> {
    return new Promise((resolve, reject) => {
      const channel = connection.open({ type: 'control', target: 'forwards' })
      const chunks: Buffer[] = []
      let size = 0
      const timer = setTimeout(() => channel.destroy(new Error('no answer')), FORWARDS_ASK_MS)
      const done = (error?: Error) => {
        clearTimeout(timer)
        if (error) return reject(error)
        try {
          const answer: unknown = JSON.parse(Buffer.concat(chunks).toString())
          const ports = (answer as { ports?: unknown } | null)?.ports
          if (
            !Array.isArray(ports) ||
            ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)
          )
            throw new Error('invalid answer')
          resolve(ports as number[])
        } catch (failure) {
          reject(failure as Error)
        }
      }
      channel.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > FORWARDS_BYTES) channel.destroy(new Error('answer too large'))
        else chunks.push(chunk)
      })
      channel.once('end', () => done())
      channel.once('error', (error) => done(error))
      channel.once('close', () => done(new Error('closed before an answer')))
    })
  }

  private carry(connection: Connection, port: number, socket: Socket): void {
    try {
      this.pipeSocket(socket, connection.open({ type: 'control', target: 'tcp', port }))
    } catch {
      socket.destroy()
    }
  }

  status(): { name: string; connected: boolean; lastSeen: number | null }[] {
    return this.options.settings.peers.map(({ name }) => ({
      name,
      connected: this.connections.has(name),
      lastSeen: this.connections.get(name)?.lastSeen ?? this.seen.get(name) ?? null,
    }))
  }

  private async report(): Promise<void> {
    if (this.stopping || this.reporting) return
    this.reporting = true
    const s = this.options.settings
    try {
      if (this.status().some((peer) => !peer.connected)) this.refreshPower()
      const reading = this.power
      if (this.stopping) return
      const pins = this.pins()
      const known =
        this.powerAnswered || Date.now() - this.startedAt >= (s.powerTimeoutMs ?? 10_000)
      const settleMs = s.linkSettleMs ?? 120_000
      const rows = this.status().flatMap((peer) => {
        if (!peer.connected && !known) return []
        // A reading from before the peer's last contact (one that just dropped) is not evidence it
        // is off. Nor is one too old: then it was off when last checked, which isn't down either.
        const power = lastPower(reading, peer, s.powerStaleMs ?? 30 * 60_000)
        const running = this.runningSince.get(peer.name)
        // A link that just dropped, or a machine still booting, isn't a problem yet: the last row
        // stands until a reading says off or the link has had time to come back.
        if (
          !peer.connected &&
          power !== 'stopped' &&
          power !== POWER_UNREAD_OFF &&
          Date.now() - Math.max(peer.lastSeen ?? 0, running ?? 0) < settleMs
        )
          return []
        const role = pins.find((pin) => pin.name === peer.name)?.role
        return [peerStatusRow(s, peer, role, power, this.startedAt, running)]
      })
      if (rows.length) await this.postRows(rows)
    } catch (error) {
      this.log(`Could not write link Status: ${(error as Error).message}`)
    } finally {
      this.reporting = false
    }
  }

  private pveCall(timeoutMs: number): PveRequest {
    this.pve ??= pveRequest(this.options.env ?? process.env, { timeoutMs })
    return this.pve
  }

  /** Reads guest power at most once per powerCacheMs, in the background so a hung probe never
   * holds up link Status; a fresh reading reports at once. A failed reading keeps the last good one. */
  private refreshPower(): void {
    const s = this.options.settings
    if (this.powerProbe || Date.now() - this.powerTriedAt < (s.powerCacheMs ?? 60_000)) return
    const timeoutMs = s.powerTimeoutMs ?? 10_000
    const read =
      this.options.peerPower ??
      (async () =>
        withHostPower(
          s.proxmox ? await guestPower(this.pveCall(timeoutMs)) : new Map<string, string>(),
          this.status()
            .filter((peer) => !peer.connected)
            .map((peer) => peer.name),
          loadHosts(hostsFilePath(this.options.env ?? process.env)).hosts,
          timeoutMs,
        ))
    this.powerTriedAt = Date.now()
    this.powerProbe = (async () => {
      try {
        const value = await read()
        const at = Date.now()
        for (const [name, state] of value)
          if (state !== 'running') this.runningSince.delete(name)
          else if (this.power?.value.get(name) === 'stopped') this.runningSince.set(name, at)
        this.power = { at, value }
      } catch (error) {
        this.log(`Could not read guest power: ${(error as Error).message}`)
      }
    })().finally(() => {
      this.powerAnswered = true
      this.powerProbe = null
      if (!this.stopping) void this.report()
    })
  }

  async close(): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    for (const timer of this.retry.values()) clearTimeout(timer)
    for (const timer of this.stable.values()) clearTimeout(timer)
    for (const socket of this.connecting) socket.destroy()
    for (const socket of this.accepted) socket.destroy()
    for (const socket of this.local) socket.destroy()
    for (const connection of this.connections.values()) connection.socket.destroy()
    for (const connection of [...this.forwarding.keys()]) this.stopForwards(connection)
    await Promise.all(
      [...this.unix, ...(this.server ? [this.server] : [])].map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    )
  }
}
