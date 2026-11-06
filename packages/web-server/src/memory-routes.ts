// The memory section of the agents page: list or search the saved memories and
// delete one. context.db is opened per request, like the other context routes.
import {
  contextDbPath,
  type Database,
  deleteMemory,
  getMemories,
  listMemories,
  openContext,
  searchMemories,
} from '@aico/context'
import type { Router } from './http'
import { HttpError } from './tether'

export interface MemoryRouteDeps {
  dataDir: string
}

const TIERS = ['mandate', 'guardrail', 'reference', 'archive'] as const
const SCOPES = ['global', 'project', 'agent'] as const
type Tier = (typeof TIERS)[number]
type Scope = (typeof SCOPES)[number]

function pick<T extends string>(value: string | null, allowed: readonly T[], name: string) {
  if (!value) return undefined
  if (!allowed.includes(value as T)) throw new HttpError(400, `Unknown ${name}: ${value}`)
  return value as T
}

function number(value: string | null, fallback: number, max: number): number {
  if (value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new HttpError(400, 'Bad page size or offset.')
  return n
}

export function registerMemoryRoutes(router: Router, deps: MemoryRouteDeps): void {
  const withDb = async <T>(work: (db: Database) => T): Promise<T> => {
    const db = openContext(contextDbPath(deps.dataDir))
    try {
      return work(db)
    } finally {
      db.close()
    }
  }
  router.on('GET', '/api/memories', (ctx) => {
    const q = ctx.query
    const tier = pick(q.get('tier'), TIERS, 'tier')
    const scope: Scope | 'all' = pick(q.get('scope'), SCOPES, 'scope') ?? 'all'
    const limit = Math.max(1, number(q.get('limit'), 50, 300))
    const offset = number(q.get('offset'), 0, 1_000_000)
    const where: { tier?: Tier; scope: Scope | 'all' } = { scope }
    if (tier) where.tier = tier
    const text = (q.get('q') ?? '').trim()
    return withDb((db) => {
      if (text) {
        // Ranked search has no pages: ask for one more than shown to know if there is more.
        const found = searchMemories(db, text, where, { limit: limit + offset + 1 })
        const page = found.slice(offset, offset + limit)
        return {
          memories: page,
          next: found.length > offset + limit ? offset + limit : null,
          query: text,
        }
      }
      return { ...listMemories(db, where, { limit, offset }), query: '' }
    })
  })
  router.on('DELETE', '/api/memories/:id', (ctx) =>
    withDb((db) => {
      const id = ctx.params.id ?? ''
      const { found } = getMemories(db, [id])
      const memory = found.find((m) => m.id === id.toLowerCase())
      if (!memory) throw new HttpError(404, 'That memory is already gone.')
      deleteMemory(db, memory.id)
      return { deleted: true }
    }),
  )
}
