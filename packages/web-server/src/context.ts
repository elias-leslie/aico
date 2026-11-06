// The agents/prompts page and its nightly check. Context owns its DB and
// inventory; Tether alone reads native transcripts. We ask only for sessions
// with a delivery, and retain markers rather than conversation text.
import {
  COST,
  ContextEditError,
  type CostDelivery,
  contextCatalog,
  contextDbPath,
  type Database,
  editPrompt,
  editRole,
  observeDelivery,
  openContext,
  recentDeliveries,
  type UseEvent,
  unusedItems,
} from '@aico/context'
import type { Notifier } from '@aico/notify'
import type { StatusRow, StatusStore } from '@aico/status'
import type { TetherClient } from '@aico/tether-client'
import { fromThisMachine } from './guard'
import { objectBody, type Router } from './http'
import { HttpError } from './tether'

export interface ContextDeps {
  dataDir: string
  machine: string
  publicHost: string | null
  tether: Pick<TetherClient, 'getSession' | 'historySession' | 'historyEvents'>
  status: Pick<StatusStore, 'upsert' | 'read'>
  notifier: Pick<Notifier, 'receive'>
  now?: () => Date
}

/** Where a delivery's conversation lives in Tether's history, when that is known.
 * A hook delivery carries the tool's own id; a launch delivery carries Tether's
 * session id, linked to the tool's id only by the startup hook's bind or by a live
 * session's resumeId. Never guess: older passes saved `tool:<Tether id>` (and
 * `tool:aico-widget-…`, from before ids were normalized) when Tether no longer knew
 * the session, which matches no transcript; such a saved source is ignored. */
export function knownSource(d: CostDelivery, saved: string | undefined): string | null {
  if (d.channel.startsWith('hook:') && d.session) return `${d.tool}:${d.session}`
  if (!saved) return null
  const id = saved.slice(saved.indexOf(':') + 1)
  if (id === d.session || id.startsWith('aico-widget-')) return null
  return saved
}

/** Missing, clipped, changing or unfinished evidence leaves absence unknown. */
export async function observeContext(
  db: Database,
  tether: ContextDeps['tether'],
  now: Date,
): Promise<number> {
  const deliveries = recentDeliveries(db, now)
  const saved = db.prepare('SELECT source FROM context_observations WHERE delivery_id = ?')
  const groups = new Map<string, { source: string | null; deliveries: CostDelivery[] }>()
  for (const d of deliveries)
    if (d.session && d.tool !== 'aico-agent') {
      const source = knownSource(d, (saved.get(d.id) as { source: string } | undefined)?.source)
      const key = JSON.stringify([d.tool, d.session, source])
      const group = groups.get(key) ?? { source, deliveries: [] }
      group.deliveries.push(d)
      groups.set(key, group)
    }
  let unavailable = 0
  for (const { source, deliveries: group } of groups.values()) {
    const d = group[0] as CostDelivery
    let historyId = source
    try {
      if (!historyId) {
        let live: Awaited<ReturnType<ContextDeps['tether']['getSession']>>
        try {
          live = await tether.getSession(d.session as string)
        } catch (error) {
          if (error instanceof Error && 'status' in error && error.status === 404)
            throw new Error('session ended before its conversation was linked')
          throw error
        }
        if (live.projectId !== d.project) throw new Error('session project changed')
        if (!live.resumeId) throw new Error('native conversation unknown')
        historyId = `${d.tool}:${live.resumeId}`
      }
      const detail = await tether.historySession(historyId)
      if (detail.project !== d.project || COST.excludedProjects.includes(detail.project ?? ''))
        throw new Error('session project differs')
      let from = 0
      let size: number | null = null
      // A finished record: completed, or stopped by an interrupt or error. null: a turn runs.
      let complete = Boolean(detail.outcome)
      const events: UseEvent[] = []
      for (;;) {
        const page = await tether.historyEvents(historyId, { from, limit: 500 })
        if (size !== null && size !== page.size) complete = false
        size = page.size
        for (const event of page.items)
          if (event.role === 'assistant') {
            events.push(event)
            // Tool calls are clipped after their command or path, which is what a load
            // marker matches; clipped answer text may hide a citation.
            if ((event.kind !== 'tool_call' && event.text.endsWith('…')) || event.at === null)
              complete = false
          }
        if (page.newer === null) break
        if (page.newer <= from) throw new Error('transcript cursor did not advance')
        from = page.newer
      }
      complete &&= events.length > 0
      for (const delivery of group) {
        const scoped = events.filter((e) => e.at !== null && e.at >= Date.parse(delivery.at))
        observeDelivery(
          db,
          delivery,
          scoped,
          complete && scoped.some((e) => e.kind === 'text' && e.text.trim()),
          historyId,
          now,
        )
      }
    } catch {
      unavailable++
      // Clear a formerly complete observation when its evidence cannot be checked.
      for (const delivery of group) observeDelivery(db, delivery, [], false, historyId ?? '', now)
    }
  }
  return unavailable
}

