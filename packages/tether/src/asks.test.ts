// Owner asks: dedupe, the answer as a check-in note, the routes with a fake
// delivery, the descriptor overlay, and `tether ask` parsing.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventBus } from '@aico/session-engine/events'
import { Store } from '@aico/session-engine/store'
import { HttpError, Router, sendError } from '@aico/shared/http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askCreateBody, askerOf, askListPath, formatAsk } from './ask-cli'
import {
  type Ask,
  type AskDelivery,
  AskStore,
  aicoOrigin,
  answerNote,
  bindAskStore,
  handOffAsks,
  type NeedsYouFeed,
  questionHash,
  registerAskRoutes,
  sessionAsks,
} from './asks'
import { ShareStore } from './shares'

let dir: string
let store: Store
let events: EventBus
let server: Server
let base: string
let clock: number
let woken: { sessionId: string; note: string; id: string }[]
let cancelled: string[]
let cancelReasons: string[]
let changed: string[]
let wakeable: boolean
let feeds: NeedsYouFeed[]
let live: Set<string> | null
let launchers: Map<string, string>
let coordinators: Map<string, string>
let lost: Set<string>
let lines: { to: string; source: string | undefined; note: string }[]
let withdrawn: string[]
let delivery: AskDelivery

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-asks-'))
  store = new Store(join(dir, 'tether.db'), () => 1_000)
  events = new EventBus()
  clock = 1_000_000
  woken = []
  cancelled = []
  cancelReasons = []
  changed = []
  wakeable = true
  feeds = []
  live = null
  launchers = new Map()
  coordinators = new Map()
  lost = new Set()
  lines = []
  withdrawn = []
  delivery = {
    wake: (sessionId, note, source) => {
      if (!wakeable) return null
      lines.push({ to: sessionId, source, note })
      if (source?.startsWith('ask:') && source.split(':').length > 2) return 'f00000000000'
      const id = `00000000000${woken.length}`.slice(-12)
      woken.push({ sessionId, note, id })
      return id
    },
    receiver: (id) => live === null || live.has(id),
    launcherOf: (id) => launchers.get(id) ?? null,
    coordinatorOf: (id) => coordinators.get(id) ?? null,
    lost: (wakeId) => lost.has(wakeId),
    nameOf: (id) =>
      id === '0123abcd'
        ? 'Disk merge'
        : id === 'feedbeef'
          ? `Aico — ${'long name '.repeat(9)}`
          : null,
    cancel: (id, why) => {
      cancelled.push(id)
      cancelReasons.push(why)
    },
    withdraw: (source) => {
      withdrawn.push(source)
      return 0
    },
    noteMaxChars: () => 500,
    sessionChanged: (id) => changed.push(id),
  }
  const router = new Router()
  registerAskRoutes(router, {
    db: store.db,
    events,
    show: { retentionDays: 30 },
    delivery,
    feed: {
      write: (feed) => feeds.push(feed),
      nameOf: (id) => (id === '0123abcd' ? 'Disk merge' : null),
      origin: 'https://aico.example',
    },
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
  it('clips a long session name to fit who asked', async () => {
    const created = await ask({ session: 'feedbeef', question: 'Long name?' })
    expect(created.status).toBe(201)
    expect(Array.from(created.body.requester as string)).toHaveLength(60)
    expect(created.body.requester).toMatch(/^Aico — long name .*…$/)
  })

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
      // The session's name when it asked, so an ended session's ask still says who asked.
      requester: 'Disk merge',
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

  it('keeps the https link an ask opens and refuses any other', async () => {
    const link = 'https://jobinator.example/followups'
    const created = await ask({ requester: 'jobinator', question: 'Follow-ups due', open: link })
    expect(created.body).toMatchObject({ open: link })
    expect(((await call('GET', `/v1/asks/${created.body.id}`)).body as { open: string }).open).toBe(
      link,
    )
    expect((await ask({ requester: 'jobinator', question: 'No link' })).body.open).toBeNull()
    const noticed = await ask({
      requester: 'jobinator',
      question: 'From a notice',
      origin: 'notice',
    })
    expect(noticed.body.origin).toBe('notice')
    expect((await call('GET', `/v1/asks/${noticed.body.id}`)).body.origin).toBe('notice')
    expect((await ask({ requester: 'cron', question: 'Plain' })).body.origin).toBeNull()
    for (const origin of ['agent', '', 3])
      expect((await ask({ requester: 'x', question: 'Q?', origin })).status, String(origin)).toBe(
        400,
      )
    for (const open of ['http://x.example/a', 'javascript:alert(1)', 'https://a b', '', 7])
      expect((await ask({ requester: 'x', question: 'Q?', open })).status, String(open)).toBe(400)
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

describe('attached files', () => {
  it('links --file paths as a share and shows them as they are now', async () => {
    const plan = join(dir, 'plan.md')
    writeFileSync(plan, 'hello')
    mkdirSync(join(dir, 'shots'))
    const created = await ask({
      session: '0123abcd',
      question: 'Ship the plan?',
      attach: [plan, join(dir, 'shots')],
    })
    expect(created.status).toBe(201)
    const share = store.db
      .prepare('SELECT * FROM shares WHERE id = ?')
      .get(created.body.share as string) as {
      title: string
      session_id: string
      paths: string
    }
    expect(share).toMatchObject({ title: null, session_id: '0123abcd' })
    // An older share that took the question's words loses them.
    const titled = store.db.prepare('UPDATE shares SET title = ? WHERE id = ?')
    titled.run('Ship the plan?', created.body.share as string)
    new ShareStore(store.db, { retentionDays: 30 } as never)
    expect(
      store.db.prepare('SELECT title FROM shares WHERE id = ?').get(created.body.share as string),
    ).toMatchObject({ title: null })
    expect(JSON.parse(share.paths)).toEqual([plan, `${join(dir, 'shots')}/`])
    expect(created.body.attached).toEqual([
      { path: plan, name: 'plan.md', kind: 'file', size: 5 },
      { path: `${join(dir, 'shots')}/`, name: 'shots', kind: 'folder', size: null },
    ])
    // Re-asking with the same files keeps the one share.
    const again = await ask({
      session: '0123abcd',
      question: 'Ship the plan?',
      attach: [plan, join(dir, 'shots')],
    })
    expect(again.body.share).toBe(created.body.share)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM shares').get()).toEqual({ n: 1 })
    // Moved or deleted: the ask says so instead of a dead link.
    rmSync(plan)
    const read = await call('GET', `/v1/asks/${created.body.id}`)
    expect((read.body.attached as { kind: string }[])[0]).toMatchObject({
      name: 'plan.md',
      kind: 'missing',
      size: null,
    })
    const listed = await call('GET', '/v1/asks')
    expect((listed.body.items as { attached: unknown[] }[])[0]?.attached).toHaveLength(2)
  })

  it('announces no share for an attached file: the ask is the one place the owner sees it', async () => {
    const plan = join(dir, 'plan.md')
    writeFileSync(plan, 'hello')
    await ask({ session: '0123abcd', question: 'Ship it?', attach: [plan] })
    expect((events.replay(0) ?? []).map((event) => event.type)).not.toContain('show.requested')
  })

  it('refuses a path that is not there, a relative one, or attach with share', async () => {
    const missing = await ask({
      session: '0123abcd',
      question: 'Q?',
      attach: [join(dir, 'nope.md')],
    })
    expect(missing.status).toBe(400)
    expect(missing.body.error).toBe('invalid_path')
    for (const body of [
      { session: '0123abcd', question: 'Q?', attach: ['plan.md'] },
      { session: '0123abcd', question: 'Q?', attach: [] },
      { session: '0123abcd', question: 'Q?', attach: [dir], share: '0123456789ab' },
    ])
      expect((await ask(body)).status, JSON.stringify(body)).toBe(400)
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM asks').get()).toEqual({ n: 0 })
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
    // Each takeback says why, so a dropped answer is never silent.
    expect(cancelReasons).toEqual([`ask ${id} answered again`, `ask ${id} closed as done`])
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

describe('the tray feed', () => {
  it('counts open and blocking asks and names the newest asker, never the question', async () => {
    expect(feeds).toEqual([{ version: 1, writtenAt: clock, open: 0, blocking: 0, newest: null }])
    const first = await ask({ session: '0123abcd', question: 'Merge the disks?', blocking: true })
    clock += 1_000
    const second = await ask({ requester: 'nightly', question: 'Rotate the keys later?' })
    expect(feeds.at(-1)).toEqual({
      version: 1,
      writtenAt: clock,
      open: 2,
      blocking: 1,
      newest: {
        id: second.body.id,
        name: 'nightly',
        blocking: false,
        createdAt: clock,
        url: `https://aico.example/?ask=${second.body.id}`,
      },
    })
    await call('POST', `/v1/asks/${second.body.id}/withdraw`)
    expect(feeds.at(-1)).toMatchObject({
      open: 1,
      blocking: 1,
      newest: { id: first.body.id, name: 'Disk merge', blocking: true },
    })
    expect(JSON.stringify(feeds)).not.toContain('Merge the disks')
    await call('POST', `/v1/asks/${first.body.id}/answer`, { text: 'yes' })
    expect(feeds.at(-1)).toMatchObject({ open: 0, blocking: 0, newest: null })
  })
})

describe('aicoOrigin', () => {
  it('takes an https origin only', () => {
    expect(aicoOrigin('https://aico.example/path')).toBe('https://aico.example')
    expect(aicoOrigin('http://aico.example')).toBeNull()
    expect(aicoOrigin('nope')).toBeNull()
    expect(aicoOrigin(undefined)).toBeNull()
  })
})

const FILE_A = {
  id: 'aaaaaaaaaaaa',
  name: 'odometer.jpg',
  mime: 'image/jpeg',
  size: 2048,
  path: '/data/blobs/aa/hash-a',
  host: 'davion-sidarli',
}
const FILE_B = { ...FILE_A, id: 'bbbbbbbbbbbb', name: 'invoice.pdf', mime: 'application/pdf' }

describe('asks that want files', () => {
  const wants = (files: unknown, extra: Record<string, unknown> = {}) =>
    ask({ session: '0123abcd', question: 'Photos?', files, ...extra })

  it('records the range and hint, and shows them on the ask', async () => {
    const created = await wants({ min: 1, max: 3, hint: 'odometer, engine off' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({
      wantsFiles: { min: 1, max: 3, hint: 'odometer, engine off' },
      files: [],
    })
    const plain = await ask({ session: '0123abcd', question: 'Plain?' })
    expect(plain.body).toMatchObject({ wantsFiles: null, files: [] })
    expect((await call('GET', `/v1/asks/${created.body.id}`)).body.wantsFiles).toEqual({
      min: 1,
      max: 3,
      hint: 'odometer, engine off',
    })
  })

  it('refuses bad ranges, hints and unknown keys', async () => {
    for (const files of [
      { min: 0, max: 0, hint: null },
      { min: 3, max: 2, hint: null },
      { min: -1, max: 2, hint: null },
      { min: 0, max: 21, hint: null },
      { min: 1.5, max: 2, hint: null },
      { min: 1, max: 'x', hint: null },
      { min: 1, max: 2, hint: 'two\nlines' },
      { min: 1, max: 2, hint: 'x'.repeat(101) },
      { min: 1, max: 2, extra: true },
      [1, 2],
      3,
    ])
      expect((await wants(files)).status, JSON.stringify(files)).toBe(400)
    expect((await wants({ min: 0, max: 20 })).body).toMatchObject({
      wantsFiles: { min: 0, max: 20, hint: null },
    })
  })

  it('updates the wanted files when the same open question is asked again', async () => {
    const first = await wants({ min: 1, max: 1, hint: 'front' })
    clock += 1_000
    const again = await wants({ min: 1, max: 4, hint: 'front and back' })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({
      id: first.body.id,
      wantsFiles: { min: 1, max: 4, hint: 'front and back' },
    })
    const dropped = await ask({ session: '0123abcd', question: 'photos?' })
    expect(dropped.body).toMatchObject({ id: first.body.id, wantsFiles: null })
  })

  it('takes a files-only answer, keeps the files and puts the ids in the wake line', async () => {
    const created = await wants({ min: 1, max: 3, hint: null })
    const id = created.body.id as string
    const answered = await call('POST', `/v1/asks/${id}/answer`, { files: [FILE_A, FILE_B] })
    expect(answered.status).toBe(200)
    expect(answered.body).toMatchObject({
      state: 'answered',
      answer: null,
      note: null,
      delivery: 'wake',
      files: [FILE_A, FILE_B],
    })
    expect(woken[0]?.note).toBe(
      `Owner answered ask ${id} "Photos?": files: 2 (ids aaaaaaaaaaaa, bbbbbbbbbbbb; read: tether capture get ID) (full: tether ask get ${id}; when handled: tether ask done ${id})`,
    )
    expect((await call('GET', `/v1/asks/${id}`)).body.files).toEqual([FILE_A, FILE_B])
    // Answering again replaces the files.
    const second = await call('POST', `/v1/asks/${id}/answer`, { text: 'No files' })
    expect(second.body).toMatchObject({ answer: 'No files', files: [] })
  })

  it('takes files with a choice and a note, and a null path or host', async () => {
    const created = await wants({ min: 0, max: 2 }, { options: ['Here', 'Skip'] })
    const answered = await call('POST', `/v1/asks/${created.body.id}/answer`, {
      option: 0,
      note: 'see the second',
      files: [{ ...FILE_A, path: null, host: null }],
    })
    expect(answered.body).toMatchObject({
      answer: 'Here',
      note: 'see the second',
      files: [{ id: 'aaaaaaaaaaaa', path: null, host: null }],
    })
    expect(woken[0]?.note).toContain('"Here", note: "see the second", files: 1 (ids aaaaaaaaaaaa;')
  })

  it('refuses files on an ask that wanted none', async () => {
    const created = await ask({ session: '0123abcd', question: 'Plain?' })
    const refused = await call('POST', `/v1/asks/${created.body.id}/answer`, {
      files: [FILE_A],
    })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('files_not_requested')
    // An empty list is nothing to refuse, but it is not an answer either.
    const empty = await call('POST', `/v1/asks/${created.body.id}/answer`, { files: [] })
    expect(empty.status).toBe(400)
    expect(empty.body.error).not.toBe('files_not_requested')
  })

  it('refuses more than max, repeats, odd shapes and unknown keys', async () => {
    const created = await wants({ min: 1, max: 1 })
    const id = created.body.id
    for (const files of [
      [FILE_A, FILE_B],
      [{ ...FILE_A, id: 'nope' }],
      [{ ...FILE_A, size: -1 }],
      [{ ...FILE_A, name: 'a\nb' }],
      [{ ...FILE_A, extra: 1 }],
      'file',
    ])
      expect(
        (await call('POST', `/v1/asks/${id}/answer`, { files })).status,
        JSON.stringify(files),
      ).toBe(400)
    const wide = await wants({ min: 0, max: 2 }, { question: 'Two?' })
    expect(
      (await call('POST', `/v1/asks/${wide.body.id}/answer`, { files: [FILE_A, FILE_A] })).status,
    ).toBe(400)
  })

  it('does not enforce the minimum: the owner can answer without files', async () => {
    const created = await wants({ min: 2, max: 3 })
    const answered = await call('POST', `/v1/asks/${created.body.id}/answer`, {
      files: [FILE_A],
    })
    expect(answered.status).toBe(200)
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
    open: null,
    origin: null,
    share: null,
    wantsFiles: null,
    files: [],
    blocking: false,
    state: 'answered',
    answer: 'Yes',
    note: null,
    delivery: null,
    launcher: null,
    coordinator: null,
    answerTo: null,
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

  it('names the files, clips a long answer before them and keeps the ids', () => {
    const files = [FILE_A, FILE_B]
    const note = answerNote({ ...base, answer: null, note: 'n'.repeat(1000), files }, 300)
    expect(Array.from(note).length).toBeLessThanOrEqual(300)
    expect(note).toContain(
      '…, files: 2 (ids aaaaaaaaaaaa, bbbbbbbbbbbb; read: tether capture get ID)',
    )
    expect(note.endsWith('when handled: tether ask done abcdefabcdef)')).toBe(true)
    const many = Array.from({ length: 8 }, (_, i) => ({ ...FILE_A, id: `${i}`.repeat(12) }))
    expect(answerNote({ ...base, files: many }, 500)).toContain(
      'files: 8 (ids 000000000000, 111111111111, 222222222222, 333333333333, 444444444444 and 3 more;',
    )
    // Too little room for the ids and a lead: the whole line is clipped.
    const tight = answerNote({ ...base, files }, 190)
    expect(Array.from(tight).length).toBeLessThanOrEqual(190)
    expect(tight.endsWith('when handled: tether ask done abcdefabcdef)')).toBe(true)
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
          '--open',
          'https://x.example/a',
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
      open: 'https://x.example/a',
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
        body: 'Two steps.\nOne reboot.',
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
        '  | Two steps.',
        '  | One reboot.',
        '  answer: Yes',
        '  when handled: tether ask done abcdefabcdef',
      ].join('\n'),
    )
  })
})

describe('asks from ended lanes', () => {
  const LANE = '0123abcd'
  const COORD = '9999aaaa'

  it('tells the launcher when its lane files an ask, once', async () => {
    launchers.set(LANE, COORD)
    const created = await ask({ session: LANE, question: 'Merge the disks?' })
    const id = created.body.id as string
    expect(created.body).toMatchObject({ launcher: COORD, answerTo: LANE })
    expect(lines).toEqual([
      {
        to: COORD,
        source: `ask:${id}:filed`,
        note: `[Ask] session "Disk merge" (${LANE}) asked the owner (${id}): "Merge the disks?" · relay or close it, don't ask again: tether ask get ${id}`,
      },
    ])
    await ask({ session: LANE, question: 'Merge the disks?' })
    expect(lines).toHaveLength(1)
  })

  it("takes back the launcher's filed line once the ask is answered or closed", async () => {
    launchers.set(LANE, COORD)
    const a = (await ask({ session: LANE, question: 'One?' })).body.id as string
    const b = (await ask({ session: LANE, question: 'Two?' })).body.id as string
    const c = (await ask({ session: LANE, question: 'Three?' })).body.id as string
    await call('POST', `/v1/asks/${a}/answer`, { text: 'Yes' })
    await call('POST', `/v1/asks/${b}/done`)
    await call('POST', `/v1/asks/${c}/withdraw`)
    expect(withdrawn).toEqual([`ask:${a}:filed`, `ask:${b}:filed`, `ask:${c}:filed`])
  })

  it('answers the launcher once the asker has ended, and says so on the card', async () => {
    launchers.set(LANE, COORD)
    const created = await ask({ session: LANE, question: 'Go?' })
    const id = created.body.id as string
    live = new Set([COORD])
    expect((await call('GET', `/v1/asks/${id}`)).body.answerTo).toBe(COORD)
    const answered = await call('POST', `/v1/asks/${id}/answer`, { text: 'Yes' })
    expect(answered.body).toMatchObject({ answerTo: COORD, delivery: 'wake' })
    expect(lines.at(-1)).toEqual({
      to: COORD,
      source: `ask:${id}`,
      note: `Owner answered ask ${id} (asked by ended session "Disk merge" (${LANE})) "Go?": "Yes" (full: tether ask get ${id}; when handled: tether ask done ${id})`,
    })
  })

  it('no live asker or launcher: nobody is answered, the asker reads it', async () => {
    const created = await ask({ session: LANE, question: 'Go?' })
    live = new Set()
    expect((await call('GET', `/v1/asks/${created.body.id}`)).body.answerTo).toBeNull()
    const answered = await call('POST', `/v1/asks/${created.body.id}/answer`, { text: 'Yes' })
    expect(answered.body).toMatchObject({ answerTo: null, delivery: 'pull' })
  })

  it('an ending session hands its open asks to its launcher in one line', async () => {
    launchers.set(LANE, COORD)
    const a = await ask({ session: LANE, question: 'One?' })
    const b = await ask({ session: LANE, question: 'Two?' })
    lines = []
    live = new Set([COORD])
    const handed = handOffAsks(new AskStore(store.db), delivery, LANE, null)
    expect(handed.map((item) => item.id).sort()).toEqual([a.body.id, b.body.id].sort())
    expect(lines).toEqual([
      {
        to: COORD,
        source: `ask:handoff:${LANE}`,
        note: `[Asks handed over] session ${LANE} ended with 2 open asks to the owner (${a.body.id}, ${b.body.id}); the answers come to you · tether ask get ${a.body.id}`,
      },
    ])
    // Nothing open, or no launcher that takes lines: nothing is sent.
    expect(handOffAsks(new AskStore(store.db), delivery, '7777bbbb', null)).toEqual([])
    live = new Set()
    expect(handOffAsks(new AskStore(store.db), delivery, LANE, null)).toEqual([])
  })

  it('goes up the chain: launcher, then coordinator, as each ends', async () => {
    const MID = '5555cccc'
    launchers.set(LANE, MID)
    coordinators.set(LANE, COORD)
    const created = await ask({ session: LANE, question: 'Go?' })
    const id = created.body.id as string
    expect(created.body).toMatchObject({ launcher: MID, coordinator: COORD })
    lines = []
    // The lane ends: its launcher holds the ask.
    live = new Set([MID, COORD])
    expect(handOffAsks(new AskStore(store.db), delivery, LANE, null)).toMatchObject([
      { id, answerTo: MID },
    ])
    expect(lines.map((line) => line.to)).toEqual([MID])
    // Then the launcher ends: the coordinator holds it, told in one line.
    live = new Set([COORD])
    lines = []
    expect(handOffAsks(new AskStore(store.db), delivery, MID, null)).toMatchObject([
      { id, launcher: COORD, answerTo: COORD },
    ])
    expect(lines).toMatchObject([{ to: COORD, source: `ask:handoff:${MID}` }])
    const answered = await call('POST', `/v1/asks/${id}/answer`, { text: 'Yes' })
    expect(answered.body).toMatchObject({ answerTo: COORD, delivery: 'wake' })
  })

  it('a launcher that ends while its lane lives passes the lane on quietly', async () => {
    const MID = '5555cccc'
    launchers.set(LANE, MID)
    coordinators.set(LANE, COORD)
    const created = await ask({ session: LANE, question: 'Go?' })
    lines = []
    live = new Set([LANE, COORD])
    expect(handOffAsks(new AskStore(store.db), delivery, MID, null)).toEqual([])
    expect(lines).toEqual([])
    expect((await call('GET', `/v1/asks/${created.body.id}`)).body).toMatchObject({
      launcher: COORD,
      answerTo: LANE,
    })
  })

  it('an answer queued to an asker that ends before it lands goes up the chain', async () => {
    launchers.set(LANE, COORD)
    const created = await ask({ session: LANE, question: 'Go?' })
    const id = created.body.id as string
    const answered = await call('POST', `/v1/asks/${id}/answer`, { text: 'Yes' })
    expect(answered.body).toMatchObject({ answerTo: LANE })
    const queued = new AskStore(store.db).wakeOf(id) as string
    live = new Set([COORD])
    lines = []
    // Delivered before the end: nothing to do.
    expect(handOffAsks(new AskStore(store.db), delivery, LANE, null)).toEqual([])
    lost.add(queued)
    expect(handOffAsks(new AskStore(store.db), delivery, LANE, null)).toMatchObject([
      { id, answerTo: COORD, delivery: 'wake' },
    ])
    expect(lines).toEqual([
      {
        to: COORD,
        source: `ask:${id}`,
        note: `Owner answered ask ${id} (asked by ended session "Disk merge" (${LANE})) "Go?": "Yes" (full: tether ask get ${id}; when handled: tether ask done ${id})`,
      },
    ])
  })
})
