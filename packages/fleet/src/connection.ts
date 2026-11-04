import { createPublicKey, randomUUID, sign, verify } from 'node:crypto'
import { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { type ChannelKind, Decoder, encodeFrame, type Frame } from './frames'
import { certificateKey, type Identity } from './identity'
import type { Pin } from './trust'

export interface OpenChannel {
  type: ChannelKind
  target: string
  argv?: string[]
}
export interface ConnectionOptions {
  identity: Identity
  pins(): Pin[]
  expected?: string
  deadMs: number
  open(channel: Duplex, request: OpenChannel, peer: string): void
  ready(connection: Connection): void
  closed(connection: Connection): void
  log(message: string): void
}

/** TLS proves possession of the pinned certificate key. Auth additionally binds
 * names, direction and protocol version to this exact TLS session (no replay). */
export class Connection {
  peer: string
  lastSeen = Date.now()
  authenticated = false
  private hello = false
  private readonly decoder = new Decoder()
  private readonly channels = new Map<string, { type: ChannelKind; stream: Duplex }>()

  constructor(
    readonly socket: TLSSocket,
    private readonly options: ConnectionOptions,
  ) {
    const raw = socket.getPeerCertificate().raw
    const key = raw ? certificateKey(raw) : ''
    const pin = options.pins().find((candidate) => candidate.publicKey === key)
    if (
      !pin ||
      (options.expected && pin.name !== options.expected) ||
      pin.name === options.identity.name
    )
      throw new Error('Peer key is not approved')
    this.peer = pin.name
    socket.setTimeout(options.deadMs, () => socket.destroy(new Error('Fleet connection is silent')))
    socket.setKeepAlive(true)
    socket.on('data', (chunk: Buffer) => {
      try {
        this.lastSeen = Date.now()
        for (const frame of this.decoder.push(chunk)) this.receive(frame)
      } catch (error) {
        socket.destroy(error as Error)
      }
    })
    socket.once('close', () => {
      for (const { stream } of this.channels.values())
        stream.destroy(new Error('Fleet link closed'))
      this.channels.clear()
      options.closed(this)
    })
    socket.on('error', (error) => options.log(`${this.peer}: ${error.message}`))
    this.send({
      type: 'hello',
      version: 1,
      machine: options.identity.name,
      publicKey: options.identity.publicKey,
    })
  }

  private transcript(from: string, to: string): Buffer {
    return Buffer.concat([
      Buffer.from(`aico-fleet-v1\n${from}\n${to}\n`),
      this.socket.exportKeyingMaterial(32, 'aico-fleet-v1', Buffer.alloc(0)),
    ])
  }

  private approved(): boolean {
    try {
      return this.options
        .pins()
        .some(
          (pin) =>
            pin.name === this.peer &&
            pin.publicKey === certificateKey(this.socket.getPeerCertificate().raw),
        )
    } catch {
      return false
    }
  }

  recheck(): void {
    if (!this.approved()) this.socket.destroy(new Error('Peer key was revoked'))
  }

  private send(frame: Frame, callback?: (error?: Error | null) => void): void {
    if (this.socket.destroyed) {
      callback?.(new Error('Fleet link is disconnected'))
      return
    }
    this.socket.write(encodeFrame(frame), callback)
  }

  private receive(frame: Frame): void {
    if (!this.approved()) throw new Error('Peer key was revoked')
    if (frame.type === 'hello') {
      if (
        this.hello ||
        frame.machine !== this.peer ||
        frame.publicKey !== certificateKey(this.socket.getPeerCertificate().raw)
      )
        throw new Error('Fleet identity mismatch')
      this.hello = true
      this.send({
        type: 'auth',
        signature: sign(
          null,
          this.transcript(this.options.identity.name, this.peer),
          this.options.identity.key,
        ).toString('base64'),
      })
      return
    }
    if (frame.type === 'auth') {
      if (!this.hello || this.authenticated) throw new Error('Unexpected fleet authentication')
      const pin = this.options.pins().find((candidate) => candidate.name === this.peer)
      if (!pin) throw new Error('Peer key was revoked')
      const key = createPublicKey({
        key: Buffer.from(pin.publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      })
      if (
        !verify(
          null,
          this.transcript(this.peer, this.options.identity.name),
          key,
          Buffer.from(frame.signature, 'base64'),
        )
      )
        throw new Error('Invalid fleet authentication')
      this.authenticated = true
      this.options.ready(this)
      return
    }
    if (!this.authenticated) throw new Error('Fleet peer has not authenticated')
    if (frame.op === 'open') {
      if (this.channels.has(frame.id)) throw new Error('Duplicate fleet channel')
      const stream = this.channel(frame.id, frame.type)
      this.options.open(
        stream,
        { type: frame.type, target: frame.target, ...(frame.argv ? { argv: frame.argv } : {}) },
        this.peer,
      )
      return
    }
    const entry = this.channels.get(frame.id)
    if (!entry) return // A local caller may already have closed it.
    if (entry.type !== frame.type) throw new Error('Fleet channel kind changed')
    if (frame.op === 'data') entry.stream.push(Buffer.from(frame.data, 'base64'))
    else if (frame.op === 'end') entry.stream.push(null)
    else entry.stream.destroy()
  }

  private channel(id: string, type: ChannelKind): Duplex {
    const connection = this
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, callback) {
        connection.send({ type, id, op: 'data', data: chunk.toString('base64') }, callback)
      },
      final(callback) {
        connection.send({ type, id, op: 'end' }, callback)
      },
      destroy(error, callback) {
        connection.channels.delete(id)
        connection.send({ type, id, op: 'close' })
        callback(error)
      },
    })
    stream.on('error', () => {})
    this.channels.set(id, { type, stream })
    return stream
  }

  open(request: OpenChannel): Duplex {
    if (!this.authenticated || !this.approved())
      throw new Error('Fleet peer is not trusted and connected')
    const id = randomUUID()
    const stream = this.channel(id, request.type)
    this.send({
      type: request.type,
      id,
      op: 'open',
      target: request.target,
      ...(request.argv ? { argv: request.argv } : {}),
    })
    return stream
  }
}
