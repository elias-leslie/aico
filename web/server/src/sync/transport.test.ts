// The sync transport on real (temp) unix sockets: the listener, the client, the
// pull loop and blob copy, with two hosts in one process. No timers: the loop
// is driven by calling `run()`, with fake clocks for the hosts.

import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blobPath, hasBlob, putOriginal, putVariant, readBlob, sha256 } from '../blobs'
import { copyMissingBlobs, removeUnreferenced } from './blobs'
import { type Host, openHost } from './harness'
import { SyncLoop } from './loop'
import { type Peer, unixPeer } from './peer'
import { createSyncServer, listenUnix } from './server'

const DAY = 86_400_000
let root: string
let doors: Door[]

interface Door {
  host: Host
  blobs: string
  socket: string
  server: Server
  loop: SyncLoop
  nudges: number
  logs: string[]
  /** Replaces the peer a door pulls from (to corrupt a download, say). */
  wrap?: (peer: Peer) => Peer
}

/** A whole host on its own socket, pulling from `peerSocket` (set later: the two need each other's path). */
async function door(
  name: string,
  peerSocket: () => string | null,
  options: { schema?: number } = {},
): Promise<Door> {
  const host = openHost(name)
  const blobs = join(root, `${name}-blobs`)
  const socket = join(root, `${name}.sock`)
  const self: Door = { host, blobs, socket, nudges: 0, logs: [] } as unknown as Door
  const handles = [host.handles.notes, host.handles.web]
  if (options.schema !== undefined)
    for (const handle of handles) handle.schemaVersion = () => options.schema as number
  self.server = createSyncServer({
    hostName: name,
    handles,
    blobsDir: blobs,
    now: host.clock.now,
    nudged: () => {
      self.nudges += 1
    },
  })
  await listenUnix(self.server, socket)
  self.loop = new SyncLoop({
    notes: host.handles.notes,
    web: host.handles.web,
    blobsDir: blobs,
    peers: () => {
      const path = peerSocket()
      return path ? [{ name: 'peer', socket: path }] : []
    },
    connect: (peer) => {
      const link = unixPeer(peer.socket, { idleMs: 2_000 })
      return self.wrap ? self.wrap(link) : link
    },
    now: host.clock.now,
    tombstoneMs: 180 * DAY,
    maxAheadMs: DAY,
    blobGraceMs: 7 * DAY,
    intervalMs: 60_000,
    watchMs: 1_000,
    log: (message) => self.logs.push(message),
  })
  doors.push(self)
  return self
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aico-sx-'))
  doors = []
})
afterEach(() => {
  for (const d of doors) {
    d.server.close()
    d.server.closeAllConnections()
    d.host.notes.close()
    d.host.web.close()
  }
  rmSync(root, { recursive: true, force: true })
})

const get = (socketPath: string, path: string, method = 'GET') =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath, path, method }, (res) => {
      let body = ''
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })

describe('the sync listener', () => {
  it('serves only /sync/* on a 0600 socket in a 0700 directory', async () => {
    const a = await door('alpha', () => null)
    const dir = join(root, 'run', 'aico')
    const path = join(dir, 'sync.sock')
    const server = createSyncServer({
      hostName: 'alpha',
      handles: [a.host.handles.notes],
      blobsDir: a.blobs,
      now: () => 5,
      nudged: () => {},
    })
    await listenUnix(server, path)
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(JSON.parse((await get(path, '/sync/hello')).body)).toMatchObject({
        host: 'alpha',
        now: 5,
      })
      expect((await get(path, '/api/captures')).status).toBe(404)
      expect((await get(path, '/sync/changes?set=nope&since=0&limit=5')).status).toBe(400)
      expect((await get(path, '/sync/blob/not-a-hash')).status).toBe(400)
      expect((await get(path, `/sync/blob/${'a'.repeat(64)}`)).status).toBe(404)
      expect((await get(path, '/sync/hello', 'POST')).status).toBe(405)
    } finally {
      server.close()
    }
  })

  it('serves a blob and its variants, and takes a nudge', async () => {
    const a = await door('alpha', () => null)
    const bytes = Buffer.from('photo bytes')
    const hash = await putOriginal(a.blobs, bytes)
    await putVariant(a.blobs, hash, 'thumb', Buffer.from('tiny'))
    const peer = unixPeer(a.socket, { idleMs: 2_000 })
    expect((await peer.blob(hash, 'original'))?.toString()).toBe('photo bytes')
    expect((await peer.blob(hash, 'thumb'))?.toString()).toBe('tiny')
    expect(await peer.blob(hash, 'preview')).toBeNull()
    await peer.nudge()
    expect(a.nudges).toBe(1)
  })

  it('replaces a stale socket file and refuses to replace anything else', async () => {
    const a = await door('alpha', () => null)
    const make = () =>
      createSyncServer({
        hostName: 'alpha',
        handles: [a.host.handles.notes],
        blobsDir: a.blobs,
        now: () => 1,
        nudged: () => {},
      })
    const path = join(root, 'again.sock')
    const first = make()
    await listenUnix(first, path)
    const second = make()
    await listenUnix(second, path) // the file is replaced, not an EADDRINUSE
    expect((await get(path, '/sync/hello')).status).toBe(200)
    first.close()
    second.close()
    const file = join(root, 'plain')
    writeFileSync(file, 'not a socket')
    await expect(listenUnix(make(), file)).rejects.toThrow(/non-socket/)
  })
})

