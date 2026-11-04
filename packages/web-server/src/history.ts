// Recent sessions for the web app: Tether reads each tool's transcripts and
// keeps the totals (docs/api-v1.md "Session history"); this route passes its
// answer on.

import type { TetherClient } from '@aico/tether-client'
import type { Router } from './http'
import { tetherCall } from './lifecycle'
import { HttpError } from './tether'

/** Recent sessions of Claude Code, Codex and Pi, from Tether's session history. */
export function registerHistoryRoutes(router: Router, tether: TetherClient) {
  const number = (value: string | null) => {
    if (value === null) return undefined
    if (!/^\d{1,9}$/.test(value)) throw new HttpError(400, 'Invalid request')
    return Number(value)
  }
  router.on('GET', '/api/history', (ctx) =>
    tetherCall(() =>
      tether.history({
        limit: number(ctx.query.get('limit')),
        tool: ctx.query.get('tool') ?? undefined,
        project: ctx.query.get('project') ?? undefined,
      }),
    ),
  )
  router.on('GET', '/api/history/:id', (ctx) =>
    tetherCall(() => tether.historySession(ctx.params.id)),
  )
  router.on('GET', '/api/history/:id/events', (ctx) =>
    tetherCall(() =>
      tether.historyEvents(ctx.params.id, {
        limit: number(ctx.query.get('limit')),
        before: number(ctx.query.get('before')),
        from: number(ctx.query.get('from')),
      }),
    ),
  )
}
