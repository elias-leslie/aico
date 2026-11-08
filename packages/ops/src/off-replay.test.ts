// A machine that's off isn't a failure (owner 2026-11-08), replayed on the notices that said it was:
// fixtures/off-replay.json holds their real titles, each with the case below that made it fire. Every
// case runs the real path through Status with its alert hook and must alert on nothing; the other half
// of each case holds a real failure on a running machine, which still alerts.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { peerStatusRow } from '@aico/fleet/power'
import { type AlertBatch, type StatusRow, StatusStore } from '@aico/status'
import { afterEach, describe, expect, it } from 'vitest'
import { backupJob, diskAway, type GuestPower, hostAway } from './backup-drive'
import { observeExternal } from './backup-external'
import {
  type BackupEntry,
  type BackupState,
  backupRows,
  config,
  copyKey,
  entries,
  markUnplugged,
} from './backup-plan'
import type { Runtime } from './backup-runtime'
import { scheduledEntries } from './backups'

const replay: { notices: { title: string; sent: number; case: string }[] } = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/off-replay.json', import.meta.url)), 'utf8'),
)

const MIN = 60_000
const T0 = Date.parse('2026-11-08T14:00:00Z')
const HOST = 'workstation'

/** A Status store on a settable clock, keeping every alert it would send. */
function status(options: { server?: boolean } = {}) {
  const clock = { now: T0 }
  const store = new StatusStore(':memory:', () => clock.now, options)
  const alerts: AlertBatch[] = []
  store.onAlert((batch) => alerts.push(batch))
  const beat = () =>
    store.upsert([
      {
        id: `${HOST}/machine`,
        what: HOST,
        kind: 'machine',
        machine: HOST,
        state: 'ok',
        meaning: 'Up.',
        next_run: new Date(clock.now + 10 * MIN).toISOString(),
      },
    ])
  return {
    clock,
    store,
    alerts,
    beat,
    titles: () => alerts.flatMap((a) => a.changes.map((c) => c.row.what)),
  }
}

const made: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'off-replay-'))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const cfg = () => {
  const c = config({})
  c.stateDir = temp()
  c.scratchRoot = temp()
  c.workstation = HOST
  return c
}
const emptyState = (): BackupState => ({ copies: {}, runs: {}, points: [] })
const GOOD = {
  source: 'pve-vm-180-app-recovery',
  target: 'drive' as const,
  dataAt: new Date(T0 - 3 * 3600_000).toISOString(),
  snapshot: 'a'.repeat(64),
  copiedAt: new Date(T0 - 3 * 3600_000).toISOString(),
  observed: 'ok' as const,
}
/** The copy of one source, with restic failing as it does when its capture dies. */
async function failedCopy(before: GuestPower, now: GuestPower, state = emptyState()) {
  state.copies[copyKey(GOOD.source, 'drive')] = GOOD
  let clock = T0
  const rt: Runtime = {
    cfg: cfg(),
    run: async () => ({ code: 1, out: '', err: 'restic: capture failed' }),
    now: () => {
      clock += 5 * MIN
      return new Date(clock)
    },
  }
  return backupJob(rt, state, {
    id: GOOD.source,
    paths: [],
    binds: [],
    dataAt: new Date(T0).toISOString(),
    command: ['ssh'],
    filename: 'files-qemu-180.tar.gz',
    machine: { before, read: async () => now },
  })
}
/** That copy's row, as Status gets it. */
const copyRow = (state: BackupState, c = cfg()): StatusRow => {
  const row = backupRows(entries(state, c, HOST, T0)).find((r) =>
    r.id.endsWith(`drive/${GOOD.source}`),
  )
  if (!row) throw new Error('no row for the copy')
  return row
}

