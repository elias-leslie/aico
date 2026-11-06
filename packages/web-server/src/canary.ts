// Secret-gated canary/honeypot receiver. The migrated registry stays private; it is never an API response.
//
// As Nightshift's canary.py did: every trip is kept in the folder's events.jsonl (newest 20000); a
// trip of the same decoy from the same source within 3 min is kept but not sent again; each decoy
// has one notice key with a 10-min cooldown, so a scan sends one alert, not one per probe; and each
// caller may post 20 events a minute (120 in all) before the hook answers 429.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { type Notifier, parseNotice } from '@aico/notify'
import { fromThisMachine } from './guard'
import { objectBody, Router, sendJson } from './http'
import { HttpError } from './tether'

interface CanaryEntry {
  token?: string
  name?: string
  path?: string
  type?: string
}
/** One trip: what the owner reads, which decoy, and from where. */
export interface CanaryTrip {
  title: string
  body: string
  /** The decoy (registry name, or the honeypot node). */
  name: string
  /** Who touched it; '' when unknown. */
  src: string
  /** A DNS token's source is the resolver, not the reader: any source counts as the same trip. */
  anySource?: boolean
}

export function describeCanary(
  payload: Record<string, unknown>,
  entries: CanaryEntry[],
): CanaryTrip | null {
  const short = (v: unknown) =>
    String(v ?? '')
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .slice(0, 160)
  if (typeof payload.token === 'string') {
    const entry = entries.find((e) => e.token === payload.token)
    if (!entry) throw new HttpError(422, 'Canary token is not registered.')
    return {
      title: `Canary tripped: ${short(entry.name)}`,
      body: `${short(entry.type)} at ${short(entry.path)}. Source ${short(payload.src_ip) || 'unknown'}.`,
      name: short(entry.name) || short(entry.token),
      src: short(payload.src_ip),
      ...(entry.type === 'dns' ? { anySource: true } : {}),
    }
  }
  let message = payload.message ?? payload
  if (typeof message === 'string') {
    try {
      message = JSON.parse(message)
    } catch {
      throw new HttpError(422, 'Honeypot message is unreadable.')
    }
  }
  const m = objectBody(message)
  if (!Number.isInteger(m.logtype)) throw new HttpError(422, 'Expected a canary or honeypot event.')
  if (Number(m.logtype) >= 1000 && Number(m.logtype) < 2000) return null
  return {
    title: `Honeypot tripped: ${short(m.node_id) || 'OpenCanary'}`,
    body: `Source ${short(m.src_host) || 'unknown'} contacted ${short(m.dst_host)}:${short(m.dst_port)} (event ${short(m.logtype)}).`,
    name: `honeypot:${short(m.node_id) || 'OpenCanary'}`,
    src: short(m.src_host),
  }
}

const PUSH_COOLDOWN_S = 600
const REPEAT_WINDOW_MS = 180_000
const RATE_WINDOW_MS = 60_000
const RATE_PER_CALLER = 20
const RATE_ALL = 120
const EVENTS_KEPT = 20_000

/** Events per caller in the current minute, and in all. */
export class CanaryLimiter {
  private hits = new Map<string, number[]>()
  private all: number[] = []

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts the event; false when the caller or all callers are over the minute's budget. */
  take(caller: string): boolean {
    const since = this.now() - RATE_WINDOW_MS
    this.all = this.all.filter((at) => at > since)
    const mine = (this.hits.get(caller) ?? []).filter((at) => at > since)
    if (mine.length >= RATE_PER_CALLER || this.all.length >= RATE_ALL) {
      this.hits.set(caller, mine)
      return false
    }
    mine.push(this.now())
    this.all.push(this.now())
    this.hits.set(caller, mine)
    if (this.hits.size > 1000)
      for (const [key, times] of this.hits)
        if (!times.some((at) => at > since)) this.hits.delete(key)
    return true
  }
}

/** The trip record in events.jsonl, newest last; trimmed to the newest 20000. */
export class CanaryEvents {
  private recent = new Map<string, number>()
  private lines: number | null = null

  constructor(
    private readonly folder: string,
    private readonly now: () => number = Date.now,
  ) {}

  private get file(): string {
    return join(this.folder, 'events.jsonl')
  }

