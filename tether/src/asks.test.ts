// Owner asks: dedupe, the answer as a check-in note, the routes with a fake
// delivery, the descriptor overlay, and `tether ask` parsing.

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askCreateBody, askerOf, askListPath, formatAsk } from './ask-cli'
import {
  type Ask,
  type AskDelivery,
  answerNote,
  bindAskStore,
  questionHash,
  registerAskRoutes,
  sessionAsks,
} from './asks'
import { EventBus } from './events'
import { HttpError, Router, sendError } from './http'
import { Store } from './store'

let dir: string
let store: Store
let events: EventBus
let server: Server
let base: string
let clock: number
let woken: { sessionId: string; note: string; id: string }[]
let cancelled: string[]
let changed: string[]
let wakeable: boolean

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-asks-'))
  store = new Store(join(dir, 'tether.db'), () => 1_000)
  events = new EventBus()
  clock = 1_000_000
  woken = []
  cancelled = []
  changed = []
  wakeable = true
  const delivery: AskDelivery = {
    wake: (sessionId, note) => {
      if (!wakeable) return null
      const id = `00000000000${woken.length}`.slice(-12)
      woken.push({ sessionId, note, id })
      return id
    },
    cancel: (id) => cancelled.push(id),
    noteMaxChars: () => 500,
    sessionChanged: (id) => changed.push(id),
  }
  const router = new Router()
  registerAskRoutes(router, {
    db: store.db,
    events,
    show: { retentionDays: 30 },
    delivery,
    now: () => clock,
  })
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
  bindAskStore(null)
  await new Promise<void>((resolve) => server.close(() => resolve()))
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const ask = (body: Record<string, unknown>) => call('POST', '/v1/asks', body)
const types = () => (events.replay(0) ?? []).map((event) => event.type)

describe('POST /v1/asks', () => {
  it('records an ask with choices and announces it', async () => {
    const created = await ask({
      session: '0123abcd',
      question: 'Finish the single Linux partition?',
      options: ['Finish it now', 'Stop here'],
      recommended: 0,
      body: 'Swap becomes a file.\nOne reboot.',
      blocking: true,
    })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{12}$/),
      session: '0123abcd',
      requester: null,
      options: ['Finish it now', 'Stop here'],
      recommended: 0,
      body: 'Swap becomes a file.\nOne reboot.',
      blocking: true,
      state: 'open',
      answer: null,
      createdAt: clock,
    })
    expect(events.replay(0)?.[0]).toMatchObject({
      type: 'asks.changed',
      data: { created: true, ask: created.body },
    })
    expect(changed).toEqual(['0123abcd'])
  })

  it('updates the open ask when the same asker asks the same question again', async () => {
    const first = await ask({ session: '0123abcd', question: 'Keep the  folder?' })
    clock += 5_000
    const again = await ask({
      session: '0123abcd',
      question: 'keep the folder?',
      options: ['Keep', 'Delete'],
    })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({
      id: first.body.id,
      options: ['Keep', 'Delete'],
      updatedAt: clock,
    })
    // Another session's same question is its own ask.
    expect((await ask({ session: '99999999', question: 'Keep the folder?' })).status).toBe(201)
    expect(((await call('GET', '/v1/asks')).body.items as unknown[]).length).toBe(2)
  })

  it('hands back an answered ask instead of asking it again', async () => {
    const first = await ask({ requester: 'nightly', question: 'Run it?', options: ['Yes', 'No'] })
    await call('POST', `/v1/asks/${first.body.id}/answer`, { option: 1 })
    const again = await ask({ requester: 'nightly', question: 'Run it?' })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ id: first.body.id, state: 'answered', answer: 'No' })
  })

  it('refuses what is not one standalone line, bad choices and unknown fields', async () => {
    for (const body of [
      { session: '0123abcd', question: 'two\nlines' },
      { session: '0123abcd', question: '' },
      { session: '0123abcd', question: 'x'.repeat(201) },
      { question: 'Who asks?' },
      { session: 'nope', question: 'Q?' },
      { session: '0123abcd', question: 'Q?', options: ['a', 'a'] },
      { session: '0123abcd', question: 'Q?', options: ['a'], recommended: 1 },
      { session: '0123abcd', question: 'Q?', options: ['1', '2', '3', '4', '5', '6'] },
      { session: '0123abcd', question: 'Q?', share: '0123456789ab' },
      { session: '0123abcd', question: 'Q?', blocking: 'yes' },
      { session: '0123abcd', question: 'Q?', links: [] },
    ])
      expect((await ask(body)).status, JSON.stringify(body)).toBe(400)
  })
})