describe('the notices that fired because a machine was off', () => {
  it('names a replayed case for every notice', () => {
    const cases = new Set([
      'off-during-copy',
      'running-job',
      'on-demand-power',
      'server-restart',
      'link-power',
      'repo-peer-away',
      'owner-booting',
      'release-push',
    ])
    for (const notice of replay.notices)
      expect([notice.title, cases.has(notice.case)]).toEqual([notice.title, true])
    expect(replay.notices.reduce((sum, n) => sum + n.sent, 0)).toBe(88)
  })

  describe('off-during-copy', () => {
    const on: GuestPower = { state: 'on', uptime: 3600 }
    const off: GuestPower = { state: 'off' }
    it('shut down mid-copy: shown off with its last good copy, no alert', async () => {
      const s = status()
      s.beat()
      const state = emptyState()
      const copy = await failedCopy(on, off, state)
      state.copies[copyKey(GOOD.source, 'drive')] = copy
      expect(copy).toMatchObject({
        observed: 'offline',
        snapshot: GOOD.snapshot,
        dataAt: GOOD.dataAt,
      })
      expect(copy.error).toBeUndefined()
      const row = copyRow(state)
      expect(row.state).toBe('off')
      expect(row.last_run).toBe(GOOD.dataAt)
      s.store.upsert([row])
      expect(s.titles()).toEqual([])
    })
    it('the Proxmox host stops answering mid-copy: the same', async () => {
      const copy = await failedCopy({ state: 'on' }, { state: 'off' })
      expect(copy.observed).toBe('offline')
    })
    it('started or restarted mid-copy: no failure, the next normal run takes it', async () => {
      for (const [before, now] of [
        [off, on],
        [on, { state: 'on', uptime: 60 }],
      ] as [GuestPower, GuestPower][]) {
        const copy = await failedCopy(before, now)
        expect(copy.error).toBeUndefined()
        expect(copy.observed).toBe('ok')
        expect(copy.snapshot).toBe(GOOD.snapshot)
      }
    })
    it('a real restic failure while the VM runs is still Failed, and alerts', async () => {
      const s = status()
      s.beat()
      const state = emptyState()
      const copy = await failedCopy(on, { state: 'on', uptime: 7200 }, state)
      state.copies[copyKey(GOOD.source, 'drive')] = copy
      expect(copy.observed).toBe('failed')
      expect(copy.error).toContain('restic exit 1')
      expect(copy.snapshot).toBe(GOOD.snapshot)
      const row = copyRow(state)
      expect(row.state).toBe('failed')
      s.store.upsert([row])
      expect(s.titles()).toEqual([row.what])
    })
    it('a failed read of a disk that stayed off is Failed too: its power did not cause it', async () => {
      expect((await failedCopy(off, off)).observed).toBe('failed')
    })
    it('power that can not be read proves nothing: Failed', async () => {
      expect((await failedCopy(on, { state: 'unknown' })).observed).toBe('failed')
    })
    it('off rows have no due time, and are not behind however old', () => {
      const state = emptyState()
      state.copies[copyKey(GOOD.source, 'drive')] = {
        ...GOOD,
        observed: 'offline',
        dataAt: new Date(T0 - 60 * 24 * 3600_000).toISOString(),
      }
      expect(copyRow(state).state).toBe('off')
    })
    it('coming back keeps it off until its next normal run, never late or red', async () => {
      const state = emptyState()
      state.copies[copyKey(GOOD.source, 'drive')] = {
        ...GOOD,
        observed: 'offline',
        dataAt: new Date(T0 - 60 * 24 * 3600_000).toISOString(),
      }
      const run = async () => ({ code: 0, out: 'status: running\n', err: '' })
      const item = (await scheduledEntries(state, cfg(), HOST, run)).find(
        (e) => e.id === copyKey(GOOD.source, 'drive'),
      )
      expect(item).toMatchObject({ state: 'off', nextRun: null })
    })
  })

  describe('running-job', () => {
    it('a row posted when its run starts is not late while the run works', async () => {
      const s = status()
      s.beat()
      const c = cfg()
      const leased = async (argv: string[]) =>
        argv.includes('jobs')
          ? {
              code: 0,
              out: JSON.stringify([
                {
                  kind: 'backups-append',
                  state: { nextRun: T0, leaseId: 'x', leaseExpires: Date.now() + 5 * MIN },
                },
              ]),
              err: '',
            }
          : { code: 0, out: 'status: running\n', err: '' }
      const items = await scheduledEntries(emptyState(), c, HOST, leased)
      const row = backupRows(items.filter((i) => i.target === 'append'))[0] as StatusRow
      expect(Date.parse(row.next_run as string)).toBeGreaterThan(Date.now() + 30 * MIN)
      s.store.upsert([{ ...row, machine: HOST }])
      s.clock.now = T0 + 3 * MIN
      s.beat()
      expect(s.titles()).toEqual([])
    })
    it('a job whose lease ran out, with no report, does go late', () => {
      const s = status()
      s.beat()
      s.store.upsert([
        {
          id: `${HOST}/backup/append/x`,
          what: 'Aico databases and photos · CT 160',
          kind: 'backup',
          machine: HOST,
          state: 'ok',
          meaning: 'Fine.',
          next_run: new Date(T0 + MIN).toISOString(),
        },
      ])
      s.clock.now = T0 + 5 * MIN
      s.beat()
      expect(s.titles()).toEqual(['Aico databases and photos · CT 160'])
    })
  })

  describe('on-demand-power', () => {
    const machineRow = (nextRun: number): StatusRow => ({
      id: 'apps/machine',
      what: 'apps',
      kind: 'machine',
      machine: 'apps',
      state: 'ok',
      meaning: 'Reporting.',
      next_run: new Date(nextRun).toISOString(),
    })
    it('started: quiet while it boots, and its report ends it', () => {
      const s = status()
      s.store.syncIntents([{ machine: 'apps', intent: 'on-demand' }])
      s.store.setObservedPower('apps', true, T0 - 2 * 3600_000, T0 - 2 * 3600_000)
      s.clock.now = T0 - 3600_000
      s.store.upsert([machineRow(T0 - 3590_000)])
      s.store.setObservedPower('apps', false, T0 - 3580_000)
      s.clock.now = T0
      s.store.setObservedPower('apps', true, T0, T0)
      s.clock.now = T0 + 8 * MIN
      s.store.checkAlerts()
      expect(s.store.read().rows.find((r) => r.id === 'apps/machine')?.shown).toBe('unknown')
      s.store.upsert([machineRow(s.clock.now + 2 * MIN)])
      expect(s.titles()).toEqual([])
    })
    it('shutting down: quiet until the reading says off, then off', () => {
      const s = status()
      s.store.syncIntents([{ machine: 'apps', intent: 'on-demand' }])
      s.store.setObservedPower('apps', true, T0 - 3600_000, T0 - 3600_000)
      s.store.upsert([machineRow(T0 + 2 * MIN)])
      s.clock.now = T0 + 5 * MIN
      s.store.checkAlerts()
      s.store.setObservedPower('apps', false, s.clock.now)
      s.clock.now = T0 + 20 * MIN
      s.store.checkAlerts()
      expect(s.titles()).toEqual([])
      expect(s.store.read().rows.find((r) => r.id === 'apps/machine')?.shown).toBe('off')
    })
    it('on and silent past settling is a real problem: late, and alerts', () => {
      const s = status()
      s.store.syncIntents([{ machine: 'apps', intent: 'on-demand' }])
      s.store.setObservedPower('apps', true, T0 - 3600_000, T0 - 3600_000)
      s.store.upsert([machineRow(T0 + MIN)])
      s.clock.now = T0 + 20 * MIN
      s.store.checkAlerts()
      expect(s.titles()).toEqual(['apps'])
    })
  })

  describe('server-restart', () => {
    const gem = (nextRun: number): StatusRow => ({
      id: 'gem/machine',
      what: 'Proxmox host',
      kind: 'machine',
      machine: 'gem',
      state: 'ok',
      meaning: 'Reporting.',
      next_run: new Date(nextRun).toISOString(),
    })
    it('a report lost to a restart does not make a healthy host late', () => {
      const s = status({ server: true })
      s.store.upsert([gem(T0 + 2 * MIN)])
      s.clock.now = T0 + 5 * MIN
      s.store.checkAlerts()
      expect(s.store.read().rows[0]?.shown).toBe('unknown')
      s.store.upsert([gem(s.clock.now + 12 * MIN)])
      expect(s.titles()).toEqual([])
    })
    it('a host still silent after the wait is late', () => {
      const s = status({ server: true })
      s.store.upsert([gem(T0 + 2 * MIN)])
      s.clock.now = T0 + 11 * MIN
      s.store.checkAlerts()
      expect(s.titles()).toEqual(['Proxmox host'])
    })
  })

  describe('link-power', () => {
    const settings = { machine: HOST, deadMs: 5 * MIN }
    const peer = { name: 'guest', connected: false, lastSeen: T0 - 3600_000 }
    it('just started: its link has the full window from when it was seen running', () => {
      const row = peerStatusRow(settings, peer, 'worker', 'running', T0 - 86400_000, T0)
      expect(row.next_run).toBe(new Date(T0 + 5 * MIN).toISOString())
    })
    it('running with no link past the window is still late', () => {
      const s = status()
      s.store.upsert([
        peerStatusRow(settings, peer, 'worker', 'running', T0 - 86400_000, T0 - 20 * MIN),
      ])
      s.store.checkAlerts()
      expect(s.titles()).toEqual(['Link to guest'])
    })
  })

  describe('ssh that fails for another reason is not a machine that is off', () => {
    const external = (err: string, code = 255) => ({ code, err })
    it('hostAway needs ssh to say it could not reach the host', () => {
      for (const err of [
        'ssh: connect to host h port 22: Connection refused',
        'ssh: connect to host h port 22: Connection timed out',
        'ssh: connect to host h port 22: No route to host',
        'Connection closed by 10.0.0.1 port 22',
      ])
        expect(hostAway(external(err))).toBe(true)
      for (const err of [
        'root@h: Permission denied (publickey).',
        'Host key verification failed.',
        'Warning: Identity file /x not accessible: No such file or directory.',
        '',
      ])
        expect(hostAway(external(err))).toBe(false)
      expect(hostAway(external('Connection refused', 1))).toBe(false)
    })
  })

  describe('a T7 that comes back', () => {
    const row = (): BackupEntry =>
      ({ id: 'native/x', target: 'native', state: 'failed', meaning: 'old' }) as BackupEntry
    it('stays off until a run has finished since it came back, and says so', () => {
      const items = [row()]
      markUnplugged(items, true, true)
      expect(items[0]).toMatchObject({ state: 'off', nextRun: null })
      expect(items[0]?.meaning).toContain('back')
    })
    it('once a run has finished, its rows speak for themselves', () => {
      const items = [row()]
      markUnplugged(items, true, false)
      expect(items[0]?.state).toBe('failed')
    })
  })

  describe('an unplugged disk', () => {
    const mounts = '/dev/sda1 /media/me/Backups fuseblk rw 0 0\n'
    it('off when its disk is not mounted, a failure when the folder is missing from a mounted disk', () => {
      expect(diskAway('/media/me/Gone/archive', mounts)).toBe(true)
      expect(diskAway('/media/me/Backups/archive-not-there', mounts)).toBe(false)
      expect(diskAway('/srv/data/missing', mounts)).toBe(false)
    })
  })

  describe('release-push', () => {
    const link = (state: 'off' | 'warn'): StatusRow => ({
      id: 'fleet/standby/guest',
      what: 'Link to guest',
      kind: 'machine',
      machine: 'guest',
      state,
      meaning: 'Link.',
      next_run: new Date(T0 + 24 * 60 * MIN).toISOString(),
    })
    const sustained = (kind: 'check' | 'service') => {
      const s = status()
      const told: { stayed: string[]; recovered: string[] }[] = []
      s.store.onSustained({ 'data-risk': 26 * 60 * MIN, outage: 30 * MIN }, (item) =>
        told.push({ stayed: item.stayed.map((r) => r.row.id), recovered: item.recovered }),
      )
      const flip = () => {
        s.clock.now += 20 * MIN
        s.store.upsert([link('warn')])
        s.clock.now += 5000
        s.store.upsert([link('off')])
      }
      s.store.upsert([
        link('warn'),
        {
          id: 'tether/release-update/guest',
          what: 'Tether release on guest',
          kind,
          machine: 'guest',
          state: 'failed',
          meaning: 'No signed release.',
        },
      ])
      s.clock.now += 40 * MIN
      s.store.checkAlerts()
      for (let i = 0; i < 46; i++) flip()
      return told
    }
    it('a release push that did not land never reaches the phone', () => {
      expect(sustained('check')).toEqual([])
    })
    it('a failed service on a host whose link flips at every restart tells the phone once', () => {
      const told = sustained('service')
      expect(told.flatMap((t) => t.stayed)).toEqual(['tether/release-update/guest'])
      expect(told.flatMap((t) => t.recovered)).toEqual(['tether/release-update/guest'])
    })
  })

  describe('owner-booting', () => {
    const c = () => cfg()
    const id = 'external/portfolio-ai-complete'
    const rt = (run: Runtime['run'], at: number): Runtime => ({
      cfg: c(),
      run,
      now: () => new Date(at),
    })
    const running = async (argv: string[]) =>
      argv.includes('status')
        ? { code: 0, out: 'status: running\n', err: '' }
        : { code: 0, out: JSON.stringify({ exitcode: 0, 'out-data': '' }), err: '' }
    const noHost = async () => ({
      code: 255,
      out: '',
      err: 'ssh: connect to host h port 22: No route to host',
    })
    it('just booted, or a host not up yet: no failure', async () => {
      for (const run of [running, noHost]) {
        const state = emptyState()
        await observeExternal(rt(run, T0), state, ['portfolio-ai-complete'])
        expect(state.copies[id]?.error).toBeUndefined()
      }
    })
    it('the Proxmox host off for days: off the whole time, never Failed', async () => {
      const state = emptyState()
      for (const at of [T0, T0 + 31 * MIN, T0 + 3 * 24 * 60 * MIN]) {
        await observeExternal(rt(noHost, at), state, ['portfolio-ai-complete'])
        expect(state.copies[id]).toMatchObject({ observed: 'offline' })
        expect(state.copies[id]?.error).toBeUndefined()
      }
    })
    it('a rejected key on a running host: Failed once the window has passed', async () => {
      const rejected = async () => ({
        code: 255,
        out: '',
        err: 'root@h: Permission denied (publickey).',
      })
      const state = emptyState()
      await observeExternal(rt(rejected, T0), state, ['portfolio-ai-complete'])
      expect(state.copies[id]?.error).toBeUndefined()
      await observeExternal(rt(rejected, T0 + 31 * MIN), state, ['portfolio-ai-complete'])
      expect(state.copies[id]?.observed).toBe('failed')
    })
    it('back after days off with its old artifact: its age counts from the return', async () => {
      const old = T0 - 20 * 24 * 60 * MIN
      const artifact = async (argv: string[]) =>
        argv.includes('status')
          ? { code: 0, out: 'status: running\n', err: '' }
          : { code: 0, out: JSON.stringify({ exitcode: 0, 'out-data': `${old / 1000},` }), err: '' }
      const state = emptyState()
      state.copies[id] = {
        source: 'portfolio-ai-complete',
        target: 'drive',
        dataAt: new Date(old).toISOString(),
        observed: 'offline',
      }
      await observeExternal(rt(artifact, T0), state, ['portfolio-ai-complete'])
      expect(state.copies[id]).toMatchObject({ observed: 'ok', backAt: new Date(T0).toISOString() })
      await observeExternal(rt(artifact, T0 + 10 * MIN), state, ['portfolio-ai-complete'])
      expect(state.copies[id]?.backAt).toBe(new Date(T0).toISOString())
    })
    it('still unreadable after the window: Failed', async () => {
      const state = emptyState()
      await observeExternal(rt(running, T0), state, ['portfolio-ai-complete'])
      await observeExternal(rt(running, T0 + 31 * MIN), state, ['portfolio-ai-complete'])
      expect(state.copies[id]?.error).toContain('No readable owner backup artifact')
    })
    it('a good read ends it', async () => {
      const state = emptyState()
      await observeExternal(rt(running, T0), state, ['portfolio-ai-complete'])
      const good = async (argv: string[]) =>
        argv.includes('status')
          ? { code: 0, out: 'status: running\n', err: '' }
          : { code: 0, out: JSON.stringify({ exitcode: 0, 'out-data': `${T0 / 1000},` }), err: '' }
      await observeExternal(rt(good, T0 + 31 * MIN), state, ['portfolio-ai-complete'])
      expect(state.copies[id]).toMatchObject({ observed: 'ok' })
      expect(state.copies[id]?.unreadSince).toBeUndefined()
    })
  })

  describe('everything off for a vacation, then back', () => {
    it('no alert from the rows left waiting, while each machine returns', () => {
      const s = status({ server: true })
      const week = 7 * 24 * 3600_000
      const stale: StatusRow[] = [
        ['gem/machine', 'Proxmox host', 'machine', 'gem'],
        ['standby/machine', 'Standby', 'machine', 'standby'],
        ['gem/check', 'Proxmox checks', 'check', 'gem'],
        [`${HOST}/backup/native/root`, '/ recovery · T7', 'backup', HOST],
        [`${HOST}/backup/drive/x`, 'Aico databases and photos · Drive', 'backup', HOST],
      ].map(([id, what, kind, machine]) => ({
        id,
        what,
        kind,
        machine,
        state: 'ok',
        meaning: 'Fine.',
        next_run: new Date(T0 - week).toISOString(),
      })) as StatusRow[]
      s.store.upsert(stale)
      s.beat()
      expect(s.titles()).toEqual([])
      s.clock.now = T0 + 5 * MIN
      s.store.upsert(
        ['gem/machine', 'standby/machine'].map((id) => ({
          ...(stale.find((r) => r.id === id) as StatusRow),
          next_run: new Date(s.clock.now + 12 * MIN).toISOString(),
        })),
      )
      s.beat()
      expect(s.titles()).toEqual([])
      expect(s.store.read().summary.problems).toBe(0)
    })
  })
})
