// A peer over a unix socket: the PeerTransport the engine pulls through, plus
// the two calls around it (a blob, a nudge). The socket is the local end of the
// peer's fleet channel, or a plain socket in tests.

import { request } from 'node:http'
import type { BlobVariant } from '@aico/notes/blobs'
import type { ChangePage, Hello, PeerTransport } from './engine'

export interface Peer extends PeerTransport {
  /** The bytes, or null when the peer does not have that file. */
  blob(hash: string, variant: BlobVariant): Promise<Buffer | null>
  /** Tells the peer we wrote, so it pulls now. */
  nudge(): Promise<void>
}

class PeerError extends Error {}

/** `idleMs` is how long an open request may stay silent before it is dropped (a hung forward). */
export function unixPeer(socketPath: string, options: { idleMs: number }): Peer {
  const call = (method: string, path: string): Promise<{ status: number; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const req = request({ socketPath, method, path, timeout: options.idleMs }, (res) => {
        const parts: Buffer[] = []
        res.on('data', (chunk: Buffer) => parts.push(chunk))
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts) }))
      })
      req.on('timeout', () => req.destroy(new PeerError('The peer stopped answering')))
      req.on('error', reject)
      req.end()
    })
  const json = async <T>(method: string, path: string): Promise<T> => {
    const { status, body } = await call(method, path)
    if (status !== 200) throw new PeerError(`The peer answered ${status} to ${path.split('?')[0]}`)
    return JSON.parse(body.toString('utf8')) as T
  }
  return {
    hello: () => json<Hello>('GET', '/sync/hello'),
    changes: ({ set, since, limit, peer }) =>
      json<ChangePage>(
        'GET',
        `/sync/changes?${new URLSearchParams({ set, since: String(since), limit: String(limit), peer })}`,
      ),
    async blob(hash, variant) {
      const suffix = variant === 'original' ? '' : `?v=${variant}`
      const { status, body } = await call('GET', `/sync/blob/${hash}${suffix}`)
      if (status === 404) return null
      if (status !== 200) throw new PeerError(`The peer answered ${status} to a blob`)
      return body
    },
    async nudge() {
      await json('POST', '/sync/nudge')
    },
  }
}
