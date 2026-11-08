import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { NotifyStore, parseNotice } from '@aico/notify'
import { type AlertBatch, type ShownRow, type StatusRow, StatusStore } from '@aico/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Router } from './http'
import { createWebServer } from './server'
import {
  registerStatusActions,
  runRef,
  StatusRuns,
  statusKey,
  statusNotice,
  sustainedNotice,
} from './status-actions'
import type { TerminalHub } from './terminal'

const guard = {
  allowedHostnames: ['127.0.0.1'],
  allowedOrigins: ['http://127.0.0.1:3002'],
}
const row = (fields: Partial<StatusRow>): StatusRow => ({
  id: 'here/job',
  what: 'Job',
  kind: 'job',
  machine: 'here',
  state: 'failed',
  meaning: 'Broke.',
  ...fields,
})

let server: Server
let status: StatusStore
let port: number
let runs: StatusRuns
const roots: Record<string, unknown>[] = []

beforeEach(async () => {
  status = new StatusStore(':memory:')
  status.upsert([
    row({
      actions: [
        { kind: 'run', ref: 'echo started; echo oops >&2; exit 3' },
        { kind: 'log', ref: 'seq 1 300' },
      ],
    }),
    row({ id: 'there/job', machine: 'there', actions: [{ kind: 'run', ref: 'true' }] }),
    row({ id: 'ominull/hub', actions: [{ kind: 'run', ref: 'true' }] }),
    row({
      id: 'here/slow',
      actions: [
        { kind: 'run', ref: 'sleep 0.6' },
        { kind: 'log', ref: 'echo first; echo second; sleep 30' },
      ],
    }),
  ])
  runs = new StatusRuns()
  roots.length = 0
  const tether = {
    projects: async () => [{ id: 'aico', name: 'aico', root: '/srv/workspaces/projects/aico' }],
    request: async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/v1/tools')
        return {
          status: 200,
          body: { items: [{ slug: 'claude-code', enabled: true }], defaultSlug: 'claude-code' },
        }
      roots.push(body as Record<string, unknown>)
      return { status: 201, body: { hostIdentity: '0a1b2c3d' } }
    },
  }
  const router = new Router()
  registerStatusActions(router, {
    status,
    machine: 'here',
    // biome-ignore lint/suspicious/noExplicitAny: a stand-in for the Tether client
    tether: tether as any,
    runs,
    waitMs: { run: 200, log: 300 },
  })
  server = createWebServer(guard, router, {} as TerminalHub)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  status.close()
})

/** JSON answers are read loosely in tests. */
// biome-ignore lint/suspicious/noExplicitAny: test JSON answers
type Answer = { status: number; body: Record<string, any> }

function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
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
          resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }),
        )
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