describe('two hosts over sockets', () => {
  it('converge after an edit on each side, copy a photo, and retry a corrupted download', async () => {
    let bSocket: string | null = null
    let aSocket: string | null = null
    const a = await door('alpha', () => bSocket)
    const b = await door('beta', () => aSocket)
    aSocket = a.socket
    bSocket = b.socket

    const noteA = a.host.notes.notes.create({ title: 'From alpha' })
    const noteB = b.host.notes.notes.create({ title: 'From beta' })
    const pane = b.host.web.createPane({ projectId: 'aico', name: 'Beta tab', activeMode: 'codex' })
    // A photo on alpha: row, original, thumb.
    const original = Buffer.from('a pretend jpeg')
    const hash = await putOriginal(a.blobs, original)
    await putVariant(a.blobs, hash, 'thumb', Buffer.from('thumb'))
    a.host.notes.insertCapture({
      clientId: 'c1',
      kind: 'image',
      name: 'p.jpg',
      mime: 'image/jpeg',
      size: original.length,
      hash,
    })
    // beta's first download of the original is damaged.
    let damaged = 0
    b.wrap = (peer) => ({
      ...peer,
      async blob(want, variant) {
        const bytes = await peer.blob(want, variant)
        if (bytes && variant === 'original' && damaged++ === 0) return Buffer.from('garbage')
        return bytes
      },
    })

    await a.loop.run()
    await b.loop.run()
    await a.loop.run()

    expect(b.host.notes.notes.getNote(noteA.id)?.title).toBe('From alpha')
    expect(a.host.notes.notes.getNote(noteB.id)?.title).toBe('From beta')
    expect(a.host.web.listPanes().map((p) => p.id)).toContain(pane.id)
    // The damaged copy was refused, not stored.
    expect(hasBlob(b.blobs, hash)).toBe(false)
    expect(b.logs.some((line) => line.includes('does not match'))).toBe(true)
    expect(b.loop.status()[0]).toMatchObject({ state: 'ok', host: 'alpha' })

    await b.loop.run() // the retry
    expect(hasBlob(b.blobs, hash)).toBe(true)
    expect(sha256((await readBlob(b.blobs, hash)) as Buffer)).toBe(hash)
    expect((await readBlob(b.blobs, hash, 'thumb'))?.toString()).toBe('thumb')
    expect(damaged).toBe(2)
  })

  it('nudges the peer after a local write, so it pulls without waiting', async () => {
    let bSocket: string | null = null
    const a = await door('alpha', () => bSocket)
    const b = await door('beta', () => null)
    bSocket = b.socket
    a.host.notes.notes.create({ title: 'Quick' })
    a.loop.watch() // the poll sees a write no pull explains
    await a.loop.run()
    expect(b.nudges).toBe(1)
    await a.loop.run() // pulling is not a write: no second nudge
    a.loop.watch()
    await a.loop.run()
    expect(b.nudges).toBe(1)
    b.host.notes.notes.create({ title: 'Back' })
    await a.loop.run() // alpha applies it: still not alpha's own write
    a.loop.watch()
    await a.loop.run()
    expect(b.nudges).toBe(1)
  })

  it('skips a peer that is down without a word, and a schema mismatch pauses only sync', async () => {
    let peerSocket: string | null = join(root, 'nobody.sock')
    const a = await door('alpha', () => peerSocket)
    a.host.notes.notes.create({ title: 'Local' })
    await a.loop.run()
    expect(a.loop.status()).toMatchObject([{ name: 'peer', state: 'down', lastSyncAt: null }])
    expect(a.logs.filter((line) => line.startsWith('peer'))).toEqual([])

    const b = await door('beta', () => null, { schema: 99 })
    peerSocket = b.socket
    await a.loop.run()
    const status = a.loop.status()[0]
    expect(status?.state).toBe('paused')
    expect(status?.reason).toMatch(/different databases/)
    // Local use goes on.
    const note = a.host.notes.notes.create({ title: 'Still works' })
    expect(a.host.notes.notes.getNote(note.id)?.title).toBe('Still works')
  })

  it('reports an unlisted peer as waiting, and lists none when no host syncs', async () => {
    const a = await door('alpha', () => join(root, 'x.sock'))
    expect(a.loop.status()).toMatchObject([{ name: 'peer', state: 'waiting' }])
    const none = await door('beta', () => null)
    expect(none.loop.status()).toEqual([])
  })
})

