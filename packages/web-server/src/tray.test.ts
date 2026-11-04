import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NotifyStore, parseNotice } from '@aico/notify'
import { type StatusRow, StatusStore } from '@aico/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Approval, Ask } from './asks'
import { Router } from './http'
import { createWebServer } from './server'
import type { TerminalHub } from './terminal'
import { ageText, buildTray, registerTrayRoutes } from './tray'

const HOST = 'aico.example.dev'
const NOW = Date.parse('2026-11-04T12:00:00Z')
const guard = {
  allowedHostnames: ['localhost', '127.0.0.1', HOST],
  allowedOrigins: [`https://${HOST}`],
}

const row = (id: string, what: string, state: StatusRow['state'], extra = {}): StatusRow => ({
  id,
  what,
  kind: 'check',
  machine: 'here',
  state,
  meaning: `${what} says ${state}.`,
  ...extra,
})

const machine = (state: StatusRow['state'] = 'ok'): StatusRow => ({
  id: 'here/machine',
  what: 'here',
  kind: 'machine',
  machine: 'here',
  state,
  meaning: 'Up.',
  next_run: new Date(NOW + 600_000).toISOString(),
})

const ask = (id: string, fields: Partial<Ask> = {}): Ask => ({
  id,
  session: null,
  requester: 'builder',
  question: 'Ship it?',
  options: ['Yes', 'No'],
  recommended: 0,
  body: null,
  command: null,
  share: null,
  wantsFiles: null,
  files: [],
  blocking: false,
  state: 'open',
  answer: null,
  note: null,
  delivery: null,
  createdAt: NOW - 600_000,
  updatedAt: NOW - 600_000,
  answeredAt: null,
  ...fields,
})

let dir: string
let status: StatusStore
let notify: NotifyStore
let clock: number

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aico-tray-'))
  clock = NOW
  status = new StatusStore(':memory:', () => clock)
  notify = new NotifyStore(join(dir, 'notify.db'))
})

afterEach(() => {
  status.close()
  notify.close()
})

function send(fields: Record<string, unknown>, at = NOW - 60_000): string {
  const notice = parseNotice({
    v: 1,
    source: 'agent',
    title: 'Done: build',
    body: 'It built.',
    ...fields,
  })
  return notify.accept(notice, 'local', [], at).id
}

function read(
  extra: { asks?: Ask[] | null; approvals?: Approval[] | null; rowAsks?: string[] } = {},
) {
  return buildTray({
    now: NOW,
    publicHost: HOST,
    status: status.read(),
    notices: notify.list(200),
    marks: notify.readMarks(),
    asks: extra.asks === undefined ? [] : extra.asks,
    askError: extra.asks === null ? 'refused' : null,
    rowAsks: new Set(extra.rowAsks ?? []),
    approvals: extra.approvals === undefined ? [] : extra.approvals,
    // biome-ignore lint/suspicious/noExplicitAny: the tray's JSON is read by field in these tests
  }) as any
}

describe('the tray read', () => {
  it('counts the open Status problems and names them', () => {
    status.upsert([
      machine(),
      row('here/trends', 'Trends', 'failed'),
      row('here/sudo', 'Sudo use', 'warn'),
      row('here/disk', 'Disk', 'ok'),
    ])
    const tray = read()
    expect(tray.counts.needs).toBe(2)
    expect(tray.summary).toMatchObject({ needs_you: 2, snapshot: 'fresh' })
    expect(tray.needs.map((n: { title: string }) => n.title)).toEqual([
      'Trends failed',
      'Sudo use warning',
    ])
    expect(tray.needs[0]).toMatchObject({ severity: 'critical', host: 'here', unread: [] })
    expect(tray.needs[0].actions[0]).toMatchObject({ id: 'open', url: `https://${HOST}/status` })
    expect(tray.health).toBe('2 problems: Trends failed, Sudo use warning')
  })

  it('leaves out rows on a machine turned off on purpose, and says so when nothing is wrong', () => {
    status.upsert([machine('off'), row('here/trends', 'Trends', 'failed')])
    const tray = read()
    expect(tray.counts.needs).toBe(0)
    expect(tray.needs).toEqual([])
    expect(tray.health).toMatch(/^Everything is fine/)
  })

  it('says Status has no rows rather than all clear', () => {
    const tray = read()
    expect(tray.snapshot).toBe('missing')
    expect(tray.health).toBe('Status has no rows yet')
  })

  it('a problem that recovered leaves the tray', () => {
    status.upsert([machine(), row('here/trends', 'Trends', 'failed')])
    expect(read().counts.needs).toBe(1)
    status.upsert([row('here/trends', 'Trends', 'ok')])
    const tray = read()
    expect(tray.counts.needs).toBe(0)
    expect(tray.summary.needs_you).toBe(0)
  })
})

