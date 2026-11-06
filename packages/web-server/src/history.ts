// Recent sessions for the web app: Tether reads each tool's transcripts and
// keeps the totals (docs/api-v1.md "Session history"); this route passes its
// answer on.

import type { ChatSessions } from '@aico/agent'
import type { HistoryEvent, HistoryEventPage, TetherClient } from '@aico/tether-client'
import type { Router } from './http'
import { tetherCall } from './lifecycle'
import { HttpError } from './tether'

/** Recent sessions of Claude Code, Codex and Pi, from Tether's session history. */
export function registerHistoryRoutes(router: Router, tether: TetherClient, chats?: ChatSessions) {
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
        // The conversations one Tether session owned: its context fill, live.
        session: ctx.query.get('session') ?? undefined,
      }),
    ),
  )
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
        text,
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
