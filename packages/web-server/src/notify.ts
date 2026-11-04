// Owner notices in aico-web (packages/notify does the work):
//
// - POST /api/notices: a program on this machine sends a notice (contracts/notice.schema.json).
// - GET /api/notices: the notice log, newest first.
// - POST /api/ominull/push: the OmniNull hub sends notices and Status rows. It names itself with
//   X-API-Key, checked against the sha256 hashes in the keys file (the hub's own scheme for its
//   callers), and is taken only straight on loopback or on the private LAN door
//   (AICO_OMINULL_LISTEN), never through the public host.
// - The outbox runs every pass and on each new phone notice, and writes its Status row.
// - Needs you: notices that ask something and failing Status rows become Tether asks; the owner's
//   "That was me" goes back to the hub's verdict route.

import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import {
  type AnsweredAsk,
  type AskPort,
  FcmSender,
  NeedsYou,
  NoticeError,
  Notifier,
  NotifyStore,
  notifyDbPath,
  Outbox,
  parseNotice,
  type VerdictPort,
} from '@aico/notify'
import { parseRow, RowError, type StatusRow, type StatusStore } from '@aico/status'
import { type TetherClient, TetherError } from '@aico/tether-client'
import type { NotifyConfig } from './config'
import { fromThisMachine } from './guard'
import { type RequestContext, Router } from './http'
import { HttpError } from './tether'

/** The one Tether call notify makes. */
type TetherRequest = Pick<TetherClient, 'request'>

const MAX_PER_PUSH = 50
const VERDICT_ROUTE = '/api/v1/integrations/nightshift/alerts/verdict'
const VERDICT_TIMEOUT_MS = 10_000
const RELAY_KEY = /^nsa_\S{64}$/

// -- Tether asks ------------------------------------------------------------------

export function tetherAsks(tether: TetherRequest): AskPort {
  return {
    async create(ask) {
      const { body } = await tether.request<{ id?: unknown }>('POST', '/v1/asks', {
        ...ask,
        blocking: false,
      })
      if (typeof body?.id !== 'string') throw new Error('Tether answered without an ask id')
      return body.id
    },
    async close(id, how) {
      try {
        await tether.request('POST', `/v1/asks/${encodeURIComponent(id)}/${how}`)
      } catch (error) {
        // Closed already (409) or gone (404): nothing left to close.
        if (!(error instanceof TetherError && (error.status === 409 || error.status === 404)))
          throw error
      }
    },
  }
}

/** The ask an `asks.changed` event carries, as Needs you reads it; null when it is not one. */
export function changedAsk(data: unknown): AnsweredAsk | null {
  const ask = (data as { ask?: Record<string, unknown> } | null)?.ask
  if (!ask || typeof ask.id !== 'string' || typeof ask.state !== 'string') return null
  return {
    id: ask.id,
    state: ask.state,
    answer: typeof ask.answer === 'string' ? ask.answer : null,
  }
}

// -- The hub ------------------------------------------------------------------------

/** The hub's base URL and CA file from the site file's `ominull` ingest source. */
export function hubSource(siteFile: string): { base: string; ca: string } {
  const site = JSON.parse(readFileSync(siteFile, 'utf8'))
  const sources = (site?.config?.ingest ?? site?.ingest ?? {}).sources ?? []
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source?.name !== 'ominull' || typeof source.url !== 'string') continue
    const url = new URL(source.url)
    if (url.protocol === 'https:' && typeof source.ca_file === 'string')
      return { base: url.origin, ca: source.ca_file }
  }
  throw new Error('the site file has no https OmniNull source')
}

/** The relay key: one line in a 0600 file of this user's, never followed through a link. */
function readRelayKey(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (stat.uid !== process.getuid?.() || stat.mode & 0o077)
      throw new Error('the relay key file must be yours and mode 0600')
    const buffer = Buffer.alloc(256)
    const key = buffer.subarray(0, readSync(fd, buffer)).toString('utf8').split('\n')[0]?.trim()
    if (!key || !RELAY_KEY.test(key)) throw new Error('the relay key file holds no relay key')
    return key
  } finally {
    closeSync(fd)
  }
}

