// The routes that read a step's attempt session: only for a step of a run Tether
// lists, only the attempts of that step, and never the owner token.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IdleEvent, RunView, Session, StepView, TurnEvent } from '@agent-hub/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunTracker } from './agent-hub/runs'
import { HttpError, Router, sendError } from './http'
import { registerRunRoutes, type StepChatSource } from './runs-api'

const NOW = Date.parse('2026-10-28T12:00:00Z')

const runView = (steps: StepView[]): RunView =>
  ({
    id: 'r1',
    state: 'running',
    goal: 'Proof run',
    launched_by: 'aico-widget-c0d0ae59',
    created_at: '2026-10-28T11:00:00+00:00',
    last_activity_at: '2026-10-28T11:55:00+00:00',
    steps: steps.map((s, i) => ({ ...s, position: i })),
  }) as RunView

let server: Server
let base: string
let attached: { sessionId: string; afterSeq: number }[]
let read: string[]

beforeEach(async () => {
  attached = []
  read = []
  const tracker = new RunTracker({
    api: () =>
      ({
        list: async () => ({ runs: [{ id: 'r1', state: 'running', launched_by: 'x' }] }),
        get: async () =>
          runView([
            {
              key: 'a',
              status: 'running',
              agent_slug: 'coder',
              attempt_history: [
                { attempt: 1, session_id: 'sess-old', requested_model: 'x/m' },
                { attempt: 2, session_id: 'sess-new', requested_model: 'x/m' },
              ],
            } as StepView,
            { key: 'b', status: 'pending' } as StepView,
          ]),
      }) as never,
    launchers: () => [{ id: 'c0d0ae59', ownershipId: 'aico-widget-c0d0ae59' }],
    config: {
      pollMs: 1000,
      endedRetentionMs: 60_000,
      listLimit: 30,
      concurrency: 1,
      frontendUrl: 'https://agent.example',
    },
    dismissed: { read: () => ({}), write: () => {} },
    notify: () => {},
    now: () => NOW,
    log: () => {},
  })
  await tracker.tick()
  const chats: StepChatSource = {
    session: async (id) => {
      read.push(id)
      return { id, messages: [{ role: 'user', content: 'hi' }] } as unknown as Session
    },
    async *attach(sessionId, afterSeq) {
      attached.push({ sessionId, afterSeq })
      yield { type: 'idle', last_seq: afterSeq } as unknown as IdleEvent
      yield { type: 'done' } as unknown as TurnEvent
    },
  }
  const router = new Router()
  registerRunRoutes(router, tracker, chats)
  server = createServer((req, res) => {
    router.dispatch(req, res).catch((error) => {
      if (error instanceof HttpError) sendError(res, error)
      else res.writeHead(500).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const get = async (path: string) => {
  const answer = await fetch(`${base}${path}`)
  return { status: answer.status, text: await answer.text() }
}

describe('a step’s attempt, read only', () => {
  it('names the latest attempt session and reads its chat without any queue', async () => {
    const info = await get('/v1/runs/r1/steps/a/chat/info')
    expect(info.status).toBe(200)
    expect(JSON.parse(info.text)).toMatchObject({
      sessionId: 'sess-new',
      agentSlug: 'coder',
      requestedModel: 'x/m',
      attempt: 2,
    })
    const chat = await get('/v1/runs/r1/steps/a/chat?session=sess-new')
    expect(chat.status).toBe(200)
    expect(JSON.parse(chat.text)).toMatchObject({ session: { id: 'sess-new' }, queued: [] })
    expect(read).toEqual(['sess-new'])
  })

  it('reads an earlier attempt of the step when asked for it, and no session of another step', async () => {
    expect((await get('/v1/runs/r1/steps/a/chat?session=sess-old')).status).toBe(200)
    expect(read).toEqual(['sess-old'])
    const other = await get('/v1/runs/r1/steps/a/chat?session=somebody-elses')
    expect(other.status).toBe(404)
    expect(JSON.parse(other.text).error).toBe('no_session')
    expect(read).toEqual(['sess-old'])
  })

  it('refuses a run it does not list, a step that has no attempt yet and a bad key', async () => {
    expect((await get('/v1/runs/zzz/steps/a/chat/info')).status).toBe(404)
    const none = await get('/v1/runs/r1/steps/b/chat/info')
    expect(none.status).toBe(404)
    expect(JSON.parse(none.text).error).toBe('no_session')
    expect((await get('/v1/runs/r1/steps/..%2Fx/chat/info')).status).toBe(404)
  })

  it('streams the attempt’s events as NDJSON from the asked position', async () => {
    const answer = await get('/v1/runs/r1/steps/a/chat/stream?session=sess-new&afterSeq=7')
    expect(answer.status).toBe(200)
    const lines = answer.text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines.map((line) => line.type)).toEqual(['idle', 'done'])
    expect(attached).toEqual([{ sessionId: 'sess-new', afterSeq: 7 }])
  })
})
