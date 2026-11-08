import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Notifier, NotifyStore, typeOf } from '@aico/notify'
import type { StatusRow, ThermalGuard } from '@aico/status'
import type { SessionDescriptor, TetherTool } from '@aico/tether-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebStore } from './db'
import { descriptor } from './testing'
import { ThermalGuardDelivery, thermalNoticeKey, thermalSource } from './thermal-guard'

const close: (() => void)[] = []
afterEach(() => {
  for (const stop of close.splice(0).reverse()) stop()
})

function row(phase: ThermalGuard['phase'] = 'hot', at = '2026-11-08T12:00:00Z'): StatusRow {
  return {
    id: 'gem/backup-guard',
    machine: 'gem',
    kind: 'check',
    what: 'Backup guard',
    state: phase === 'recovered' ? 'ok' : 'warn',
    meaning: 'Guard checked.',
    last_run: at,
    guard: {
      episode_id: 'boot:episode',
      phase,
      temperature_c: phase === 'unavailable' ? null : 85,
      cpu_quota_percent: phase === 'recovered' ? 200 : 50,
      admission_open: phase === 'recovered',
      delivery_machine: 'aico',
    },
  }
}

function setup(path = ':memory:') {
  let store = new WebStore(path)
  close.push(() => store.close())
  let rows: StatusRow[] = [row()]
  let sessions: SessionDescriptor[] = [descriptor({ id: '00000001', tool: 'codex' })]
  const tools = vi.fn(async (_host?: string) => ({
    items: [
      { slug: 'codex', deliveries: true },
      { slug: 'claude-code', deliveries: true },
      { slug: 'agy', deliveries: true },
      { slug: 'shell', deliveries: false },
    ] as TetherTool[],
    defaultSlug: 'codex',
  }))
  const request = vi.fn(async <T>(_method: string, _path: string, _body?: unknown) => ({
    status: 201,
    body: {} as T,
  }))
  const receive = vi.fn(() => ({ id: 'notice', repeat: false }))
  const resolve = vi.fn(async () => ({ id: 'notice', repeat: false, resolved: 1 }))
  const log = vi.fn()
  const deps = () => ({
    machine: 'aico',
    status: { rows: () => rows.map((value) => ({ row: value, updatedAt: 0 })) },
    store,
    tether: { listSessions: async () => sessions, tools, request },
    notices: { receive, resolve },
    log,
  })
  let delivery = new ThermalGuardDelivery(deps())
  return {
    request,
    tools,
    receive,
    resolve,
    log,
    tick: () => delivery.tick(),
    write(value: StatusRow) {
      rows = [value]
      delivery.rowsWritten(rows)
    },
    rows(value: StatusRow[]) {
      rows = value
    },
    sessions(value: SessionDescriptor[]) {
      sessions = value
    },
    restart() {
      store.close()
      store = new WebStore(path)
      delivery = new ThermalGuardDelivery(deps())
    },
    forMachine(machine: string) {
      delivery = new ThermalGuardDelivery({ ...deps(), machine })
    },
    useNotices(notices: Pick<Notifier, 'receive' | 'resolve'>) {
      delivery = new ThermalGuardDelivery({ ...deps(), notices })
    },
  }
}

