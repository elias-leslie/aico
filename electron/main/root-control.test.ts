import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { listenOwnerServer } from './owner-control'
import { sessionGeneration } from './owner-retirement'
import { createRootServer, guiSocketPath, parseRootCreate, rootRequestDigest } from './root-control'
import {
  initialLaunchLine,
  rootLaunchEnvironment,
  rootPromptReady,
  withRootPrompt,
} from './root-launch'
import {
  getRootRequest,
  getWidget,
  initStore,
  listWidgets,
  removeWidget,
  reserveRootRequest,
  rootRequestForWidget,
} from './store'

function present<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('fixture value missing')
  return value
}

describe('private root workload control', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'aico-root-test-'))
  const socket = join(fixture, 'aico', 'gui.sock')
  const database = join(fixture, 'catalog.db')
  let available = true
  let uncertain = false
  const running = new Set<string>()
  const launches = new Set<string>()
  const ensure = vi.fn(async (widgetId: string) => {
    launches.add(widgetId)
    if (uncertain) throw new Error('lost response')
    running.add(widgetId)
  })
  const show = vi.fn(async () => true)
  const position = vi.fn(async () => true)
  const server = createRootServer({
    available: () => available,
    validate: (input) => input.projectRoot !== '/missing',
    ensure,
    status: async (row) => (running.has(row.id) ? 'running' : 'uncertain'),
    show,
    position,
  })
  beforeAll(async () => {
    initStore(database)
    await listenOwnerServer(server, socket)
  })
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(fixture, { recursive: true, force: true })
  })

  const create = (requestId: string) => ({
    requestId,
    tool: 'codex',
    projectId: 'neri',
    projectRoot: fixture,
    initialPrompt: 'Only this independent root.',
    role: 'neri-target-root',
    leadRootReference: 'portfolio-center',
  })
  const call = (
    path: string,
    method = 'GET',
    payload?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const client = request({ socketPath: socket, path, method }, (response) => {
        let text = ''
        response.on('data', (part: Buffer) => {
          text += part.toString('utf8')
        })
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }),
        )
      })
      client.once('error', reject)
      client.end(payload === undefined ? undefined : JSON.stringify(payload))
    })

  it('uses owner-only socket permissions and a separate GUI locator', () => {
    expect(statSync(socket).mode & 0o777).toBe(0o600)
    expect(statSync(join(fixture, 'aico')).mode & 0o777).toBe(0o700)
    expect(guiSocketPath(undefined, '/run/user/1000', 1000)).toBe(
      '/run/user/1000/aico/gui-control.sock',
    )
    expect(() => guiSocketPath('/tmp/../unsafe.sock')).toThrow()
  })

  it('coalesces concurrent retries and rejects a changed request digest', async () => {
    const input = create('target-1')
    const results = await Promise.all([
      call('/v1/roots', 'POST', input),
      call('/v1/roots', 'POST', input),
    ])
    expect(results.map((result) => result.status)).toEqual([200, 200])
    expect(results[0].body).toEqual(results[1].body)
    expect(listWidgets()).toHaveLength(1)
    expect(launches.size).toBe(1)
    const before = ensure.mock.calls.length
    expect(await call('/v1/roots', 'POST', { ...input, initialPrompt: 'different' })).toEqual({
      status: 409,
      body: { error: 'request_conflict' },
    })
    expect(ensure.mock.calls).toHaveLength(before)
    expect(results[0].body).toMatchObject({
      owner: 'aico',
      tool: 'codex',
      role: 'neri-target-root',
      leadRootReference: 'portfolio-center',
      status: 'running',
    })
  })

  it('reconciles an uncertain launch and a server restart using the same durable identity', async () => {
    uncertain = true
    const input = create('target-uncertain')
    const first = await call('/v1/roots', 'POST', input)
    expect(first.status).toBe(202)
    expect(first.body.status).toBe('uncertain')
    initStore(database) // simulate reopening the catalog after Electron restart
    uncertain = false
    const retry = await call('/v1/roots', 'POST', input)
    expect(retry.status).toBe(200)
    expect(retry.body.hostIdentity).toBe(first.body.hostIdentity)
    expect(listWidgets()).toHaveLength(2)
    expect(launches.size).toBe(2)
  })

  it('assigns independent logical identities and retains End tombstones', async () => {
    const first = await call('/v1/roots/target-1')
    const second = await call('/v1/roots', 'POST', create('support-1'))
    expect(second.body.logicalSessionId).not.toBe(first.body.logicalSessionId)
    expect(second.body.logicalSessionId).toMatch(/^aico-root-/)
    expect(second.body.hostIdentity).not.toBe(first.body.hostIdentity)
    const id = second.body.hostIdentity as string
    removeWidget(id)
    const before = ensure.mock.calls.length
    const ended = await call('/v1/roots', 'POST', create('support-1'))
    expect(ended.status).toBe(200)
    expect(ended.body).toMatchObject({ hostIdentity: id, generation: null, status: 'ended' })
    expect(ensure.mock.calls).toHaveLength(before)
    expect((await call('/v1/roots')).body.roots).toHaveLength(3)
  })

  it('guards view mutation with the current generation and validates geometry', async () => {
    const root = present(getRootRequest('target-1'))
    const generation = sessionGeneration(present(getWidget(root.widgetId)))
    const path = '/v1/roots/target-1'
    expect((await call(`${path}/show`, 'POST', { generation: '0'.repeat(64) })).status).toBe(409)
    expect(show).not.toHaveBeenCalled()
    expect((await call(`${path}/show`, 'POST', { generation })).status).toBe(200)
    expect(show).toHaveBeenCalledWith(root.widgetId, generation)
    const bounds = { x: -10, y: 20, width: 900, height: 560 }
    expect((await call(`${path}/position`, 'POST', { generation, bounds })).status).toBe(200)
    expect(position).toHaveBeenCalledWith(root.widgetId, generation, bounds)
    expect(
      (await call(`${path}/position`, 'POST', { generation, bounds: { ...bounds, width: 1 } }))
        .status,
    ).toBe(400)
    expect((await call(`${path}/show`, 'POST', { generation, extra: true })).status).toBe(400)
  })

  it('explicitly reports GUI and directed-delivery unavailability without steering', async () => {
    available = false
    expect(await call('/v1/roots', 'POST', create('no-gui'))).toEqual({
      status: 503,
      body: { error: 'gui_unavailable' },
    })
    expect(getRootRequest('no-gui')).toBeUndefined()
    available = true
    expect(
      (await call('/v1/roots/target-1/send', 'POST', { message: 'never pasted' })).body,
    ).toMatchObject({ error: 'directed_delivery_unavailable' })
    expect((await call('/v1/roots')).body.directedDelivery).toMatchObject({ available: false })
    expect(
      (await call('/v1/roots', 'POST', { ...create('bad-launch'), projectRoot: '/missing' }))
        .status,
    ).toBe(422)
    expect(getRootRequest('bad-launch')).toBeUndefined()
  })

  it('rejects arbitrary command injection and canonicalizes exact launch content', () => {
    const input = create('digest')
    expect(parseRootCreate({ ...input, command: ['bash'] })).toBeNull()
    expect(parseRootCreate({ ...input, tool: 'shell' })).toBeNull()
    expect(parseRootCreate({ ...input, projectRoot: '/tmp/../other' })).toBeNull()
    expect(parseRootCreate({ ...input, initialPrompt: '\0' })).toBeNull()
    const parsed = present(parseRootCreate(input))
    expect(rootRequestDigest(parsed)).toBe(
      rootRequestDigest(present(parseRootCreate({ ...input }))),
    )
    expect(rootRequestDigest(parsed)).not.toBe(rootRequestDigest({ ...parsed, role: 'support' }))
    expect(rootRequestDigest(parsed)).not.toBe(
      rootRequestDigest({ ...parsed, leadRootReference: null }),
    )
    expect(rootRequestDigest(parsed)).not.toBe(
      rootRequestDigest({ ...parsed, facetCapsuleRef: 'capsule-2' }),
    )
  })

  it('keeps prompt bytes out of durable storage and safely passes exact launch argv', async () => {
    const root = present(getRootRequest('target-1'))
    const prompt = "-flag\n$(printf compromised)\u001b\t'quoted'\n"
    expect(rootPromptReady(root.widgetId)).toBe(false)
    const tool = {
      slug: 'fixture',
      displayName: 'fixture',
      icon: '',
      accent: '',
      enabled: true,
      order: 0,
      command: [
        '/usr/bin/node',
        '-e',
        'process.stdout.write(JSON.stringify({args:process.argv.slice(1),prompt:process.env.AICO_ROOT_INITIAL_PROMPT}))',
      ],
      processName: 'node',
    }
    await withRootPrompt(root.widgetId, prompt, async () => {
      const environment = rootLaunchEnvironment(root.widgetId)
      expect(environment.ST_SESSION_ID).toBe(root.logicalSessionId)
      expect(rootPromptReady(root.widgetId)).toBe(true)
      const line = present(initialLaunchLine(root.widgetId, tool))
      expect(line).not.toContain(prompt)
      const result = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', line], {
        env: { PATH: '/usr/bin:/bin', ...environment },
        encoding: 'utf8',
      })
      expect(JSON.parse(result)).toEqual({ args: [prompt] })
    })
    expect(rootLaunchEnvironment(root.widgetId)).toEqual({
      ST_SESSION_ID: root.logicalSessionId,
      AICO_ROOT_INITIAL_LAUNCH: '0',
      AICO_ROOT_INITIAL_PROMPT: '',
    })
    const replacementResult = execFileSync(
      '/bin/bash',
      ['--noprofile', '--norc', '-c', present(initialLaunchLine(root.widgetId, tool))],
      {
        env: { PATH: '/usr/bin:/bin', ...rootLaunchEnvironment(root.widgetId) },
        encoding: 'utf8',
      },
    )
    expect(JSON.parse(replacementResult).args).toEqual([])
    expect(rootPromptReady(root.widgetId)).toBe(false)
    const reader = new DatabaseSync(database)
    try {
      const rows = JSON.stringify(reader.prepare('SELECT * FROM root_requests').all())
      expect(rows).not.toContain('Only this independent root.')
      expect(rows).not.toContain(prompt)
      expect(rootRequestForWidget(root.widgetId)?.requestId).toBe(root.requestId)
    } finally {
      reader.close()
    }
  })

  it('rolls back a widget and reservation together on catalog conflict', () => {
    const root = present(getRootRequest('target-1'))
    const count = listWidgets().length
    expect(() =>
      reserveRootRequest(
        { ...root, requestId: 'rollback', widgetId: 'ffaabbcc' },
        'codex',
        'neri',
        fixture,
      ),
    ).toThrow()
    expect(getWidget('ffaabbcc')).toBeUndefined()
    expect(getRootRequest('rollback')).toBeUndefined()
    expect(listWidgets()).toHaveLength(count)
  })
})
