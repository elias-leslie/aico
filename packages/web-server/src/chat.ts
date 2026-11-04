// Same-origin transport for Aico's own harness. No gateway or free model catalog.
import { ChatError, type ChatSessions, HARNESS } from '@aico/agent'
import type { TetherClient } from '@aico/tether-client'
import type { Ask, Asks } from './asks'
import { API_CSP } from './guard'
import { objectBody, optionalString, RAW, type Router, requiredString } from './http'
import { HttpError } from './tether'

export const MAX_CHAT_STREAMS = 24
export function chatQuestions(asks: Ask[], id: string) {
  return asks.filter((ask) => ask.session === id && ask.state === 'open')
}
export function chatSession(chat: ReturnType<ChatSessions['summary']>, asks: Ask[]) {
  const questions = chat.state === 'ended' ? [] : chatQuestions(asks, chat.id)
  const ended = chat.state === 'ended'
  return {
    id: chat.id,
    name: chat.title,
    task: chat.title,
    user_id: null,
    project_id: null,
    working_dir: chat.cwd,
    mode: 'aico-chat',
    backend: 'aico-agent',
    display_order: 0,
    is_alive: !ended,
    created_at: new Date(chat.startedAt).toISOString(),
    last_accessed_at: new Date(chat.updatedAt).toISOString(),
    agent_state: chat.state === 'working' ? 'running' : 'stopped',
    activity: chat.state === 'working' ? 'working' : 'idle',
    activity_at: chat.updatedAt,
    activity_previous: 'idle',
    source: 'aico-chat',
    origin: 'aico',
    can_rename: true,
    can_respawn: false,
    can_end: !ended,
    is_external: false,
    asks: questions.map((ask) => ({
      id: ask.id,
      question: ask.question,
      blocking: true,
      created_at: ask.createdAt,
    })),
    chat: { ...chat, state: questions.length ? 'needs-you' : chat.state },
  }
}
export function registerChatRoutes(
  router: Router,
  chats: ChatSessions,
  asks: Asks,
  tether: TetherClient,
) {
  let streams = 0
  const handle = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      if (error instanceof ChatError) throw new HttpError(error.status, error.message)
      throw error
    }
  }
  const view = async (id: string) => {
    const chat = chats.get(id)
    const questions = chatQuestions(await asks.list(), id)
    return {
      ...chat,
      state: questions.length && chat.state !== 'ended' ? 'needs-you' : chat.state,
      questions,
    }
  }
  const preferences = (body: Record<string, unknown>) => {
    const model = optionalString(body, 'model', { max: 200 })
    const effort = optionalString(body, 'effort', { max: 20 })
    if (effort && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
      throw new HttpError(422, 'Choose a supported effort.')
    return { model, effort }
  }
  const message = (body: Record<string, unknown>) => {
    const value = requiredString(body, 'message', { max: 100_000 }).trim()
    if (!value) throw new HttpError(422, 'Write a message first.')
    return value
  }
  router.on('GET', '/api/chat/options', async (ctx) =>
    handle(async () => {
      const cwd = ctx.query.get('cwd') || ''
      return {
        defaultRole: HARNESS.chat.default_role,
        roles: cwd ? chats.choices(cwd) : [],
        projects: (await tether.projects()).map(({ id, name, root }) => ({ id, name, root })),
      }
    }),
  )
  router.on('POST', '/api/chat', async (ctx) =>
    handle(async () => {
      const body = objectBody(await ctx.body())
      return chats.start({
        role: requiredString(body, 'role', { max: 100 }),
        cwd: requiredString(body, 'cwd', { max: 4096 }),
        message: message(body),
        ...preferences(body),
      })
    }),
  )
  router.on('GET', '/api/chat/:id', (ctx) => handle(() => view(ctx.params.id)))
  router.on('POST', '/api/chat/:id/send', async (ctx) =>
    handle(async () => {
      const body = objectBody(await ctx.body())
      const { model, effort } = preferences(body)
      chats.send(ctx.params.id, message(body), model, effort)
      return view(ctx.params.id)
    }),
  )
  router.on('POST', '/api/chat/:id/stop', (ctx) => handle(() => chats.stop(ctx.params.id)))
  router.on('POST', '/api/chat/:id/resume', async (ctx) =>
    handle(async () => {
      const prefs = preferences(objectBody(await ctx.body()))
      return chats.resume(ctx.params.id, prefs.model, prefs.effort)
    }),
  )
  router.on('POST', '/api/chat/:id/branch', async (ctx) =>
    handle(async () => {
      const body = objectBody(await ctx.body())
      if (!Number.isSafeInteger(body.turn) || Number(body.turn) < 1)
        throw new HttpError(422, 'Choose a reply to branch from.')
      const from = chats.get(ctx.params.id)
      return chats.start({
        role: from.role,
        cwd: from.cwd,
        message: message(body),
        ...preferences(body),
        branch: { id: from.id, turn: Number(body.turn) },
      })
    }),
  )
  router.on('PUT', '/api/chat/:id/draft', async (ctx) =>
    handle(async () => {
      const body = objectBody(await ctx.body())
      chats.draft(ctx.params.id, requiredString(body, 'draft', { max: 100_000 }))
      return { saved: true }
    }),
  )
  router.on('POST', '/api/chat/:id/answer', async (ctx) =>
    handle(async () => {
      const body = objectBody(await ctx.body())
      const question = (await view(ctx.params.id)).questions.find((ask) => ask.id === body.ask)
      if (!question) throw new HttpError(409, 'That question is no longer waiting for an answer.')
      let full: string
      let reply: { option: number } | { text: string; note?: string }
      if (typeof body.option === 'number' && Number.isSafeInteger(body.option)) {
        const selected = question.options[body.option]
        if (!selected) throw new HttpError(422, 'Pick one of the choices.')
        full = selected
        reply = { option: body.option }
      } else {
        full = message(body)
        const summary = full.replace(/\s+/g, ' ').slice(0, 100)
        reply = { text: summary, ...(full !== summary && { note: full.slice(0, 1000) }) }
      }
      await asks.answer(question.id, reply)
      chats.answer(ctx.params.id, question.id, question.question, full)
      await asks.act(question.id, 'done')
      chats.changed(ctx.params.id)
      return view(ctx.params.id)
    }),
  )
  router.on('GET', '/api/chat/:id/stream', (ctx) =>
    handle(async () => {
      if (streams >= MAX_CHAT_STREAMS) throw new HttpError(429, 'Too many chat streams are open.')
      await view(ctx.params.id)
      const { res } = ctx
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'Content-Security-Policy': API_CSP,
        'X-Accel-Buffering': 'no',
      })
      res.write(': open\n\n')
      streams++
      let writing = false
      let pending = false
      const send = async () => {
        if (writing) {
          pending = true
          return
        }
        writing = true
        try {
          do {
            pending = false
            const data = await view(ctx.params.id)
            if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`)
          } while (pending && !res.destroyed)
        } catch {
          if (!res.destroyed) res.end()
        } finally {
          writing = false
        }
      }
      const unsubscribe = chats.subscribe(ctx.params.id, () => {
        void send()
      })
      const heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(': keep-alive\n\n')
      }, 15_000)
      res.once('close', () => {
        streams--
        clearInterval(heartbeat)
        unsubscribe()
      })
      void send()
      return RAW
    }),
  )
}
