// Per-delivery inventory and evidence of use. No transcript text is retained:
// only item ids and the marker that matched. Missing evidence stays unknown.
import config from '../data/cost.json' with { type: 'json' }
import { type Database, json } from './db'

export const COST = config
export const estimatedTokens = (bytes: number) => Math.ceil(bytes / config.bytesPerToken)
/** The environment keeps Tether's legacy internal id; its API takes the widget id. */
export const contextSessionId = (session: string | null) =>
  session?.replace(/^aico-widget-/, '') ?? null
export function bindContextSession(
  db: Database,
  tool: string,
  session: string,
  nativeId: string,
): void {
  db.prepare(`INSERT INTO context_observations (delivery_id, observed_at, complete, source)
    SELECT id, at, 0, ? FROM deliveries WHERE tool = ? AND session IN (?, ?) ORDER BY id DESC LIMIT 1
    ON CONFLICT(delivery_id) DO UPDATE SET source = excluded.source, complete = 0`).run(
    `${tool}:${nativeId}`,
    tool,
    session,
    contextSessionId(session),
  )
}
export type ItemType = 'prompt' | 'memory' | 'skill' | 'rule' | 'file' | 'computed'
export interface InventoryItem {
  id: string
  title: string
  type: ItemType
  bytes: number
  tokens: number
  cut: boolean
  use: 'used' | 'unused' | 'unknown'
  observedSessions: number
  hash: string | null
}
export interface CostDelivery {
  id: number
  at: string
  tool: string
  role: string | null
  project: string | null
  session: string | null
  bytes: number
  tokens: number
  budget: number | null
  missing: { id: string; reason: string }[]
  observed: boolean
  items: InventoryItem[]
}
interface DeliveryRow extends Omit<CostDelivery, 'tokens' | 'items' | 'missing' | 'observed'> {
  missing: string
}
interface ItemRow {
  item: string
  title: string | null
  item_type: ItemType | null
  bytes: number
  cut: number
  kind: string
  content_hash: string | null
}
export const itemType = (id: string, kind: string): ItemType =>
  id.startsWith('prompt:')
    ? 'prompt'
    : id.startsWith('memory:')
      ? 'memory'
      : id.startsWith('skill:')
        ? 'skill'
        : id.startsWith('file:')
          ? 'file'
          : id.startsWith('rule:') || kind === 'guardrail'
            ? 'rule'
            : 'computed'

/** Same specificity as Agent Hub: role, lane group, harness, then global. */
export function tokenBudget(db: Database, tool: string, role: string | null): number | null {
  const harnesses = [tool, ...(tool === 'claude-code' ? ['claude'] : []), '*']
  const roles = [role ?? 'unknown']
  if (
    role &&
    !['blank', 'coordinator', 'unknown'].includes(role) &&
    !/^(subagent:|agent:|exec:)/.test(role)
  )
    roles.push('lane')
  const rows = db
    .prepare('SELECT harness, role, warn_tokens FROM context_budgets')
    .all() as unknown as { harness: string; role: string; warn_tokens: number }[]
  for (const [h, r] of [
    ...harnesses.flatMap((h) => roles.map((r) => [h, r])),
    ...harnesses.map((h) => [h, '*']),
  ]) {
    const row = rows.find((row) => row.harness === h && row.role === r)
    if (row) return row.warn_tokens
  }
  return null
}

/** One sentence, included in the delivery, naming its biggest loaded items. */
export function budgetHint(
  db: Database,
  delivery: {
    tool: string
    role: string | null
    bytes: number
    sections: { items: { bytes: number; id: string; title?: string }[] }[]
  },
): string | null {
  const budget = tokenBudget(db, delivery.tool, delivery.role)
  if (budget === null || estimatedTokens(delivery.bytes) <= budget) return null
  const biggest = delivery.sections
    .flatMap((s) => s.items.map((item) => ({ ...item, title: item.title ?? item.id })))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, config.biggestItems)
  return `Context is about ${estimatedTokens(delivery.bytes).toLocaleString('en-US')} tokens (budget ${budget.toLocaleString('en-US')}); biggest: ${biggest.map((i) => `${i.title.replace(/[\r\n]+/g, ' ')} (~${estimatedTokens(i.bytes).toLocaleString('en-US')})`).join(', ')}.`
}