describe('daily cleanup', () => {
  it('removes tombstones and blobs nothing names once, after the grace period', async () => {
    const a = await door('alpha', () => null)
    const keep = await putOriginal(a.blobs, Buffer.from('kept'))
    const orphan = await putOriginal(a.blobs, Buffer.from('orphan'))
    const fresh = await putOriginal(a.blobs, Buffer.from('fresh orphan'))
    a.host.notes.insertCapture({
      clientId: 'c',
      kind: 'image',
      name: 'k.jpg',
      mime: 'image/jpeg',
      size: 4,
      hash: keep,
    })
    const old = new Date(a.host.clock.now() - 8 * DAY)
    for (const hash of [keep, orphan]) utimesSync(blobPath(a.blobs, hash), old, old)
    mkdirSync(join(a.blobs, 'zz'), { recursive: true })

    await a.loop.run()
    expect(hasBlob(a.blobs, keep)).toBe(true)
    expect(hasBlob(a.blobs, orphan)).toBe(false)
    expect(hasBlob(a.blobs, fresh)).toBe(true) // inside the grace period
    expect(a.logs.at(-1)).toMatch(/cleanup:/)

    const before = a.logs.length
    await a.loop.run() // not again the same day
    expect(a.logs).toHaveLength(before)
    a.host.clock.advance(DAY + 1)
    await a.loop.run()
    expect(a.logs.at(-1)).toMatch(/cleanup:/)
  })

  it('keeps a blob a deleted row still names, and drops stale temp files', async () => {
    const a = await door('alpha', () => null)
    const hash = await putOriginal(a.blobs, Buffer.from('deleted but remembered'))
    const { capture } = a.host.notes.insertCapture({
      clientId: 'd',
      kind: 'image',
      name: 'd.jpg',
      mime: 'image/jpeg',
      size: 4,
      hash,
    })
    a.host.notes.tombstoneCapture(capture.id)
    const temp = `${blobPath(a.blobs, hash)}.abc.tmp`
    writeFileSync(temp, 'half')
    const old = new Date(a.host.clock.now() - 30 * DAY)
    for (const path of [temp, blobPath(a.blobs, hash)]) utimesSync(path, old, old)
    const removed = await removeUnreferenced(a.blobs, [a.host.handles.notes], {
      graceMs: 7 * DAY,
      now: a.host.clock.now(),
    })
    expect(removed).toBe(1)
    expect(hasBlob(a.blobs, hash)).toBe(true)
  })

  it('leaves a blob the peer does not have yet for the next pass', async () => {
    const a = await door('alpha', () => null)
    const b = await door('beta', () => null)
    const hash = '9'.repeat(64)
    a.host.notes.insertCapture({
      clientId: 'x',
      kind: 'image',
      name: 'x.jpg',
      mime: 'image/jpeg',
      size: 1,
      hash,
    })
    const copy = await copyMissingBlobs(
      a.host.handles.notes,
      unixPeer(b.socket, { idleMs: 2_000 }),
      a.blobs,
    )
    expect(copy).toEqual({ fetched: 0, mismatched: [], absent: 1 })
  })
})