/** "That was me" to the hub: Confirm benign on the alerts; never throws, says what happened. */
export function hubVerdict(config: NotifyConfig['ominull']): VerdictPort {
  const fallback = 'choose Confirm benign in its console'
  return {
    async confirmBenign(ids) {
      let answer: { status: number; body: string }
      try {
        const { base, ca } = hubSource(config.siteFile)
        const key = readRelayKey(config.relayKeyFile)
        const payload = JSON.stringify({ ids })
        answer = await new Promise((resolve, reject) => {
          const req = httpsRequest(
            new URL(VERDICT_ROUTE, base),
            {
              method: 'POST',
              ca: readFileSync(ca),
              timeout: VERDICT_TIMEOUT_MS,
              headers: {
                'X-API-Key': key,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              },
            },
            (res) => {
              const parts: Buffer[] = []
              res.on('data', (chunk: Buffer) => parts.push(chunk))
              res.on('end', () =>
                resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString() }),
              )
              res.on('error', reject)
            },
          )
          req.on('timeout', () => req.destroy(new Error('timed out')))
          req.on('error', reject)
          req.end(payload)
        })
      } catch (error) {
        return `OmniNull not reached (${(error as Error).message}); ${fallback}.`
      }
      if (answer.status < 200 || answer.status >= 300)
        return `OmniNull refused the confirmation (${answer.status}); ${fallback}.`
      let confirmed = 0
      try {
        confirmed = Number(JSON.parse(answer.body)?.confirmed) || 0
      } catch {}
      return `OmniNull confirmed ${confirmed} alert${confirmed === 1 ? '' : 's'} benign.`
    },
  }
}

/** Whether `key` is one the keys file lists (as sha256 hex); the file is read on each push. */
export function hubKeyAccepted(key: string | undefined, keysFile: string): boolean {
  if (!key) return false
  let hashes: string[]
  try {
    const keys = JSON.parse(readFileSync(keysFile, 'utf8'))?.keys
    hashes = Array.isArray(keys)
      ? keys
          .map((entry) => String(entry?.sha256 ?? '').toLowerCase())
          .filter((h) => /^[0-9a-f]{64}$/.test(h))
      : []
  } catch {
    return false
  }
  const offered = createHash('sha256').update(key).digest()
  return hashes.some((hash) => timingSafeEqual(Buffer.from(hash, 'hex'), offered))
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const PRIVATE_PEER = /^(::ffff:)?(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}$/

/** A peer on loopback or a private IPv4 network, with no proxy in between: the LAN door's callers. */
export function fromLan(req: IncomingMessage): boolean {
  const peer = req.socket.remoteAddress ?? ''
  if (!LOOPBACK.has(peer) && !PRIVATE_PEER.test(peer)) return false
  return !['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'cf-connecting-ip'].some(
    (name) => req.headers[name] !== undefined,
  )
}

function list(value: unknown, field: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_PER_PUSH)
    throw new HttpError(422, `${field}: a list of at most ${MAX_PER_PUSH}`)
  return value
}

// -- Wiring -------------------------------------------------------------------------

export interface NotifyDeps {
  config: NotifyConfig
  dataDir: string
  publicHost: string | null
  machine: string
  status: StatusStore
  tether: TetherRequest
}

export class NotifyHub {
  readonly store: NotifyStore
  readonly outbox: Outbox
  readonly needsYou: NeedsYou
  readonly notifier: Notifier
  private timer: NodeJS.Timeout | null = null
  private door: Server | null = null

  constructor(private readonly deps: NotifyDeps) {
    const { config } = deps
    this.store = new NotifyStore(notifyDbPath(deps.dataDir))
    const sender = new FcmSender({
      tokenFile: config.fcmTokenFile,
      devicesFile: config.devicesFile,
    })
    this.outbox = new Outbox({ store: this.store, sender, publicHost: deps.publicHost })
    this.needsYou = new NeedsYou({
      store: this.store,
      asks: tetherAsks(deps.tether),
      verdict: hubVerdict(config.ominull),
    })
    this.notifier = new Notifier({
      store: this.store,
      sender,
      outbox: this.outbox,
      needsYou: this.needsYou,
    })
  }

