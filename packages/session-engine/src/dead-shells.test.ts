import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type DeadShellDeps, DeadShells } from './dead-shells'
import { getWidget, insertWidget, removeWidget, type WidgetRow } from './lifecycle/catalog'
import type { AbandonedScope, EndResult } from './lifecycle/engine'
import { initStore, registerBuiltinTuis } from './lifecycle/testing'

const fixture = mkdtempSync(join(tmpdir(), 'tether-dead-shells-'))

beforeAll(() => {
  registerBuiltinTuis()
  initStore(join(fixture, 'catalog.db'))
})
afterAll(() => rmSync(fixture, { recursive: true, force: true }))

function abandoned(widgetId: string, startup = false): AbandonedScope {
  return {
    widgetId,
    scopeUnit: `tmux-spawn-${widgetId}.scope`,
    scopeInvocationId: null,
    tmuxServerId: null,
    serverUnit: null,
    serverInvocationId: null,
    serverDead: startup,
    startup,
    at: 0,
  }
}

function harness(overrides: Partial<DeadShellDeps> = {}) {
  const statuses = new Map<string, string>()
  const end = vi.fn(async (id: string): Promise<EndResult> => {
    removeWidget(id)
    return { status: 'ended' } as EndResult
  })
  const log = vi.fn()
  const deps: DeadShellDeps = {
    awaitingRestore: () => false,
    restorePlanned: Promise.resolve(),
    restoreFinished: Promise.resolve(),
    list: () => [],
    status: async (row: WidgetRow) => statuses.get(row.id) ?? 'uncertain',
    end,
    generationOf: (row) => `gen-${row.id}`,
    log,
    sleep: async () => {},
    ...overrides,
  }
  return { shells: new DeadShells(deps), end, log, statuses }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('dead shells', () => {
  it('ends a shell whose pane died while Tether ran, and says so once', async () => {
    insertWidget('5e110001', 'shell', Date.now(), { origin: 'cli', aTermSessionId: null })
    const { shells, end, log } = harness()
    shells.onAbandoned(abandoned('5e110001'))
    shells.onAbandoned(abandoned('5e110001'))
    await flush()
    expect(end).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledWith('5e110001', 'gen-5e110001')
    expect(getWidget('5e110001')).toBeUndefined()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('ended shell 5e110001')
  })

  it('leaves agents to crash recovery', async () => {
    insertWidget('a9e70001', 'codex', Date.now(), { origin: 'cli', aTermSessionId: null })
    const { shells, end } = harness()
    shells.onAbandoned(abandoned('a9e70001'))
    await shells.endIfDead('a9e70001')
    expect(end).not.toHaveBeenCalled()
    expect(getWidget('a9e70001')).toBeDefined()
    removeWidget('a9e70001')
  })

  it('keeps a shell that runs again', async () => {
    insertWidget('5e110002', 'shell', Date.now(), { origin: 'cli', aTermSessionId: null })
    const { shells, end, statuses } = harness()
    statuses.set('5e110002', 'running')
    expect(await shells.endIfDead('5e110002')).toBe(false)
    expect(end).not.toHaveBeenCalled()
    removeWidget('5e110002')
  })

  it('retries while the reconciliation that reported it still holds the session', async () => {
    insertWidget('5e110003', 'shell', Date.now(), { origin: 'cli', aTermSessionId: null })
    const { shells, end } = harness()
    end.mockResolvedValueOnce({ status: 'busy' })
    expect(await shells.endIfDead('5e110003')).toBe(true)
    expect(end).toHaveBeenCalledTimes(2)
  })

  it('after a restart, ends shells reboot restore leaves out, and waits for the ones it restores', async () => {
    for (const id of ['5e110004', '5e110005', '5e110006'])
      insertWidget(id, 'shell', Date.now(), { origin: 'cli', aTermSessionId: null })
    let finish = () => {}
    const restoreFinished = new Promise<void>((resolve) => {
      finish = resolve
    })
    const awaiting = new Set(['5e110005', '5e110006'])
    const { shells, end, statuses } = harness({
      awaitingRestore: (id) => awaiting.has(id),
      restoreFinished,
    })
    for (const id of ['5e110004', '5e110005', '5e110006']) shells.onAbandoned(abandoned(id, true))
    await flush()
    expect(end).not.toHaveBeenCalled() // startup waits for the restore plan
    const settled = shells.settleStartup(Date.now() + 1)
    await flush()
    expect(end.mock.calls.map(([id]) => id)).toEqual(['5e110004'])
    // Restore brings 5e110005 back and cannot bring 5e110006 back.
    statuses.set('5e110005', 'running')
    awaiting.clear()
    finish()
    await settled
    expect(end.mock.calls.map(([id]) => id)).toEqual(['5e110004', '5e110006'])
    expect(getWidget('5e110005')).toBeDefined()
    removeWidget('5e110005')
  })

  it('after a restart, also ends a shell that lost its pane before it, never a new one', async () => {
    const started = Date.now()
    insertWidget('5e110007', 'shell', started - 60_000, { origin: 'cli', aTermSessionId: null })
    insertWidget('5e110008', 'shell', started + 1, { origin: 'cli', aTermSessionId: null })
    insertWidget('a9e70002', 'codex', started - 60_000, { origin: 'cli', aTermSessionId: null })
    const { shells, end } = harness({
      list: () => ['5e110007', '5e110008', 'a9e70002'].flatMap((id) => getWidget(id) ?? []),
    })
    await shells.settleStartup(started)
    expect(end.mock.calls.map(([id]) => id)).toEqual(['5e110007'])
    removeWidget('5e110008')
    removeWidget('a9e70002')
  })

  it('waits for reconciliation to clear the pane, and leaves it listed if it never does', async () => {
    insertWidget('5e110009', 'shell', Date.now(), { origin: 'cli', aTermSessionId: null })
    const { shells, end, log } = harness({
      status: async () => 'uncertain',
    })
    const row = getWidget('5e110009') as WidgetRow
    const withPane = { ...row, scopeUnit: 'tmux-spawn-x.scope' }
    const catalog = await import('./lifecycle/catalog')
    const spy = vi
      .spyOn(catalog, 'getWidget')
      .mockImplementation((id) => (id === '5e110009' ? withPane : undefined))
    expect(await shells.endIfDead('5e110009')).toBe(false)
    spy.mockRestore()
    expect(end).not.toHaveBeenCalled()
    expect(log.mock.calls.at(-1)?.[0]).toContain('could not be ended')
    removeWidget('5e110009')
  })
})
