import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseNotice } from '@aico/notify'
import { type AlertBatch, type StatusRow, StatusStore } from '@aico/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Router } from './http'
import { createWebServer } from './server'
import { registerStatusActions, runRef, statusNotice } from './status-actions'
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
  ])
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
  // biome-ignore lint/suspicious/noExplicitAny: a stand-in for the Tether client
  registerStatusActions(router, { status, machine: 'here', tether: tether as any })
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

function call(method: string, path: string, body?: unknown): Promise<Answer> {
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
        },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }))
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
    const { body } = await call('GET', '/api/status/log?id=here%2Fjob')
    expect(body.ok).toBe(true)
    expect(body.ref).toBe('seq 1 300')
    expect(body.lines).toHaveLength(200)
    expect(body.lines.at(-1)).toBe('300')
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
})

describe('statusNotice', () => {
  it('is a phone alert the notice contract takes', () => {
    const shown = { ...row({}), updated_at: '', shown: 'failed' as const, shown_since: null }
    const batch: AlertBatch = {
      generated_at: '2026-11-03T12:00:00.000Z',
      changes: [{ row: shown, from: 'ok', to: 'failed' }],
      summary: {
        problems: 1,
        worst: 'failed',
        counts: { failed: 1, late: 0, unknown: 0, warn: 0 },
        quiet: 0,
        healthy: 4,
        top: [shown],
      },
    }
    const notice = parseNotice(statusNotice(batch, 'aico.example.dev'))
    expect(notice).toMatchObject({
      source: 'aico',
      severity: 'critical',
      push: 'phone',
      title: '1 failed: Job',
      body: 'Broke. 4 healthy.',
      open: 'https://aico.example.dev/status',
    })
  })
})