  /** Recovers rows a stopped process left mid-send, then runs the outbox every pass. */
  start(): void {
    const recovered = this.outbox.recover()
    if (recovered)
      console.log(`[notify] ${recovered} send(s) left unfinished at the last stop, not resent`)
    const pass = () => {
      this.outbox
        .kick()
        .catch((error) => console.error('[notify] outbox pass failed:', error))
        .finally(() =>
          this.writeRows([this.outbox.statusRow(this.deps.machine, this.deps.config.passMs)]),
        )
    }
    pass()
    this.timer = setInterval(pass, this.deps.config.passMs)
    this.timer.unref()
    const listen = this.deps.config.ominull.listen
    if (listen) {
      const router = new Router()
      router.on('POST', '/api/ominull/push', (ctx) => this.hubPush(ctx, fromLan))
      this.door = createServer((req, res) => {
        router.handle(req, res, new URL(req.url ?? '/', 'http://door')).then((handled) => {
          if (!handled) res.writeHead(404).end()
        })
      })
      this.door.listen(listen.port, listen.host, () =>
        console.log(`[notify] OmniNull door on ${listen.host}:${listen.port}`),
      )
    }
  }

  /** Rows written to Status (here or by a program on this machine): Needs you looks at them. */
  rowsWritten(rows: readonly StatusRow[]): void {
    this.needsYou
      .rowsWritten(rows)
      .catch((error) =>
        console.error('[notify] Needs you on rows failed:', (error as Error).message),
      )
  }

  rowRemoved(id: string): void {
    this.needsYou
      .rowRemoved(id)
      .catch((error) =>
        console.error('[notify] Needs you on a row failed:', (error as Error).message),
      )
  }

  /** An `asks.changed` event from Tether. */
  async askChanged(data: unknown): Promise<void> {
    const ask = changedAsk(data)
    if (ask) await this.needsYou.askChanged(ask)
  }

  private writeRows(rows: StatusRow[]): void {
    try {
      this.deps.status.upsert(rows)
      this.rowsWritten(rows)
    } catch (error) {
      console.error('[notify] Status row failed:', error)
    }
  }

  register(router: Router): void {
    router.on('POST', '/api/notices', async (ctx) => {
      if (!fromThisMachine(ctx.req))
        throw new HttpError(403, 'Notices are sent only by programs on this machine (loopback)')
      return this.receive(await ctx.body(), 'local')
    })
    router.on('GET', '/api/notices', (ctx) => {
      const limit = Math.min(Math.max(Number(ctx.query.get('limit')) || 50, 1), 500)
      return { items: this.store.list(limit) }
    })
    router.on('POST', '/api/ominull/push', (ctx) => this.hubPush(ctx, fromThisMachine))
  }

  private receive(body: unknown, via: 'local' | 'ominull') {
    try {
      return this.notifier.receive(body, via)
    } catch (error) {
      if (error instanceof NoticeError) throw new HttpError(422, `${error.field}: ${error.message}`)
      throw error
    }
  }

  /** `{notices?: [...], rows?: [...]}` from the hub: all checked first, then all taken. */
  private async hubPush(ctx: RequestContext, door: (req: IncomingMessage) => boolean) {
    if (!door(ctx.req))
      throw new HttpError(403, 'The OmniNull door is on loopback and the LAN only')
    const key = ctx.req.headers['x-api-key']
    if (
      !hubKeyAccepted(typeof key === 'string' ? key : undefined, this.deps.config.ominull.keysFile)
    )
      throw new HttpError(401, 'Unknown key')
    const body = (await ctx.body()) as { notices?: unknown; rows?: unknown } | undefined
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new HttpError(422, 'Send {notices: [...], rows: [...]}')
    const notices = list(body.notices, 'notices')
    const rows = list(body.rows, 'rows').map((item, index) => {
      try {
        const row = parseRow(item)
        if (!row.id.startsWith('ominull')) throw new RowError('id', 'starts with ominull')
        return row
      } catch (error) {
        if (error instanceof RowError)
          throw new HttpError(422, `rows[${index}].${error.field}: ${error.message}`)
        throw error
      }
    })
    notices.forEach((notice, index) => {
      try {
        if (parseNotice(notice).source !== 'ominull') throw new NoticeError('source', 'ominull')
      } catch (error) {
        if (error instanceof NoticeError)
          throw new HttpError(422, `notices[${index}].${error.field}: ${error.message}`)
        throw error
      }
    })
    if (rows.length) this.writeRows(rows)
    const taken = notices.map((notice) => this.notifier.receive(notice, 'ominull'))
    return { notices: taken, rows: rows.length }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.door?.close()
    this.store.close()
  }
}