describe('answers', () => {
  it('delivers the answer to the asking session as a check-in with the question', async () => {
    const created = await ask({
      session: '0123abcd',
      question: 'Finish it?',
      options: ['Now', 'Later'],
      blocking: true,
    })
    const id = created.body.id as string
    const answered = await call('POST', `/v1/asks/${id}/answer`, {
      option: 0,
      note: 'but keep\nthe old /boot',
    })
    expect(answered.status).toBe(200)
    expect(answered.body).toMatchObject({
      state: 'answered',
      answer: 'Now',
      note: 'but keep\nthe old /boot',
      delivery: 'wake',
      answeredAt: clock,
    })
    expect(woken).toEqual([
      {
        sessionId: '0123abcd',
        id: '000000000000',
        note: `Owner answered ask ${id} "Finish it?": "Now", note: "but keep the old /boot" (full: tether ask get ${id}; when handled: tether ask done ${id})`,
      },
    ])
    // Changing the answer replaces the check-in that has not gone out yet.
    await call('POST', `/v1/asks/${id}/answer`, { text: 'Later' })
    expect(cancelled).toEqual(['000000000000'])
    expect(woken).toHaveLength(2)
    // Closing it cancels the pending one too.
    expect((await call('POST', `/v1/asks/${id}/done`)).body.state).toBe('done')
    expect(cancelled).toEqual(['000000000000', '000000000001'])
    expect((await call('POST', `/v1/asks/${id}/answer`, { option: 0 })).status).toBe(409)
  })

  it('keeps the answer for pulling when the session cannot be woken', async () => {
    wakeable = false
    const created = await ask({ session: '0123abcd', question: 'Proceed?' })
    const answered = await call('POST', `/v1/asks/${created.body.id}/answer`, { text: 'Yes' })
    expect(answered.body).toMatchObject({ answer: 'Yes', delivery: 'pull' })
    const asker = await ask({ requester: 'antigravity', question: 'Proceed?' })
    const pulled = await call('POST', `/v1/asks/${asker.body.id}/answer`, { note: 'go' })
    expect(pulled.body).toMatchObject({ answer: null, note: 'go', delivery: 'pull' })
    expect(woken).toEqual([])
    expect((await call('GET', `/v1/asks/${asker.body.id}`)).body.note).toBe('go')
  })

  it('refuses an empty answer, a choice out of range, and both a choice and a text', async () => {
    const created = await ask({ session: '0123abcd', question: 'Pick?', options: ['A'] })
    const path = `/v1/asks/${created.body.id}/answer`
    expect((await call('POST', path, {})).status).toBe(400)
    expect((await call('POST', path, { option: 1 })).status).toBe(400)
    expect((await call('POST', path, { option: 0, text: 'B' })).status).toBe(400)
    expect((await call('POST', '/v1/asks/0123456789ab/answer', { text: 'x' })).status).toBe(404)
  })

  it('withdraws, lists by asker and state, and closes idempotently', async () => {
    const a = await ask({ session: '0123abcd', question: 'One?' })
    const b = await ask({ requester: 'cron', question: 'Two?' })
    await call('POST', `/v1/asks/${a.body.id}/withdraw`)
    expect((await call('POST', `/v1/asks/${a.body.id}/withdraw`)).status).toBe(200)
    expect((await call('POST', `/v1/asks/${a.body.id}/done`)).status).toBe(409)
    const open = await call('GET', '/v1/asks?state=open,answered')
    expect((open.body.items as Ask[]).map((item) => item.id)).toEqual([b.body.id])
    const mine = await call('GET', '/v1/asks?requester=cron')
    expect((mine.body.items as Ask[]).map((item) => item.id)).toEqual([b.body.id])
    expect((await call('GET', '/v1/asks?state=bogus')).status).toBe(400)
    expect(types().filter((type) => type === 'asks.changed')).toHaveLength(3)
  })
})

