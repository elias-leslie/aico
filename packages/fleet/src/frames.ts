// Versioned, length-prefixed JSON. Payload bytes are base64, never shell text.
export const VERSION = 1
export const MAX_FRAME_BYTES = 1024 * 1024
export const CHANNEL_KINDS = ['control', 'event', 'sync', 'terminal-view'] as const
export type ChannelKind = (typeof CHANNEL_KINDS)[number]
export type Frame =
  | { type: 'hello'; version: 1; machine: string; publicKey: string }
  | { type: 'auth'; signature: string }
  | { type: ChannelKind; id: string; op: 'open'; target: string; argv?: string[]; port?: number }
  | { type: ChannelKind; id: string; op: 'data'; data: string }
  | { type: ChannelKind; id: string; op: 'end' | 'close' }

export function parseFrame(value: unknown): Frame {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid fleet frame')
  const f = value as Record<string, unknown>
  let fields: string[]
  if (f.type === 'hello') {
    fields = ['type', 'version', 'machine', 'publicKey']
    if (
      f.version !== VERSION ||
      typeof f.machine !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(f.machine) ||
      typeof f.publicKey !== 'string' ||
      !f.publicKey
    )
      throw new Error('Invalid hello')
  } else if (f.type === 'auth') {
    fields = ['type', 'signature']
    if (typeof f.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(f.signature))
      throw new Error('Invalid auth')
  } else if (CHANNEL_KINDS.includes(f.type as ChannelKind)) {
    if (typeof f.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(f.id))
      throw new Error('Invalid channel id')
    if (f.op === 'open') {
      fields = ['type', 'id', 'op', 'target', 'argv', 'port']
      if (
        typeof f.target !== 'string' ||
        !['control', 'sync', 'exec', 'jobs', 'forwards', 'tcp'].includes(f.target)
      )
        throw new Error('Invalid channel target')
      if (
        f.argv !== undefined &&
        (!Array.isArray(f.argv) ||
          !f.argv.length ||
          f.argv.some((s) => typeof s !== 'string' || s.includes('\0')))
      )
        throw new Error('Invalid command argv')
      if ((f.target === 'exec') !== (f.argv !== undefined)) throw new Error('Exec needs argv')
      if (
        (f.target === 'tcp') !== (f.port !== undefined) ||
        (f.port !== undefined &&
          (typeof f.port !== 'number' || !Number.isInteger(f.port) || f.port < 1 || f.port > 65535))
      )
        throw new Error('Invalid forward port')
    } else if (f.op === 'data') {
      fields = ['type', 'id', 'op', 'data']
      if (typeof f.data !== 'string' || f.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data))
        throw new Error('Invalid channel data')
    } else if (f.op === 'end' || f.op === 'close') fields = ['type', 'id', 'op']
    else throw new Error('Invalid channel operation')
  } else throw new Error('Unknown fleet frame')
  if (Object.keys(f).some((key) => !fields.includes(key))) throw new Error('Unknown frame field')
  return f as Frame
}

export function encodeFrame(frame: Frame): Buffer {
  const payload = Buffer.from(JSON.stringify(parseFrame(frame)))
  if (payload.length > MAX_FRAME_BYTES) throw new Error('Fleet frame too large')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(payload.length)
  return Buffer.concat([size, payload])
}

export class Decoder {
  private buffer: Buffer = Buffer.alloc(0)
  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const frames: Frame[] = []
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE()
      if (size === 0 || size > MAX_FRAME_BYTES) throw new Error('Fleet frame too large')
      if (this.buffer.length < size + 4) break
      frames.push(parseFrame(JSON.parse(this.buffer.subarray(4, size + 4).toString('utf8'))))
      this.buffer = this.buffer.subarray(size + 4)
    }
    return frames
  }
}