describe('status row actions', () => {
  it('runs a row’s run ref here and says how it ended', async () => {
    const { body } = await call('POST', '/api/status/run', { id: 'here/job' })
    expect(body).toEqual({ state: 'failed', code: 3, lines: ['started', 'oops'] })
  })

  it('refuses refs of rows on another machine or from the OmniNull hub', async () => {
    for (const id of ['there/job', 'ominull/hub']) {
      const answer = await call('POST', '/api/status/run', { id })
      expect(answer.status).toBe(422)
      expect(answer.body.detail).toMatch(/run it there/)
    }
    expect((await call('POST', '/api/status/run', { id: 'none' })).status).toBe(404)
  })

  it('shows the last lines of the log ref', async () => {
    const { body } = await call('POST', '/api/status/log', { id: 'here/job' })
    expect(body.ok).toBe(true)
    expect(body.truncated).toBe(false)
    expect(body.ref).toBe('seq 1 300')
    expect(body.lines).toHaveLength(200)
    expect(body.lines.at(-1)).toBe('300')
  })

  it('reads the log only by POST, and refuses a page on another site', async () => {
    expect((await call('GET', '/api/status/log?id=here%2Fjob')).status).not.toBe(200)
    const foreign = await call(
      'POST',
      '/api/status/log',
      { id: 'here/job' },
      { origin: 'https://elsewhere.example' },
    )
    expect(foreign.status).toBe(403)
    const own = await call(
      'POST',
      '/api/status/log',
      { id: 'here/job' },
      { origin: 'http://127.0.0.1:3002' },
    )
    expect(own.status).toBe(200)
  })

  it('says when a log was still printing at the cut-off', async () => {
    const { body } = await call('POST', '/api/status/log', { id: 'here/slow' })
    expect(body).toMatchObject({ ok: true, truncated: true, lines: ['first', 'second'] })
  })

  it('runs one run of a row at a time and answers 409 while it goes', async () => {
    const first = await call('POST', '/api/status/run', { id: 'here/slow' })
    expect(first.body.state).toBe('running')
    expect(runs.ids()).toEqual(['here/slow'])
    const second = await call('POST', '/api/status/run', { id: 'here/slow' })
    expect(second.status).toBe(409)
    expect(second.body.detail).toBe('Job is still running')
    // Another row runs meanwhile.
    expect((await call('POST', '/api/status/run', { id: 'here/job' })).status).toBe(200)
    await until(() => runs.ids().length === 0)
    expect((await call('POST', '/api/status/run', { id: 'here/slow' })).status).toBe(200)
  })

  it('starts a session with the first message in the project, with the default tool', async () => {
    const { body } = await call('POST', '/api/status/look', {
      id: 'here/job',
      message: 'Find out why Job failed.',
      project: 'aico',
    })
    expect(body).toEqual({ session: '0a1b2c3d', tool: 'claude-code', project: 'aico' })
    expect(roots[0]).toMatchObject({
      tool: 'claude-code',
      projectId: 'aico',
      projectRoot: '/srv/workspaces/projects/aico',
      initialPrompt: 'Find out why Job failed.',
      workRole: 'operations',
    })
    const missing = await call('POST', '/api/status/look', {
      id: 'here/job',
      message: 'x',
      project: 'nope',
    })
    expect(missing.status).toBe(422)
  })

  it('a run that keeps going is left running', async () => {
    expect((await runRef('sleep 1; echo late', 50)).state).toBe('running')
  })

  it('a cut-off log takes everything it started with it', async () => {
    const ran = await runRef('sleep 30 & echo $!; wait', 150, { killAfterWait: true })
    expect(ran.state).toBe('running')
    const pid = Number(ran.lines[0])
    expect(pid).toBeGreaterThan(1)
    await until(() => !alive(pid))
    expect(alive(pid)).toBe(false)
  })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
}

describe('statusNotice', () => {
  const shown = (fields: Partial<StatusRow> = {}): ShownRow => ({
    ...row(fields),
    updated_at: '',
    shown: 'failed',
    shown_since: null,
  })
  const batchOf = (...rows: ShownRow[]): AlertBatch => ({
    generated_at: '2026-11-03T12:00:00.000Z',
    changes: rows.map((item) => ({ row: item, from: 'ok', to: 'failed' })),
    summary: {
      problems: rows.length,
      worst: 'failed',
      counts: { failed: rows.length, late: 0, unknown: 0, warn: 0 },
      quiet: 0,
      needs: 0,
      healthy: 4,
      top: rows,
    },
  })

  it('keeps a failed or late row on the tray: a first failure never reaches the phone', () => {
    const notice = parseNotice(statusNotice(batchOf(shown()), 'aico.example.dev', 6 * 3600))
    expect(notice).toMatchObject({
      source: 'aico',
      severity: 'critical',
      push: 'tray',
      title: '1 failed: Job',
      body: 'Broke. 4 healthy.',
      key: 'status:here/job=failed',
      cooldown: 6 * 3600,
      open: 'https://aico.example.dev/status',
    })
    expect(notice.phone_reason).toBeUndefined()
    const late = shown({ id: 'here/backup/x', kind: 'backup', project: 'aico' })
    const batch = batchOf(late)
    batch.changes = [{ row: { ...late, shown: 'late' }, from: 'ok', to: 'late' }]
    expect(parseNotice(statusNotice(batch, null, 60))).toMatchObject({
      severity: 'warning',
      push: 'tray',
    })
    const owner = shown({
      id: 'x/decide',
      actions: [{ kind: 'look', ref: 'Decide', owner_only: true }],
    })
    expect(parseNotice(statusNotice(batchOf(owner), null, 60)).push).toBe('tray')
  })

  it('sends the phone notice for a major row that stayed bad, with its reason', () => {
    const row = shown({ id: 'here/backup/x', kind: 'backup', what: 'Aico databases · Drive' })
    const since = Date.parse('2026-11-06T04:00:00Z')
    const notice = parseNotice(
      sustainedNotice({ row, major: 'data-risk', since }, 'aico.example.dev'),
    )
    expect(notice).toMatchObject({
      push: 'phone',
      severity: 'critical',
      interrupt: 'data-risk',
      key: 'status-sustained:here/backup/x',
      phone_reason: 'A backup is failing or long overdue.',
      title: 'Aico databases · Drive has stayed failed or late past its retry',
    })
  })

  it('keys a batch by what changed, hashed when the list is long', () => {
    const two = statusKey(batchOf(shown({ id: 'b/two' }), shown({ id: 'a/one' })))
    expect(two).toBe('status:a/one=failed,b/two=failed')
    const many = Array.from({ length: 20 }, (_, i) => shown({ id: `here/row-number-${i}` }))
    const key = statusKey(batchOf(...many))
    expect(key).toMatch(/^status:[0-9a-f]{32}$/)
    expect(parseNotice(statusNotice(batchOf(...many), null, 60)).key).toBe(key)
  })

  it('a row that flaps shows in the tray once per cooldown', () => {
    const notify = new NotifyStore(':memory:')
    const send = (at: number) =>
      notify.accept(parseNotice(statusNotice(batchOf(shown()), null, 3600)), 'local', [], at)
    const t0 = Date.parse('2026-11-03T12:00:00Z')
    expect(send(t0).repeat).toBe(false)
    expect(send(t0 + 25 * 60_000).repeat).toBe(true)
    expect(send(t0 + 61 * 60_000).repeat).toBe(false)
    notify.close()
  })
})
