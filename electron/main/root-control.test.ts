import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { LifecycleOwnerLock, type ManagedGateState } from './lifecycle-guard'
import { listenOwnerServer } from './owner-control'
import { sessionGeneration } from './owner-retirement'
import {
  createRootServer,
  guiSocketPath,
  parseRootCreate,
  rootRequestDigest,
  widgetMutationOperation,
} from './root-control'
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
  insertWidget,
  listWidgets,
  removeWidget,
  reserveRootRequest,
  rootRequestForWidget,
  setWidgetName,
  type WidgetRow,
} from './store'
import { registerBuiltinTuis } from './tui/registry'
import { codexTui } from './tui/tuis/codex'

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
  const show = vi.fn(async (_widgetId: string, _generation: string) => true)
  const position = vi.fn(async (_widgetId: string, _generation: string, _bounds: unknown) => true)
  const title = vi.fn(async (_widgetId: string, _generation: string, _label: string) => true)
  const status = vi.fn(async (row: WidgetRow) =>
    running.has(row.id) ? ('running' as const) : ('uncertain' as const),
  )
  const server = createRootServer({
    available: () => available,
    validate: (input) => input.projectRoot !== '/missing',
    ensure,
    status,
    mutate: (widgetId, generation, mutation) =>
      mutation.kind === 'show'
        ? show(widgetId, generation)
        : mutation.kind === 'position'
          ? position(widgetId, generation, mutation.bounds)
          : title(widgetId, generation, mutation.label),
  })
  beforeAll(async () => {
    registerBuiltinTuis()
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
    encode: (value: unknown) => string = JSON.stringify,
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
      client.end(payload === undefined ? undefined : encode(payload))
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

  it('renames one exact root through a bounded generation-fenced owner mutation', async () => {
    const root = present(getRootRequest('target-1'))
    const generation = sessionGeneration(present(getWidget(root.widgetId)))
    const path = '/v1/roots/target-1/title'
    expect(
      (await call(path, 'POST', { generation: '0'.repeat(64), label: 'Neri · Hunt' })).status,
    ).toBe(409)
    expect(title).not.toHaveBeenCalled()
    const renamed = await call(path, 'POST', { generation, label: '  Neri · Mattermost Hunt  ' })
    expect(renamed.status).toBe(200)
    expect(title).toHaveBeenCalledWith(root.widgetId, generation, 'Neri · Mattermost Hunt')
    expect(JSON.stringify(renamed.body)).not.toContain('Mattermost Hunt')
    for (const label of [
      '',
      'line\nbreak',
      'line\u2028break',
      '\u001bcontrol',
      'x'.repeat(161),
      '界'.repeat(54),
    ]) {
      expect((await call(path, 'POST', { generation, label })).status).toBe(400)
    }
    expect((await call(path, 'POST', { generation, label: 'Neri', extra: true })).status).toBe(400)
  })

  it('refuses every view mutation for a non-running or ended workload without applying', async () => {
    const root = present(getRootRequest('target-1'))
    const generation = sessionGeneration(present(getWidget(root.widgetId)))
    const bounds = { x: 0, y: 0, width: 900, height: 560 }
    const counts = () => [show, position, title].map((mock) => mock.mock.calls.length)
    const before = counts()
    const refused = { status: 409, body: { error: 'workload_unavailable' } }
    running.delete(root.widgetId)
    try {
      expect(await call('/v1/roots/target-1/show', 'POST', { generation })).toEqual(refused)
      expect(await call('/v1/roots/target-1/position', 'POST', { generation, bounds })).toEqual(
        refused,
      )
      expect(
        await call('/v1/roots/target-1/title', 'POST', { generation, label: 'Focus' }),
      ).toEqual(refused)
      expect(
        await call(`/v1/widgets/${root.widgetId}/position`, 'POST', { generation, bounds }),
      ).toEqual(refused)
    } finally {
      running.add(root.widgetId)
    }
    expect(await call('/v1/roots/support-1/show', 'POST', { generation: '0'.repeat(64) })).toEqual({
      status: 410,
      body: { error: 'ended' },
    })
    expect(counts()).toEqual(before)
  })

  it('serializes root and widget routes for one workload on the widget identity', async () => {
    const root = present(getRootRequest('target-1'))
    const generation = sessionGeneration(present(getWidget(root.widgetId)))
    const bounds = { x: 0, y: 0, width: 900, height: 560 }
    const [titles, positions] = [title.mock.calls.length, position.mock.calls.length]
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    title.mockImplementationOnce(async () => {
      await gate
      return true
    })
    const first = call('/v1/roots/target-1/title', 'POST', { generation, label: 'Focus' })
    await vi.waitFor(() => expect(title).toHaveBeenCalledTimes(titles + 1))
    const second = call(`/v1/widgets/${root.widgetId}/position`, 'POST', { generation, bounds })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(position).toHaveBeenCalledTimes(positions)
    release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    expect(position).toHaveBeenCalledTimes(positions + 1)
  })

  it('writes root metadata only for an actively dispatched workload under lifecycle ownership', async () => {
    const root = present(getRootRequest('target-1'))
    const row = { ...present(getWidget(root.widgetId)), launchState: 'dispatched' as const }
    const generation = sessionGeneration(row)
    const owners = new LifecycleOwnerLock()
    const rename = vi.fn(() => expect(owners.isHeld(row.id)).toBe(true))
    let gateState: ManagedGateState | null = 'active-workload'
    let current: WidgetRow = row
    const verify = vi.fn(async () => {
      expect(owners.isHeld(row.id)).toBe(true)
      return gateState
    })
    const operations = {
      acquire: (id: string) => owners.acquire(id),
      release: (_id: string, owner: NonNullable<ReturnType<typeof owners.acquire>>) => {
        owners.release(owner)
      },
      getWidget: () => current,
      gateState: verify,
      apply: rename,
    }
    for (const launchState of ['none', 'gated'] as const) {
      current = { ...row, launchState }
      expect(await widgetMutationOperation(row.id, sessionGeneration(current), operations)).toBe(
        false,
      )
      expect(verify).not.toHaveBeenCalled()
      expect(rename).not.toHaveBeenCalled()
      expect(owners.isHeld(row.id)).toBe(false)
    }
    current = row
    for (const state of ['inert', 'ambiguous', null] as const) {
      gateState = state
      expect(await widgetMutationOperation(row.id, generation, operations)).toBe(false)
      expect(rename).not.toHaveBeenCalled()
      expect(owners.isHeld(row.id)).toBe(false)
    }
    gateState = 'active-workload'
    expect(await widgetMutationOperation(row.id, generation, operations)).toBe(true)
    expect(rename).toHaveBeenCalledExactlyOnceWith(row)
    expect(owners.isHeld(row.id)).toBe(false)
  })

  it('keeps title writes fenced after running verification and releases ownership on failure', async () => {
    const root = present(getRootRequest('target-1'))
    const row = { ...present(getWidget(root.widgetId)), launchState: 'dispatched' as const }
    const generation = sessionGeneration(row)
    const owners = new LifecycleOwnerLock()
    let current: WidgetRow | undefined = row
    const rename = vi.fn()
    const verify = vi.fn(async (): Promise<ManagedGateState> => 'active-workload')
    const operations = {
      acquire: (id: string) => owners.acquire(id),
      release: (_id: string, owner: NonNullable<ReturnType<typeof owners.acquire>>) => {
        owners.release(owner)
      },
      getWidget: () => current,
      gateState: verify,
      apply: rename,
    }
    const competingOwner = present(owners.acquire(row.id))
    expect(await widgetMutationOperation(row.id, generation, operations)).toBe(false)
    expect(verify).not.toHaveBeenCalled()
    owners.release(competingOwner)
    expect(await widgetMutationOperation(row.id, '0'.repeat(64), operations)).toBe(false)
    expect(verify).not.toHaveBeenCalled()
    for (const replacement of [
      undefined,
      { ...row, scopeInvocationId: 'replacement' },
      { ...row, launchState: 'gated' as const },
    ]) {
      current = row
      verify.mockImplementationOnce(async () => {
        current = replacement
        return 'active-workload'
      })
      expect(await widgetMutationOperation(row.id, generation, operations)).toBe(false)
      expect(rename).not.toHaveBeenCalled()
      expect(owners.isHeld(row.id)).toBe(false)
    }
    current = row
    verify.mockRejectedValueOnce(new Error('verification failed'))
    await expect(widgetMutationOperation(row.id, generation, operations)).rejects.toThrow(
      'verification failed',
    )
    expect(rename).not.toHaveBeenCalled()
    expect(owners.isHeld(row.id)).toBe(false)
  })

  it('controls one ordinary widget without a root request and returns only exact identity', async () => {
    const row = insertWidget('aabbcc01', true, 'codex')
    insertWidget('aabbcc02', true, 'codex')
    setWidgetName(row.id, 'Private widget title')
    running.add(row.id)
    expect(rootRequestForWidget(row.id)).toBeUndefined()
    const generation = sessionGeneration(row)
    const path = `/v1/widgets/${row.id}`
    const descriptor = {
      owner: 'aico',
      widgetId: row.id,
      sessionId: row.sessionId,
      generation,
      status: 'running',
      available: true,
    }
    expect(await call(path)).toEqual({ status: 200, body: descriptor })
    const bounds = { x: -10, y: 20, width: 900, height: 560 }
    expect(await call(`${path}/title`, 'POST', { generation, label: '  Exact widget  ' })).toEqual({
      status: 200,
      body: descriptor,
    })
    expect(title).toHaveBeenLastCalledWith(row.id, generation, 'Exact widget')
    expect(await call(`${path}/position`, 'POST', { generation, bounds })).toEqual({
      status: 200,
      body: descriptor,
    })
    expect(position).toHaveBeenLastCalledWith(row.id, generation, bounds)
    expect(getWidget('aabbcc02')?.name).toBeNull()
    expect(JSON.stringify(descriptor)).not.toMatch(
      /Private|label|bounds|prompt|transcript|terminal/,
    )
    const receipt = await new Promise<Record<string, unknown>>((resolve, reject) => {
      execFile(
        '/usr/bin/python3',
        [
          join(process.cwd(), 'scripts/aico-root-watch.py'),
          'widget',
          'title',
          'CLI private label',
          '--root-socket',
          socket,
        ],
        { encoding: 'utf8', env: { ...process.env, AICO_WIDGET_ID: row.id } },
        (error, stdout) => {
          if (error) reject(error)
          else {
            try {
              resolve(JSON.parse(stdout))
            } catch (failure) {
              reject(failure)
            }
          }
        },
      )
    })
    expect(receipt).toEqual({ ...descriptor, operation: 'title', applied: true })
    expect(title).toHaveBeenLastCalledWith(row.id, generation, 'CLI private label')
  })

  it('rejects stale, other-widget, missing, ended and unavailable widget mutations', async () => {
    const row = present(getWidget('aabbcc01'))
    const generation = sessionGeneration(row)
    const path = `/v1/widgets/${row.id}`
    const before = [title.mock.calls.length, position.mock.calls.length]
    for (const wrong of ['0'.repeat(64), sessionGeneration(present(getWidget('aabbcc02')))]) {
      expect(
        (await call(`${path}/title`, 'POST', { generation: wrong, label: 'Rejected' })).status,
      ).toBe(409)
      expect(
        (
          await call(`${path}/position`, 'POST', {
            generation: wrong,
            bounds: { x: 0, y: 0, width: 900, height: 560 },
          })
        ).status,
      ).toBe(409)
    }
    const ended = insertWidget('aabbcc03', true, 'codex')
    removeWidget(ended.id)
    for (const id of ['aabbcc03', 'aabbcc04']) {
      expect((await call(`/v1/widgets/${id}`)).status).toBe(404)
      expect(
        (await call(`/v1/widgets/${id}/title`, 'POST', { generation, label: 'Rejected' })).status,
      ).toBe(404)
    }
    const unavailable = await call('/v1/widgets/aabbcc02')
    expect(unavailable.body).toMatchObject({ status: 'uncertain', available: false })
    expect(
      (
        await call('/v1/widgets/aabbcc02/title', 'POST', {
          generation: unavailable.body.generation,
          label: 'Rejected',
        })
      ).status,
    ).toBe(409)
    expect([title.mock.calls.length, position.mock.calls.length]).toEqual(before)
    expect((await call('/v1/widgets/AABBCC01')).status).toBe(404)
  })

  it('reuses bounded label and integer bounds validation for ordinary widgets', async () => {
    const row = present(getWidget('aabbcc01'))
    const generation = sessionGeneration(row)
    const path = `/v1/widgets/${row.id}`
    const before = [title.mock.calls.length, position.mock.calls.length]
    for (const label of [
      '',
      '\u001bcontrol',
      'line\nbreak',
      '\u007f',
      '\u0085',
      '\u2028',
      '\u2029',
      '\ud800',
      '界'.repeat(54),
    ]) {
      expect((await call(`${path}/title`, 'POST', { generation, label })).status).toBe(400)
    }
    expect(
      (await call(`${path}/title`, 'POST', { generation, label: 'Valid', extra: true })).status,
    ).toBe(400)
    for (const bounds of [
      { x: 0, y: 0, width: 359, height: 240 },
      { x: 0, y: 0, width: 360, height: 239 },
      { x: 100001, y: 0, width: 360, height: 240 },
      { x: 0.5, y: 0, width: 360, height: 240 },
      { x: '0', y: 0, width: 360, height: 240 },
      { x: 0, y: 0, width: 360, height: 240, extra: 1 },
    ]) {
      expect((await call(`${path}/position`, 'POST', { generation, bounds })).status).toBe(400)
    }
    expect([title.mock.calls.length, position.mock.calls.length]).toEqual(before)
  })

  it('reports an applied widget mutation whose identity cannot be requalified as uncertain', async () => {
    const row = insertWidget('aabbcc08', true, 'codex')
    running.add(row.id)
    title.mockImplementationOnce(async (widgetId: string) => {
      removeWidget(widgetId)
      return true
    })
    expect(
      await call(`/v1/widgets/${row.id}/title`, 'POST', {
        generation: sessionGeneration(row),
        label: 'Applied',
      }),
    ).toEqual({ status: 409, body: { error: 'outcome_uncertain' } })
  })

  it('rejects identity changes during widget inspection or before mutation', async () => {
    const row = insertWidget('aabbcc05', true, 'codex')
    running.add(row.id)
    status.mockImplementationOnce(async () => {
      removeWidget(row.id)
      return 'running'
    })
    expect(await call(`/v1/widgets/${row.id}`)).toEqual({
      status: 409,
      body: { error: 'stale_generation' },
    })
    const replacement = insertWidget('aabbcc06', true, 'codex')
    running.add(replacement.id)
    const before = title.mock.calls.length
    status.mockImplementationOnce(async () => {
      removeWidget(replacement.id)
      return 'running'
    })
    expect(
      (
        await call(`/v1/widgets/${replacement.id}/title`, 'POST', {
          generation: sessionGeneration(replacement),
          label: 'Rejected',
        })
      ).status,
    ).toBe(409)
    expect(title.mock.calls).toHaveLength(before)
  })

  it('keeps every view mutation on one identity while holding lifecycle ownership', async () => {
    const row = { ...present(getWidget('aabbcc01')), launchState: 'dispatched' as const }
    const generation = sessionGeneration(row)
    const owners = new LifecycleOwnerLock()
    let current: WidgetRow | undefined = row
    const apply = vi.fn(() => expect(owners.isHeld(row.id)).toBe(true))
    const verify = vi.fn(async (): Promise<ManagedGateState> => {
      expect(owners.isHeld(row.id)).toBe(true)
      return 'active-workload'
    })
    const operations = {
      acquire: (id: string) => owners.acquire(id),
      release: (_id: string, owner: NonNullable<ReturnType<typeof owners.acquire>>) =>
        owners.release(owner),
      getWidget: () => current,
      gateState: verify,
      apply,
    }
    expect(await widgetMutationOperation(row.id, generation, operations)).toBe(true)
    expect(apply).toHaveBeenCalledExactlyOnceWith(row)
    apply.mockClear()
    for (const replacement of [
      undefined,
      { ...row, scopeInvocationId: 'changed' },
      { ...row, id: 'aabbcc02' },
    ]) {
      current = row
      verify.mockImplementationOnce(async () => {
        current = replacement
        return 'active-workload'
      })
      expect(await widgetMutationOperation(row.id, generation, operations)).toBe(false)
      expect(apply).not.toHaveBeenCalled()
      expect(owners.isHeld(row.id)).toBe(false)
    }
    current = row
    verify.mockRejectedValueOnce(new Error('pane check failed'))
    await expect(widgetMutationOperation(row.id, generation, operations)).rejects.toThrow(
      'pane check failed',
    )
    expect(owners.isHeld(row.id)).toBe(false)
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

  it('exposes one fail-closed clear/submit contract and never claims native acceptance', async () => {
    const root = present(getRootRequest('target-1'))
    const generation = sessionGeneration(present(getWidget(root.widgetId)))
    const path = '/v1/roots/target-1/admin'
    const capabilities = await call(path)
    expect(capabilities.status).toBe(200)
    expect(capabilities.body.terminalAdmin).toMatchObject({
      available: false,
      reason: 'native_tui_atomic_compare_and_apply_unavailable',
      operations: ['clear', 'submit'],
      framing: 'bracketed_paste',
    })
    const pin = {
      requestKey: 'scope-seam-1',
      generation,
      expectedThreadId: '00000000-0000-4000-8000-000000000001',
    }
    for (const operation of [
      { ...pin, kind: 'clear' },
      { ...pin, kind: 'submit', text: 'private text' },
    ]) {
      const first = await call(path, 'POST', operation)
      expect(first.status).toBe(503)
      expect(first.body).toMatchObject({
        error: 'native_tui_atomic_admin_unavailable',
        applied: false,
        requestKey: pin.requestKey,
        generation,
        expectedThreadId: pin.expectedThreadId,
      })
      expect(JSON.stringify(first.body)).not.toContain('private text')
      expect(await call(path, 'POST', operation)).toEqual(first)
    }
    expect(
      (await call(path, 'POST', { ...pin, kind: 'clear', generation: '0'.repeat(64) })).status,
    ).toBe(409)
    expect((await call(path, 'POST', { ...pin, kind: 'clear', text: 'unexpected' })).status).toBe(
      400,
    )
    expect((await call(path, 'POST', { ...pin, kind: 'submit', text: '\x1b[201~' })).status).toBe(
      400,
    )
    expect(
      (await call(path, 'POST', { ...pin, kind: 'clear', expectedThreadId: 'invalid' })).status,
    ).toBe(400)
    expect(
      (await call(path, 'POST', { ...pin, kind: 'submit', text: 'x'.repeat(4096) })).status,
    ).toBe(400)
    expect(
      (await call('/v1/roots/support-1/admin', 'POST', { ...pin, kind: 'clear' })).status,
    ).toBe(410)
    const unsupported = await call('/v1/roots', 'POST', {
      ...create('unsupported-admin'),
      tool: 'claude-code',
    })
    expect(
      (
        await call('/v1/roots/unsupported-admin/admin', 'POST', {
          ...pin,
          kind: 'clear',
          generation: unsupported.body.generation,
        })
      ).status,
    ).toBe(422)
  })

  it('cannot use the Aico workload generation as a native-thread fence', () => {
    const root = present(getRootRequest('target-1'))
    const row = present(getWidget(root.widgetId))
    const before = { ...row, nativeThreadId: '00000000-0000-4000-8000-000000000001' }
    const after = { ...row, nativeThreadId: '00000000-0000-4000-8000-000000000002' }
    expect(sessionGeneration(before)).toBe(sessionGeneration(after))
  })

  it('accepts every bounded UTF-8 admin text with JSON escaping at the body boundary', async () => {
    const root = present(getRootRequest('target-1'))
    const pin = {
      kind: 'submit',
      requestKey: 'x'.repeat(128),
      generation: sessionGeneration(present(getWidget(root.widgetId))),
      expectedThreadId: '00000000-0000-4000-8000-000000000001',
    }
    const ascii = (value: unknown) =>
      JSON.stringify(value)
        .replace(
          /[\u007f-\uffff]/g,
          (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
        )
        .replace(/\\n/g, '\\u000a')
        .replace(/\\t/g, '\\u0009')
    for (const text of ['界'.repeat(666) + 'ab', 'x' + '\n\t'.repeat(999) + '\n']) {
      expect(Buffer.byteLength(text)).toBe(2000)
      const result = await call('/v1/roots/target-1/admin', 'POST', { ...pin, text }, ascii)
      expect(result.status).toBe(503)
      expect(result.body.applied).toBe(false)
      expect(JSON.stringify(result.body)).not.toContain(text)
    }
    expect(
      (await call('/v1/roots/target-1/admin', 'POST', { ...pin, text: '界'.repeat(667) })).status,
    ).toBe(400)
  })

  it('serves the actual ST owner executable through the isolated private socket', async () => {
    const root = present(getRootRequest('target-1'))
    const generation = sessionGeneration(present(getWidget(root.widgetId)))
    const run = (args: string[]) =>
      new Promise<{ code: string | number; body: Record<string, unknown> }>((resolve, reject) => {
        execFile(
          '/usr/bin/python3',
          [
            join(process.cwd(), 'scripts/aico-root-watch.py'),
            'admin',
            'target-1',
            ...args,
            '--root-socket',
            socket,
          ],
          { encoding: 'utf8' },
          (error, stdout) => {
            try {
              resolve({ code: error?.code ?? 0, body: JSON.parse(stdout) })
            } catch (failure) {
              reject(failure)
            }
          },
        )
      })
    expect((await run([])).body.terminalAdmin).toMatchObject({ available: false })
    const denied = await run([
      'clear',
      '--generation',
      generation,
      '--thread',
      '00000000-0000-4000-8000-000000000001',
      '--request-key',
      'scope-seam-1',
    ])
    expect(denied.code).toBe(1)
    expect(denied.body).toMatchObject({
      applied: false,
      reason: 'native_tui_atomic_admin_unavailable',
    })
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
    expect(rootRequestDigest(parsed)).toBe(
      createHash('sha256')
        .update(
          JSON.stringify([
            input.tool,
            input.projectId,
            input.projectRoot,
            input.initialPrompt,
            input.role,
            input.leadRootReference,
            null,
          ]),
        )
        .digest('hex'),
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
      AICO_ROOT_RESUME_SESSION_ID: '',
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

  it('validates exact Codex resume and retains idempotency across resume conflicts', async () => {
    const thread = '00000000-0000-4000-8000-000000000001'
    const input = { ...create('resume-exact'), resumeSessionId: thread }
    for (const invalid of [
      '',
      'last',
      thread.toUpperCase().replace('00000001', '0000000A'),
      `${thread};echo x`,
      ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((suffix) => thread + suffix),
    ]) {
      expect(parseRootCreate({ ...input, resumeSessionId: invalid })).toBeNull()
    }
    expect(parseRootCreate({ ...input, tool: 'claude-code' })).toBeNull()
    expect(parseRootCreate({ ...input, initialPrompt: 'x\runsafe' })).toBeNull()
    expect(parseRootCreate({ ...input, initialPrompt: 'x'.repeat(2001) })).toBeNull()
    expect(rootRequestDigest(present(parseRootCreate({ ...input, resumeSessionId: null })))).toBe(
      rootRequestDigest(present(parseRootCreate(create('resume-exact')))),
    )
    const first = await call('/v1/roots', 'POST', input)
    const retry = await call('/v1/roots', 'POST', input)
    expect(first.status).toBe(200)
    expect(retry).toEqual(first)
    expect(ensure).toHaveBeenLastCalledWith(first.body.hostIdentity, input.initialPrompt, thread)
    for (const changed of [
      { ...input, resumeSessionId: '00000000-0000-4000-8000-000000000002' },
      create('resume-exact'),
      { ...input, initialPrompt: 'changed recovery instruction' },
    ]) {
      expect((await call('/v1/roots', 'POST', changed)).status).toBe(409)
    }
  })

  it('launches exact resume argv once through the fresh gate and clears transient variables', async () => {
    const root = present(getRootRequest('resume-exact'))
    const thread = '00000000-0000-4000-8000-000000000001'
    const prompt = "-option\n$(printf injected) 'quoted' 界"
    const tool = {
      slug: 'codex',
      resume: codexTui.resume,
      displayName: 'fixture',
      icon: '',
      accent: '',
      enabled: true,
      order: 0,
      command: [
        '/usr/bin/python3',
        '-c',
        'import json,os,sys; print(json.dumps({"args":sys.argv[1:],"prompt":os.getenv("AICO_ROOT_INITIAL_PROMPT"),"thread":os.getenv("AICO_ROOT_RESUME_SESSION_ID")}))',
        '--yolo',
      ],
      processName: 'python3',
    }
    await withRootPrompt(
      root.widgetId,
      prompt,
      async () => {
        const environment = rootLaunchEnvironment(root.widgetId)
        expect(environment.AICO_ROOT_RESUME_SESSION_ID).toBe(thread)
        const line = present(initialLaunchLine(root.widgetId, tool))
        expect(line).not.toContain(prompt)
        expect(line).not.toContain(thread)
        const result = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', line], {
          env: { PATH: '/usr/bin:/bin', ...environment },
          encoding: 'utf8',
        })
        expect(JSON.parse(result)).toEqual({
          args: ['--yolo', 'resume', '--no-daemon', thread, '--', prompt],
          prompt: null,
          thread: null,
        })
      },
      thread,
    )
    expect(rootLaunchEnvironment(root.widgetId).AICO_ROOT_RESUME_SESSION_ID).toBe('')
    expect(rootPromptReady(root.widgetId)).toBe(false)
  })

  it('serves exact-create retries and conflicts through the real owner CLI and private socket', async () => {
    const invoke = (prompt: string) =>
      new Promise<{ code: string | number; body: Record<string, unknown> }>((resolve, reject) => {
        execFile(
          '/usr/bin/python3',
          [
            join(process.cwd(), 'scripts/aico-root-watch.py'),
            'create',
            'cli-recovery',
            prompt,
            '--project',
            'neri',
            '--project-root',
            fixture,
            '--resume-session',
            '00000000-0000-4000-8000-000000000001',
            '--root-socket',
            socket,
          ],
          { encoding: 'utf8' },
          (error, stdout) => {
            try {
              resolve({ code: error?.code ?? 0, body: JSON.parse(stdout) })
            } catch (failure) {
              reject(failure)
            }
          },
        )
      })
    const first = await invoke('Reconcile fixture state after crash.')
    expect(first.code).toBe(0)
    expect(first.body).toMatchObject({
      owner: 'aico',
      requestId: 'cli-recovery',
      status: 'running',
    })
    expect(JSON.stringify(first.body)).not.toContain('Reconcile fixture')
    expect(await invoke('Reconcile fixture state after crash.')).toEqual(first)
    expect((await invoke('Changed fixture recovery prompt.')).body.reason).toBe('request_conflict')
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