  /** Stores the trip; true when it's a new one worth a notice (not a repeat within 3 min). */
  record(trip: CanaryTrip, source: 'canary' | 'honeypot'): { id: string; repeat: boolean } {
    const at = this.now()
    const who = trip.anySource ? '*' : trip.src
    const key = `${trip.name}\u0000${who}`
    const last = this.recent.get(key)
    const repeat = last !== undefined && at - last < REPEAT_WINDOW_MS
    if (!repeat) this.recent.set(key, at)
    for (const [k, t] of this.recent) if (at - t >= REPEAT_WINDOW_MS) this.recent.delete(k)
    const id = createHash('sha256')
      .update(
        `${source}|${trip.name}|${Math.floor(at / 1000)}|${trip.src}|${randomBytes(4).toString('hex')}`,
      )
      .digest('hex')
      .slice(0, 12)
    const line = JSON.stringify({
      id,
      at: new Date(at).toISOString(),
      source,
      canary: trip.name,
      src: trip.src,
      title: trip.title,
      body: trip.body,
      repeat,
    })
    try {
      appendFileSync(this.file, `${line}\n`, { mode: 0o600 })
      this.lines = (this.lines ?? this.count()) + 1
      if (this.lines > EVENTS_KEPT * 1.1) this.trim()
    } catch (error) {
      // The alert matters more than its record: send it anyway, and say the record failed.
      console.error('[canary] could not store the event:', (error as Error).message)
    }
    return { id, repeat }
  }

  private count(): number {
    try {
      return readFileSync(this.file, 'utf8').split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }

  private trim(): void {
    const kept = readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-EVENTS_KEPT)
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${kept.join('\n')}\n`, { mode: 0o600 })
    renameSync(temp, this.file)
    this.lines = kept.length
  }
}

export function registerCanaryRoutes(
  router: Router,
  notifier: Pick<Notifier, 'receive'>,
  folder: string,
): void {
  const limiter = new CanaryLimiter()
  const events = new CanaryEvents(folder)
  async function receive(ctx: Parameters<Parameters<Router['on']>[2]>[0], test: boolean) {
    if (test && !fromThisMachine(ctx.req))
      throw new HttpError(403, 'The drill runs on this machine.')
    if (!test) {
      if (!limiter.take(ctx.req.socket.remoteAddress ?? 'unknown'))
        throw new HttpError(429, 'Too many canary events; try again in a minute.')
      let wanted: Buffer
      try {
        wanted = Buffer.from(readFileSync(join(folder, 'hook-secret'), 'utf8').trim())
      } catch {
        throw new HttpError(503, 'Canary hook is unavailable.')
      }
      const supplied = Buffer.from(ctx.params.secret ?? '')
      if (
        wanted.length < 32 ||
        wanted.length !== supplied.length ||
        !timingSafeEqual(wanted, supplied)
      )
        throw new HttpError(403, 'Hook refused.')
    }
    const payload = objectBody(await ctx.body())
    let registry: { tokens?: CanaryEntry[] } | CanaryEntry[]
    try {
      registry = JSON.parse(readFileSync(join(folder, 'registry.json'), 'utf8'))
    } catch {
      throw new HttpError(503, 'Canary registry is unavailable.')
    }
    const raw = Array.isArray(registry) ? registry : registry?.tokens
    if (!Array.isArray(raw) || !raw.every((entry) => entry && typeof entry === 'object'))
      throw new HttpError(503, 'Canary registry is unreadable.')
    const entries = raw as CanaryEntry[]
    if (test) {
      const notice = await notifier.receive(
        {
          v: 1,
          source: 'aico',
          kind: 'alert',
          severity: 'info',
          title: 'TEST: canary hook drill',
          body: 'The Aico canary receiver accepted its test event. No decoy was touched.',
          key: `canary-drill:${Date.now()}`,
          push: 'tray',
          cooldown: 0,
        },
        'local',
      )
      return { ok: true, test, notice }
    }
    const trip = describeCanary(payload, entries)
    if (!trip) return { ok: true, ignored: 'honeypot startup event' }
    const { id, repeat } = events.record(
      trip,
      typeof payload.token === 'string' ? 'canary' : 'honeypot',
    )
    if (repeat) return { ok: true, event: id, repeat: true }
    const notice = await notifier.receive(
      {
        v: 1,
        source: 'aico',
        kind: 'alert',
        severity: 'critical',
        title: trip.title,
        body: trip.body,
        // One key per decoy: a burst of probes is one alert, counted as repeats.
        key: `canary:${createHash('sha256').update(trip.name).digest('hex').slice(0, 10)}`,
        push: 'phone',
        cooldown: PUSH_COOLDOWN_S,
      },
      'local',
    )
    return { ok: true, test, event: id, notice }
  }
  router.on('POST', '/hooks/canary/:secret', (ctx) => receive(ctx, false))
  router.on('POST', '/api/canary/drill', (ctx) => receive(ctx, true))
}

/** The former honeypot listener, serving only hooks; no pages or app API on the LAN. */
export function createCanaryServer(notifier: Pick<Notifier, 'receive'>, folder: string) {
  const hooks = new Router(64 * 1024)
  registerCanaryRoutes(hooks, notifier, folder)
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method !== 'POST' || !/^\/hooks\/canary\/[A-Za-z0-9_-]{32,128}$/.test(url.pathname)) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }
    void hooks.handle(req, res, url)
  })
}