describe('native thermal event delivery', () => {
  it('wakes a standalone agent when there is no coordinator', async () => {
    const work = setup()
    await work.tick()
    expect(work.request).toHaveBeenCalledExactlyOnceWith(
      'POST',
      '/v1/sessions/00000001/deliveries',
      {
        source: thermalSource('gem', 'boot:episode'),
        line: expect.stringContaining('gem is hot (85°C)'),
        ride: false,
      },
    )
    expect(work.receive).toHaveBeenCalledWith(
      expect.objectContaining({ key: thermalNoticeKey('gem'), push: 'tray' }),
      'local',
    )
  })

  it('includes coordinators once and selects live agent capabilities on each owning host', async () => {
    const work = setup()
    const coord = descriptor({ id: '00000001', tool: 'codex', coordinator: true })
    work.sessions([
      coord,
      coord,
      descriptor({
        id: '00000002',
        tool: 'claude-code',
        coordinatorId: coord.id,
        host: 'other-alias',
      }),
      descriptor({ id: '00000003', tool: 'agy' }),
      descriptor({ id: '00000004', tool: 'shell' }),
      descriptor({ id: '00000005', tool: 'codex', status: 'pending' }),
      descriptor({ id: '00000006', tool: 'codex', available: false }),
      descriptor({
        id: '00000007',
        tool: 'codex',
        host: 'off',
        peer: { state: 'offline', since: 1, listedAt: 1 },
      }),
    ])
    await work.tick()
    expect(work.request.mock.calls.map((call) => call[1])).toEqual([
      '/v1/sessions/00000001/deliveries',
      '/v1/sessions/00000002/deliveries',
      '/v1/sessions/00000003/deliveries',
    ])
    expect(work.tools.mock.calls).toEqual([[undefined], ['other-alias']])
  })

  it('deduplicates repeat rows and restart, but reaches a newly active agent', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'aico-thermal-'))
    close.push(() => rmSync(folder, { recursive: true, force: true }))
    const work = setup(join(folder, 'web.db'))
    await work.tick()
    work.write(row())
    await work.tick()
    work.restart()
    await work.tick()
    expect(work.request).toHaveBeenCalledTimes(1)
    expect(work.receive).toHaveBeenCalledTimes(1)
    work.sessions([
      descriptor({ id: '00000001', tool: 'codex' }),
      descriptor({ id: '00000002', tool: 'codex' }),
    ])
    await work.tick()
    expect(work.request).toHaveBeenCalledTimes(2)
  })

  it('replaces a queued warning with recovery on the same source and resolves the owner notice', async () => {
    const work = setup()
    await work.tick()
    work.write(row('critical', '2026-11-08T12:01:00Z'))
    await work.tick()
    work.write(row('recovered', '2026-11-08T12:02:00Z'))
    await work.tick()
    const payloads = work.request.mock.calls.map((call) => call[2])
    expect(payloads).toEqual([
      expect.objectContaining({ source: thermalSource('gem', 'boot:episode') }),
      expect.objectContaining({
        source: thermalSource('gem', 'boot:episode'),
        line: expect.stringContaining('critically hot'),
      }),
      expect.objectContaining({
        source: thermalSource('gem', 'boot:episode'),
        line: expect.stringContaining('guard recovered'),
      }),
    ])
    expect(work.resolve).toHaveBeenCalledWith(
      'aico',
      thermalNoticeKey('gem'),
      expect.stringContaining('may resume'),
    )
    work.sessions([descriptor({ id: '00000002', tool: 'codex' })])
    await work.tick()
    expect(work.request).toHaveBeenCalledTimes(3)
    work.write(row('hot', '2026-11-08T12:00:00Z'))
    await work.tick()
    expect(work.request).toHaveBeenCalledTimes(3)
  })

  it('keeps accepted recipients when one delivery fails and retries that failure on the next pass', async () => {
    const work = setup()
    work.sessions([
      descriptor({ id: '00000001', tool: 'codex' }),
      descriptor({ id: '00000002', tool: 'codex' }),
    ])
    work.request.mockRejectedValueOnce(new Error('link down'))
    await work.tick()
    await work.tick()
    expect(work.request.mock.calls.map((call) => call[1])).toEqual([
      '/v1/sessions/00000001/deliveries',
      '/v1/sessions/00000002/deliveries',
      '/v1/sessions/00000001/deliveries',
    ])
    expect(work.receive).toHaveBeenCalledTimes(1)
  })

  it('has a single delivery authority and makes no temperature claim when unavailable', async () => {
    const work = setup()
    work.forMachine('workstation')
    await work.tick()
    expect(work.request).not.toHaveBeenCalled()
    expect(work.receive).not.toHaveBeenCalled()
    work.forMachine('aico')
    work.write(row('unavailable'))
    await work.tick()
    expect(work.request.mock.calls[0]?.[2]).toMatchObject({
      line: expect.stringContaining('temperature reading is unavailable'),
    })
  })

  it('honors the existing Status phone and desktop choices, including an explicit off', async () => {
    const work = setup()
    const notices = new NotifyStore(':memory:')
    close.push(() => notices.close())
    const saved = { phone: false, desktop: false }
    const notifier = new Notifier({
      store: notices,
      sender: { devices: () => [] } as never,
      outbox: { kick: async () => 0 } as never,
      needsYou: { noticeAccepted: async () => {}, noticeResolved: async () => {} } as never,
      choices: { choice: (type, channel) => (type === 'status' ? saved[channel] : null) },
      log: () => {},
    })
    work.useNotices(notifier)
    await work.tick()
    const first = notices.forKey('aico', thermalNoticeKey('gem'))[0]
    expect(typeOf(first!.notice)).toBe('status')
    expect(first!.notice).toMatchObject({ push: 'tray', desktop_card: false })
    expect(first!.notice.interrupt).toBeUndefined()
    expect(first!.deliveries).toEqual([])
    saved.phone = true
    work.write(row('critical', '2026-11-08T12:01:00Z'))
    await work.tick()
    expect(notices.forKey('aico', thermalNoticeKey('gem'))[0]?.notice.push).toBe('phone')
    work.write(row('recovered', '2026-11-08T12:02:00Z'))
    await work.tick()
    expect(notices.forKey('aico', thermalNoticeKey('gem'))[0]?.notice).toMatchObject({
      severity: 'ok',
      push: 'tray',
    })
  })
})