/** Recent rows only, excluding projects this observer must never read. */
export function recentDeliveries(db: Database, now = new Date()): CostDelivery[] {
  const since = new Date(now.getTime() - config.recentDays * 86400_000).toISOString()
  const rows = db
    .prepare(`SELECT * FROM deliveries WHERE at >= ? AND at <= ?
    AND coalesce(project, '') NOT IN (SELECT value FROM json_each(?)) ORDER BY at DESC, id DESC`)
    .all(
      since,
      now.toISOString(),
      JSON.stringify(config.excludedProjects),
    ) as unknown as DeliveryRow[]
  const allItems = db.prepare(
    'SELECT * FROM delivery_items WHERE delivery_id = ? ORDER BY position',
  )
  const observation = db.prepare('SELECT complete FROM context_observations WHERE delivery_id = ?')
  const used = db.prepare('SELECT item FROM context_uses WHERE delivery_id = ?')
  const result = rows.map((row): CostDelivery => {
    const uses = new Set((used.all(row.id) as { item: string }[]).map((u) => u.item))
    const complete = (observation.get(row.id) as { complete: number } | undefined)?.complete === 1
    return {
      ...row,
      session: contextSessionId(row.session),
      tokens: estimatedTokens(row.bytes),
      budget: tokenBudget(db, row.tool, row.role),
      missing: json(row.missing, []),
      observed: complete,
      items: (allItems.all(row.id) as unknown as ItemRow[]).map((i) => ({
        id: i.item,
        title: i.title ?? i.item,
        type: i.item_type ?? itemType(i.item, i.kind),
        bytes: i.bytes,
        tokens: estimatedTokens(i.bytes),
        cut: Boolean(i.cut),
        use: uses.has(i.item) ? 'used' : 'unknown',
        observedSessions: 0,
        hash: i.content_hash,
      })),
    }
  })
  // Each session counts once, even if a hook delivered again. Keep role/project/tool
  // boundaries: use in another role cannot hide a candidate in this one.
  const groups = new Map<
    string,
    { items: InventoryItem[]; sessions: Set<string>; complete: boolean; used: boolean }
  >()
  for (const delivery of result)
    for (const item of delivery.items) {
      if (item.cut || item.type === 'computed' || !item.hash) continue
      const key = JSON.stringify([
        delivery.tool,
        delivery.role,
        delivery.project,
        item.id,
        item.hash,
      ])
      const stats = groups.get(key) ?? {
        items: [],
        sessions: new Set<string>(),
        complete: true,
        used: false,
      }
      stats.items.push(item)
      if (delivery.observed && delivery.session) stats.sessions.add(delivery.session)
      stats.complete &&= delivery.observed
      stats.used ||= item.use === 'used'
      groups.set(key, stats)
    }
  for (const stats of groups.values())
    for (const item of stats.items) {
      item.observedSessions = stats.sessions.size
      item.use = stats.used
        ? 'used'
        : stats.complete && stats.sessions.size >= config.minObservedSessions
          ? 'unused'
          : 'unknown'
    }
  return result
}

export interface UseEvent {
  role: string
  kind: string
  text: string
  at: number | null
  tool?: string
}
/** Explicit memory citations, prompt identifiers, or actual file/skill load calls.
 * User/system/tool-result text never counts as evidence that the agent used it. */
export function observeDelivery(
  db: Database,
  delivery: CostDelivery,
  events: UseEvent[],
  complete: boolean,
  source: string,
  now = new Date(),
): void {
  const mark = db.prepare(
    'INSERT OR IGNORE INTO context_uses (delivery_id, item, at, evidence) VALUES (?, ?, ?, ?)',
  )
  for (const item of delivery.items.filter((i) => !i.cut && i.type !== 'computed')) {
    const event = events.find((event) => {
      if (event.role !== 'assistant') return false
      if (item.type === 'memory') {
        const id = item.id.slice(7)
        return [id, id.slice(0, 8)].some(
          (id) => event.text.includes(`[M:${id}]`) || event.text.includes(`[G:${id}]`),
        )
      }
      if (item.type === 'prompt' || item.type === 'rule') return event.text.includes(item.id)
      return (
        event.kind === 'tool_call' &&
        /read|load|skill|exec|bash/i.test(event.tool ?? '') &&
        event.text.includes(item.id.slice(item.id.indexOf(':') + 1))
      )
    })
    if (event) mark.run(delivery.id, item.id, now.toISOString(), `${event.kind}:${item.type}`)
  }
  db.prepare(`INSERT INTO context_observations (delivery_id, observed_at, complete, source) VALUES (?, ?, ?, ?)
    ON CONFLICT(delivery_id) DO UPDATE SET observed_at = excluded.observed_at, complete = excluded.complete, source = excluded.source`).run(
    delivery.id,
    now.toISOString(),
    complete ? 1 : 0,
    source,
  )
}

export function unusedItems(
  deliveries: CostDelivery[],
): { title: string; id: string; tool: string; role: string | null; project: string | null }[] {
  const found = new Map<string, ReturnType<typeof unusedItems>[number]>()
  const latest = new Map<string, CostDelivery>()
  for (const d of deliveries) {
    const key = JSON.stringify([d.tool, d.role, d.project])
    const before = latest.get(key)
    if (!before || d.at > before.at || (d.at === before.at && d.id > before.id)) latest.set(key, d)
  }
  for (const d of latest.values())
    for (const i of d.items)
      if (i.use === 'unused')
        found.set(JSON.stringify([d.tool, d.role, d.project, i.id]), {
          title: i.title,
          id: i.id,
          tool: d.tool,
          role: d.role,
          project: d.project,
        })
  return [...found.values()]
}