describe('agent reports', () => {
  it('lists unread warnings and criticals, not info, and counts them as new', () => {
    const warn = send({ severity: 'warning' })
    send({ severity: 'info', title: 'FYI', body: 'x' })
    const tray = read()
    expect(tray.notifications.map((n: { id: string }) => n.id)).toEqual([warn])
    expect(tray.summary.unread_rows).toEqual([[warn]])
    expect(tray.counts.unread).toBe(1)
    // info still reaches the corner card: it is in the log, as any push is
    expect(tray.read_marks.pushes).toHaveLength(2)
  })

  it('stops counting a report once it is read, or after Mark all read', () => {
    const first = send({ severity: 'warning' }, NOW - 120_000)
    const second = send({ severity: 'critical', title: 'Disk full', body: 'x' }, NOW - 30_000)
    notify.markRead([first], 'panel', NOW)
    expect(read().notifications.map((n: { id: string }) => n.id)).toEqual([second])
    notify.markAllRead(NOW - 60_000) // only what came before it
    expect(read().notifications.map((n: { id: string }) => n.id)).toEqual([second])
    notify.markAllRead(NOW)
    expect(read().notifications).toEqual([])
    expect(read().read_marks.read_all_at).toBe(NOW / 1000)
  })

  it('an alert that ended on its own leaves the tray and counts as nothing', () => {
    const alert = send({ severity: 'warning', key: 'disk:root', title: 'Disk 90%' }, NOW - 300_000)
    expect(read().notifications.map((n: { id: string }) => n.id)).toEqual([alert])
    const back = send({ severity: 'ok', key: 'disk:root', title: 'Back to normal' }, NOW - 100_000)
    const tray = read()
    expect(tray.notifications).toEqual([])
    expect(tray.summary.unread_rows).toEqual([])
    const marks = tray.read_marks.pushes.find((p: { id: string }) => p.id === alert)
    expect(marks.over_at).toBe((NOW - 100_000) / 1000)
    expect(tray.read_marks.pushes.find((p: { id: string }) => p.id === back).over_at).toBeNull()
  })

  it('a different key does not end it, and neither does another sender', () => {
    const alert = send({ severity: 'warning', key: 'disk:root' }, NOW - 300_000)
    send({ severity: 'ok', key: 'disk:home' }, NOW - 100_000)
    send({ severity: 'ok', key: 'disk:root', source: 'other' }, NOW - 90_000)
    expect(read().notifications.map((n: { id: string }) => n.id)).toEqual([alert])
  })

  it('a notice past its expiry ends on its own', () => {
    send({ severity: 'warning', expires: 60 }, NOW - 5 * 60_000)
    send({ severity: 'warning', expires: 3600, title: 'Still on', body: 'x' }, NOW - 60_000)
    expect(read().notifications.map((n: { title: string }) => n.title)).toEqual(['Still on'])
  })

  it('leaves out what asks the owner (it is a question) and the Status alert (it is the row)', () => {
    const asked = send({ severity: 'warning', kind: 'todo', title: 'Renew the cert', body: 'x' })
    notify.setAsk(asked, 'ask000000001')
    send({
      severity: 'critical',
      source: 'aico',
      kind: 'alert',
      title: 'Trends failed',
      body: 'x',
      open: `https://${HOST}/status`,
    })
    expect(read().notifications).toEqual([])
  })

  it('keeps a week of the log and no more', () => {
    send({ severity: 'warning' }, NOW - 8 * 86_400_000)
    expect(read().read_marks.pushes).toEqual([])
  })
})

