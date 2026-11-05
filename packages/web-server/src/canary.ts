// Secret-gated canary/honeypot receiver. The migrated registry stays private; it is never an API response.
import { timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
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
export function describeCanary(
  payload: Record<string, unknown>,
  entries: CanaryEntry[],
): { title: string; body: string } | null {
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
  }
}

export function registerCanaryRoutes(
  router: Router,
  notifier: Pick<Notifier, 'receive'>,
  folder: string,
): void {
  async function receive(ctx: Parameters<Parameters<Router['on']>[2]>[0], test: boolean) {
    if (test && !fromThisMachine(ctx.req))
      throw new HttpError(403, 'The drill runs on this machine.')
    if (!test) {
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
    const event = test
      ? {
          title: 'TEST: canary hook drill',
          body: 'The Aico canary receiver accepted its test event. No decoy was touched.',
        }
      : describeCanary(payload, entries)
    if (!event) return { ok: true, ignored: 'honeypot startup event' }
    const result = await notifier.receive(
      {
        v: 1,
        source: 'aico',
        kind: 'alert',
        severity: test ? 'info' : 'critical',
        ...event,
        key: test ? `canary-drill:${Date.now()}` : `canary:${Date.now()}`,
        push: test ? 'tray' : 'phone',
        cooldown: 0,
      },
      'local',
    )
    return { ok: true, test, notice: result }
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