/** Both the scheduler and manual runs replace this same Status row. */
export function nightlyRow(
  deliveries: CostDelivery[],
  unavailable: number,
  machine: string,
  now: Date,
  nextRun?: string,
): StatusRow {
  const unused = unusedItems(deliveries)
  const observed = deliveries.filter((d) => d.observed).length
  const meaning = !deliveries.length
    ? 'No recent deliveries. Usage is unknown.'
    : `${unused.length} items have no recorded use across at least ${COST.minObservedSessions} observed sessions. ${observed}/${deliveries.length} deliveries fully observed${unavailable ? `; ${unavailable} sessions unavailable` : ''}.`
  return {
    id: 'jobs/context-unused',
    what: 'Loaded context use',
    kind: 'job',
    machine,
    project: 'aico',
    // Partial coverage is normal (ended, long or running sessions) and stays in the
    // meaning; amber is for candidates, or a check that could observe nothing at all.
    state: unused.length || !deliveries.length || !observed ? 'warn' : 'ok',
    meaning,
    last_run: now.toISOString(),
    ...(nextRun ? { next_run: nextRun } : {}),
    actions: [{ kind: 'detail', ref: '/agents' }],
  }
}

export async function checkContext(db: Database, deps: ContextDeps) {
  const now = deps.now?.() ?? new Date()
  const unavailable = await observeContext(db, deps.tether, now)
  const deliveries = recentDeliveries(db, now)
  // The jobs scheduler owns the schedule, including the next run after a manual pass.
  const nextRun = deps.status.read().rows.find((r) => r.id === 'jobs/context-unused')?.next_run
  const row = nightlyRow(deliveries, unavailable, deps.machine, now, nextRun)
  deps.status.upsert([row])
  const unused = unusedItems(deliveries)
  if (unused.length)
    deps.notifier.receive(
      {
        v: 1,
        source: 'aico',
        kind: 'info',
        severity: 'warning',
        push: 'tray',
        key: 'context-unused',
        title: `${unused.length} context items have no recorded use`,
        body: unused
          .map(
            (i) => `${i.title} (${i.tool}, ${i.role ?? 'no role'}, ${i.project ?? 'no project'})`,
          )
          .join('; ')
          .slice(0, 1000),
        detail: `Last ${COST.recentDays} days; at least ${COST.minObservedSessions} fully observed sessions per item. Citations and recorded loads only; this does not measure influence on a model.`,
        ...(deps.publicHost
          ? {
              open: `https://${deps.publicHost}/agents`,
              actions: ['open', 'mark-read'],
              primary: 'open',
            }
          : { actions: ['mark-read'], primary: 'mark-read' }),
        cooldown: COST.nightly.noticeCooldownSeconds,
      },
      'local',
    )
  return { state: row.state, message: row.meaning }
}

export function registerContextRoutes(router: Router, deps: ContextDeps): void {
  const withDb = async <T>(work: (db: Database) => T | Promise<T>): Promise<T> => {
    const db = openContext(contextDbPath(deps.dataDir))
    try {
      return await work(db)
    } catch (error) {
      if (error instanceof ContextEditError) throw new HttpError(error.status, error.message)
      throw error
    } finally {
      db.close()
    }
  }
  router.on('GET', '/api/context', () =>
    withDb((db) => ({
      ...contextCatalog(db),
      deliveries: recentDeliveries(db, deps.now?.()),
      recentDays: COST.recentDays,
      minObservedSessions: COST.minObservedSessions,
      bytesPerToken: COST.bytesPerToken,
      at: (deps.now?.() ?? new Date()).toISOString(),
    })),
  )
  router.on('PUT', '/api/context/prompts/:slug', async (ctx) => {
    const body = objectBody(await ctx.body())
    return withDb((db) => {
      editPrompt(db, ctx.params.slug, body, (deps.now?.() ?? new Date()).toISOString())
      return { saved: true }
    })
  })
  router.on('PUT', '/api/context/roles/:name', async (ctx) => {
    const body = objectBody(await ctx.body())
    return withDb((db) => {
      editRole(db, ctx.params.name, body, (deps.now?.() ?? new Date()).toISOString())
      return { saved: true }
    })
  })
  router.on('POST', '/api/context/check', (ctx) => {
    if (!fromThisMachine(ctx.req)) throw new HttpError(403, 'Run this check on the Aico host.')
    return withDb((db) => checkContext(db, deps))
  })
}