describe('questions and approvals', () => {
  it('lists the open Tether asks, blocking first, but not the ask a failing row raised', () => {
    const rowAsk = ask('aaaaaaaaaaaa', { question: 'Trends failed on here' })
    const older = ask('bbbbbbbbbbbb', { createdAt: NOW - 3_600_000 })
    const blocking = ask('cccccccccccc', { blocking: true, createdAt: NOW - 60_000 })
    const closed = ask('dddddddddddd', { state: 'answered' })
    const tray = read({ asks: [rowAsk, older, blocking, closed], rowAsks: [rowAsk.id] })
    expect(tray.questions.map((q: { id: string }) => q.id)).toEqual([blocking.id, older.id])
    expect(tray.questions[0]).toMatchObject({
      key: `ask:${blocking.id}`,
      severity: 'warning',
      open: `https://${HOST}/?ask=${blocking.id}`,
      options: ['Yes', 'No'],
    })
    expect(tray.questions_unknown).toBeNull()
    // a waiting question reaches the corner once, as a push; the row's ask does not
    const pushed = tray.read_marks.pushes.map((p: { id: string }) => p.id)
    expect(pushed).toEqual([blocking.id])
  })

  it('says the question list is unknown when Tether cannot be read, never empty', () => {
    const tray = read({ asks: null })
    expect(tray.questions).toEqual([])
    expect(tray.questions_unknown).toBe("Tether can't be read (refused)")
  })

  it('shows Nightshift taps as approvals the key signs, titled for the log', () => {
    const id = 'e'.repeat(32)
    const tray = read({
      approvals: [
        {
          id,
          title: 'Open GitHub admin for 30 min?',
          url: `https://approve.example/e/${id}`,
          expiresInS: 600,
        },
        { id: 'x', title: 'Odd', url: 'https://approve.example/zz/x', expiresInS: 600 },
      ],
    })
    expect(tray.approvals).toHaveLength(1)
    expect(tray.approvals[0]).toMatchObject({ id, kind: 'elevate', left_text: '10 min left' })
    expect(tray.approvals[0].actions[0]).toMatchObject({
      id: 'approve',
      tier: 'key',
      approve: { request: id, kind: 'elevate' },
    })
    expect(tray.read_marks.pushes[0].push).toMatchObject({
      kind: 'approve',
      key: `approve:elevate:${id}`,
      title: 'Open GitHub admin for 30 min?',
    })
  })
})

describe('the tray door and the native tray agree', () => {
  const FIXTURES = resolve(__dirname, '../../../native/tray/tests/fixtures')

  /** The fixed scene the Rust tray tests read: two problems, one approval, one question, one unread report and one ended alert. */
  function scene() {
    status.upsert([
      machine(),
      row('here/trends', 'Trends', 'failed'),
      row('here/sudo', 'Sudo use', 'warn'),
      row('here/disk', 'Disk', 'ok'),
    ])
    send(
      { severity: 'critical', title: 'Disk full', body: 'The root disk is full.' },
      NOW - 600_000,
    )
    send({ severity: 'warning', key: 'vpn:down', title: 'VPN down', body: 'x' }, NOW - 900_000)
    send({ severity: 'ok', key: 'vpn:down', title: 'VPN back', body: 'x' }, NOW - 300_000)
    const id = 'e'.repeat(32)
    return read({
      asks: [ask('cccccccccccc', { blocking: true, createdAt: NOW - 60_000 })],
      approvals: [
        {
          id,
          title: 'Open GitHub admin for 30 min?',
          url: `https://approve.example/e/${id}`,
          expiresInS: 780,
        },
      ],
    })
  }

  /** The door's JSON with the notices' random ids swapped for fixed ones. */
  function fixed(tray: unknown) {
    let text = JSON.stringify(tray)
    notify.list(200).forEach((stored, i) => {
      text = text.replaceAll(stored.id, (0xa00000000000 + i).toString(16))
    })
    return JSON.parse(text)
  }

  it('the committed sample is what the door answers (UPDATE_TRAY_FIXTURE=1 rewrites it)', () => {
    const path = join(FIXTURES, 'tray-sample.json')
    const now = fixed(scene())
    if (process.env.UPDATE_TRAY_FIXTURE) writeFileSync(path, `${JSON.stringify(now, null, 1)}\n`)
    expect(now).toEqual(JSON.parse(readFileSync(path, 'utf8')))
  })

  it('every field of the shape nightshift inbox --json had is in the door, row by row', () => {
    const old = JSON.parse(readFileSync(join(FIXTURES, 'inbox-sample.json'), 'utf8'))
    const door = fixed(scene())
    for (const key of Object.keys(old)) expect(door, key).toHaveProperty(key)
    for (const section of ['needs', 'approvals', 'questions', 'notifications']) {
      expect(door[section].length, section).toBeGreaterThan(0)
      for (const sample of old[section].slice(0, 1))
        for (const field of Object.keys(sample))
          for (const row of door[section]) expect(row, `${section}.${field}`).toHaveProperty(field)
    }
    // the ended alert and the read-nothing alert: only the open report is listed
    expect(door.notifications.map((n: { title: string }) => n.title)).toEqual(['Disk full'])
    expect(door.counts.needs).toBe(2)
  })
})