describe('the descriptor overlay', () => {
  it('lists a session’s open asks only', async () => {
    const open = await ask({ session: '0123abcd', question: 'Open?', blocking: true })
    const answered = await ask({ session: '0123abcd', question: 'Answered?' })
    await call('POST', `/v1/asks/${answered.body.id}/answer`, { text: 'ok' })
    expect(sessionAsks('0123abcd')).toEqual([
      { id: open.body.id, question: 'Open?', blocking: true, createdAt: clock },
    ])
    expect(sessionAsks('99999999')).toEqual([])
  })
})

describe('answerNote', () => {
  const base: Ask = {
    id: 'abcdefabcdef',
    session: '0123abcd',
    requester: null,
    question: 'Q?',
    options: [],
    recommended: null,
    body: null,
    command: null,
    share: null,
    blocking: false,
    state: 'answered',
    answer: 'Yes',
    note: null,
    delivery: null,
    createdAt: 0,
    updatedAt: 0,
    answeredAt: 0,
  }

  it('fits the wake limit and always keeps how to read it whole', () => {
    const note = answerNote({ ...base, note: 'n'.repeat(1000) }, 200)
    expect(Array.from(note).length).toBeLessThanOrEqual(200)
    expect(note).toContain('…')
    expect(
      note.endsWith(
        '(full: tether ask get abcdefabcdef; when handled: tether ask done abcdefabcdef)',
      ),
    ).toBe(true)
    expect(answerNote(base, 500)).toBe(
      'Owner answered ask abcdefabcdef "Q?": "Yes" (full: tether ask get abcdefabcdef; when handled: tether ask done abcdefabcdef)',
    )
  })

  it('hashes the same question the same', () => {
    expect(questionHash(' Keep  it? ')).toBe(questionHash('keep it?'))
  })
})

describe('tether ask', () => {
  const env = { AICO_WIDGET_ID: 'aico-widget-0123abcd' }

  it('asks as the pane’s session, else --from, else the folder', () => {
    expect(askerOf({}, env, '/x')).toEqual({ session: '0123abcd' })
    expect(askerOf({ from: 'cron' }, {}, '/x')).toEqual({ requester: 'cron' })
    expect(askerOf({}, {}, '/srv/proj')).toEqual({ requester: 'proj' })
  })

  it('builds the create body', () => {
    expect(
      askCreateBody(
        [
          'Finish it?',
          '--option',
          'Now',
          '--option=Later',
          '--recommend',
          '1',
          '--blocking',
          '--body-file',
          '/b.md',
          '--command',
          'sudo true',
        ],
        env,
        '/x',
        () => 'body text',
      ),
    ).toEqual({
      session: '0123abcd',
      question: 'Finish it?',
      options: ['Now', 'Later'],
      recommended: 0,
      body: 'body text',
      command: 'sudo true',
      blocking: true,
    })
    expect(askCreateBody(['a', 'b'], env, '/x')).toMatch(/one argument/)
    expect(askCreateBody(['Q?', '--recommend', '2', '--option', 'A'], env, '/x')).toMatch(
      /--recommend/,
    )
    expect(askCreateBody(['Q?', '--wait'], env, '/x')).toMatch(/unknown option --wait/)
  })

  it('lists open asks, mine or all', () => {
    expect(askListPath([], env, '/x')).toBe('/v1/asks?state=open%2Canswered')
    expect(askListPath(['--mine'], env, '/x')).toBe(
      '/v1/asks?state=open%2Canswered&session=0123abcd',
    )
    expect(askListPath(['--all', '--mine', '--from', 'cron'], {}, '/x')).toBe(
      '/v1/asks?requester=cron',
    )
  })

  it('prints an answered ask with how to close it', () => {
    expect(
      formatAsk({
        id: 'abcdefabcdef',
        session: null,
        requester: 'cron',
        question: 'Run it?',
        options: ['Yes', 'No'],
        recommended: 0,
        body: null,
        command: null,
        share: null,
        blocking: true,
        state: 'answered',
        answer: 'Yes',
        note: null,
        delivery: 'pull',
      }),
    ).toBe(
      [
        'abcdefabcdef  Run it?',
        '  answered · from cron',
        '  1. Yes  (recommended)',
        '  2. No',
        '  answer: Yes',
        '  when handled: tether ask done abcdefabcdef',
      ].join('\n'),
    )
  })
})
