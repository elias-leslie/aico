// Recent sessions for the web app: Tether reads each tool's transcripts and
// keeps the totals (docs/api-v1.md "Session history"); this route passes its
// answer on.

import type { ChatSessions } from '@aico/agent'
import { maskKnownSecrets } from '@aico/shared/secrets'
import type { HistoryEvent, HistoryEventPage, TetherClient } from '@aico/tether-client'
import type { Router } from './http'
import { tetherCall } from './lifecycle'
import { SHELL_MODE } from './sessions'
import { isTestRun } from './test-runs'
import { HttpError } from './tether'

export type LiveActivity = 'working' | 'idle' | 'blocked' | 'unknown'

/** One running session and where its newest conversation last wrote. */
export interface LiveSession {
  session: string
  /** The newest conversation Tether tied to the session, or null. */
  conversation: string | null
  activity: LiveActivity
  /** The agent's last transcript write (ms): Tether gives no other output time. null: unknown. */
  lastWriteAt: number | null
  /** An open blocking ask from this session. */
  asking: boolean
}

const ACTIVITIES: readonly string[] = ['working', 'idle', 'blocked', 'unknown']

/** Agent sessions running on this computer, with their newest conversation's last write.
 * Same set the web session list shows (Tether's live sessions), minus shells, other
 * computers' sessions and Aico chats. A conversation that cannot be read has a null write time. */
export async function liveSessions(
  tether: Pick<TetherClient, 'listSessions' | 'history'>,
): Promise<LiveSession[]> {
  const descriptors = await tether.listSessions()
  const here = descriptors.filter(
    (d) =>
      typeof d.id === 'string' &&
      !d.host &&
      d.tool !== 'aico-agent' &&
      !(d.tool === SHELL_MODE || !d.tool),
  )
  return Promise.all(
    here.map(async (d): Promise<LiveSession> => {
      const newest = await tether
        .history({ session: d.id, limit: 1 })
        .then((page) => page.items[0] ?? null)
        .catch(() => null)
      return {
        session: d.id,
        conversation: newest?.id ?? null,
        activity: ACTIVITIES.includes(d.state ?? '') ? (d.state as LiveActivity) : 'unknown',
        lastWriteAt: newest && typeof newest.endedAt === 'number' ? newest.endedAt : null,
        asking: (d.asks ?? []).some((ask) => ask.blocking === true),
      }
    }),
  )
}

/** How long the live answer is reused. */
const LIVE_CACHE_MS = 10_000

/** Recent sessions of Claude Code, Codex and Pi, from Tether's session history. */
export function registerHistoryRoutes(
  router: Router,
  tether: TetherClient,
  chats?: ChatSessions,
  now: () => number = Date.now,
) {
  let live: { at: number; answer: Promise<{ items: Omit<LiveSession, 'asking'>[] }> } | null = null
  const number = (value: string | null) => {
    if (value === null) return undefined
    if (!/^\d{1,9}$/.test(value)) throw new HttpError(400, 'Invalid request')
    return Number(value)
  }
  router.on('GET', '/api/history', async (ctx) => {
    const page = await tetherCall(() =>
      tether.history({
        limit: number(ctx.query.get('limit')),
        tool: ctx.query.get('tool') ?? undefined,
        project: ctx.query.get('project') ?? undefined,
        // The conversations one Tether session owned: its context fill, live.
        session: ctx.query.get('session') ?? undefined,
      }),
    )
    // `test`: a smoke or scratch run, so Recent can leave it out.
    return {
      ...page,
      items: page.items.map((item) => ({ ...item, test: isTestRun(item) })),
    }
  })
  // Before '/api/history/:id', which would take "live" for an id.
  router.on('GET', '/api/history/live', async () => {
    if (!live || now() - live.at >= LIVE_CACHE_MS) {
      const answer = tetherCall(() => liveSessions(tether)).then((items) => ({
        items: items.map(({ asking: _asking, ...item }) => item),
      }))
      const entry = { at: now(), answer }
      live = entry
      // A failed read is not kept: the next ask tries again.
      answer.catch(() => {
        if (live === entry) live = null
      })
    }
    return live.answer
  })
  router.on('GET', '/api/history/:id', (ctx) =>
    tetherCall(() => tether.historySession(ctx.params.id)),
  )
  router.on('GET', '/api/history/:id/events', (ctx) => {
    const options = {
      limit: number(ctx.query.get('limit')),
      before: number(ctx.query.get('before')),
      from: number(ctx.query.get('from')),
    }
    const id = ctx.params.id.startsWith('aico-agent:')
      ? ctx.params.id.slice('aico-agent:'.length)
      : null
    if (id && chats?.has(id)) {
      return chatEvents(chats.get(id).messages, options)
    }
    return tetherCall(() => tether.historyEvents(ctx.params.id, options))
  })
}

/** The chat owner retains message bodies; Tether's pushed history has totals only.
 * Project those retained messages into the existing read-only history contract. */
export function chatEvents(
  messages: ReturnType<ChatSessions['get']>['messages'],
  options: { limit?: number; before?: number; from?: number },
): HistoryEventPage {
  const all: HistoryEvent[] = []
  for (const message of messages) {
    const role =
      message.role === 'user' || message.role === 'assistant'
        ? message.role
        : message.role === 'toolResult'
          ? 'tool'
          : 'system'
    const blocks: unknown[] =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : []
    for (const value of blocks) {
      if (!value || typeof value !== 'object') continue
      const block = value as Record<string, unknown>
      let kind: HistoryEvent['kind'] = role === 'tool' ? 'tool_result' : 'text'
      let text: string
      if (block.type === 'text' && typeof block.text === 'string') text = block.text
      else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        kind = 'thinking'
        text = block.thinking
      } else if (block.type === 'toolCall' && typeof block.name === 'string') {
        kind = 'tool_call'
        text = JSON.stringify(block.arguments ?? {})
      } else if (block.type === 'image') {
        kind = 'note'
        text = 'Image attachment'
      } else continue
      all.push({
        offset: all.length,
        at: Date.parse(message.at),
        role,
        kind,
        text: maskKnownSecrets(text),
        ...(typeof block.name === 'string' ? { tool: block.name } : {}),
        ...(message.model ? { model: message.model } : {}),
      })
    }
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000))
  const end = Math.min(options.before ?? all.length, all.length)
  const start =
    options.from !== undefined ? Math.min(options.from, all.length) : Math.max(0, end - limit)
  const stop = options.from !== undefined ? Math.min(start + limit, all.length) : end
  return {
    items: all.slice(start, stop),
    older: start > 0 ? start : null,
    newer: stop < all.length ? stop : null,
    size: all.length,
  }
}