it('words ages as the website does', () => {
  expect([30, 600, 7200, 3 * 86_400].map(ageText)).toEqual(['1m', '10m', '2h', '3d'])
})

describe('the routes', () => {
  let server: Server
  let port: number

  beforeEach(async () => {
    const router = new Router()
    status.upsert([machine(), row('here/trends', 'Trends', 'failed')])
    registerTrayRoutes(router, {
      status,
      notify,
      asks: { list: async () => [ask('bbbbbbbbbbbb')], approvals: async () => null },
      publicHost: HOST,
      now: () => NOW,
    })
    server = createWebServer(guard, router, {} as TerminalHub)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })

  function call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    // biome-ignore lint/suspicious/noExplicitAny: test JSON answers
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: {
            host: `127.0.0.1:${port}`,
            ...(payload ? { 'content-type': 'application/json' } : {}),
            ...headers,
          },
        },
        (res) => {
          let text = ''
          res.on('data', (chunk) => {
            text += chunk
          })
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || 'null') }),
          )
        },
      )
      req.on('error', reject)
      req.end(payload)
    })
  }

  it('serves the tray to this machine only', async () => {
    const own = await call('GET', '/api/tray')
    expect(own.status).toBe(200)
    expect(own.body.counts.needs).toBe(1)
    expect(own.body.approvals).toEqual([]) // Nightshift unreadable: no approvals listed, not a made-up list
    const proxied = await call('GET', '/api/tray', undefined, {
      host: HOST,
      'x-forwarded-for': '203.0.113.9',
    })
    expect(proxied.status).toBe(403)
  })

  it('records reads and answers cards', async () => {
    const id = send({
      severity: 'warning',
      fields: [{ label: 'Disk', value: '91%' }],
      command: 'df -h',
    })
    const card = await call('GET', `/api/tray/notice/${id}`)
    expect(card.body).toMatchObject({
      title: 'Done: build',
      commands: ['df -h'],
      details: ['Disk: 91%'],
    })
    expect(card.body.actions.map((a: { id: string }) => a.id)).toEqual(['mark-read'])
    expect((await call('GET', '/api/tray/notice/bbbbbbbbbbbb')).body.title).toBe(
      'An agent is waiting on you',
    )
    expect((await call('GET', '/api/tray/notice/000000000000')).status).toBe(404)
    expect((await call('POST', '/api/tray/seen', { ids: [id], via: 'panel' })).body).toMatchObject({
      read: 1,
    })
    expect(notify.readMarks().reads.has(id)).toBe(true)
    expect((await call('POST', '/api/tray/seen', { ids: ['../x'] })).status).toBe(422)
    expect(
      (await call('POST', '/api/tray/seen', { all: true, at: (NOW - 1000) / 1000 })).status,
    ).toBe(200)
    expect(notify.readMarks().readAllAt).toBe(NOW - 1000)
  })
})
