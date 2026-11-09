// The engine's session-state and pane-verification checks that retirement
// relies on (engineRetirementOperations): presence or absence is read only
// from a roster proven against its exact server tuple, and a name match never
// grants stop authority. Nothing here starts tmux or systemd units.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_INSTANCE, resolvePaths } from '../paths'
import { Store } from '../store'
import { AgentAdmission } from './agent-admission'
import { bindCatalog, getWidget, insertWidget, type WidgetRow } from './catalog'
import {
  configureEngine,
  engineRetirementOperations,
  ensureSessionSerialized,
  internalSessionState,
  lastEnsureFailure,
  rootManagedGateState,
  verifiedCurrentManagedPane,
} from './engine'
import { retireOwnedSession } from './owner-retirement'
import { setLifecycleInstance } from './ownership'
import {
  configureTmuxPaths,
  listSessionPanesTargetArgs,
  serverRosterArgs,
  sessionIdTargetArgs,
} from './tmux'
import { bindToolSource } from './tui/registry'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readlinkSync: vi.fn(),
  cgroupProcessIds: vi.fn(),
  realReadFileSync: null as unknown as (...args: unknown[]) => unknown,
  scopeIdentity: vi.fn(),
  stopOwnedPaneScope: vi.fn(),
  resolveLauncher: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return {
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFile: Object.assign(mocks.execFile, { [promisify.custom]: mocks.execFile }),
    execFileSync: mocks.execFileSync,
  }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  mocks.realReadFileSync = actual.readFileSync as (...args: unknown[]) => unknown
  return { ...actual, readFileSync: mocks.readFileSync, readlinkSync: mocks.readlinkSync }
})
vi.mock('./owner-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./owner-scope')>()),
  scopeIdentity: mocks.scopeIdentity,
  stopOwnedPaneScope: mocks.stopOwnedPaneScope,
}))
vi.mock('./tui/context-support', () => ({ resolveLauncher: mocks.resolveLauncher }))
vi.mock('./procfs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./procfs')>()),
  cgroupProcessIds: mocks.cgroupProcessIds,
}))

const INSTANCE = 'enginetest'
const SERVER = '1'.repeat(32)
const SERVER_INVOCATION = 'a'.repeat(32)
const SERVER_PID = 1234
const START_TIME = '987654'
const SERVER_UNIT = `tether-${INSTANCE}-tmux-server-${SERVER}.service`
const SERVER_CGROUP = `/user.slice/user-1000.slice/user@1000.service/app.slice/${SERVER_UNIT}`
const SOCKET = `/tmp/tether-engine-session-state/${SERVER}/server.sock`

let dir: string
let store: Store
let seq = 0

function seed(fields: { tmuxSessionId?: string | null } = {}): WidgetRow {
  seq += 1
  const id = `e1${String(seq).padStart(6, '0')}`
  insertWidget(id, 'shell', 1)
  store.db
    .prepare(
      `UPDATE sessions SET tmux_server_id = ?, tmux_allocation_state = 'bound',
         tmux_session_id = ?, pane_id = NULL, scope_unit = NULL, scope_invocation_id = NULL,
         lifecycle_version = 1 WHERE id = ?`,
    )
    .run(SERVER, fields.tmuxSessionId ?? null, id)
  return getWidget(id) as WidgetRow
}

function roster(...lines: string[]): void {
  const stdout = lines.map((line) => `${line}\n`).join('')
  mocks.execFileSync.mockReturnValue(stdout)
  mocks.execFile.mockResolvedValue({ stdout, stderr: '' })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-engine-state-'))
  store = new Store(':memory:')
  bindCatalog(store.db)
  bindToolSource(store)
  setLifecycleInstance(INSTANCE)
  const paths = resolvePaths({
    instance: INSTANCE,
    env: {
      HOME: dir,
      TETHER_STATE_DIR: join(dir, 'state'),
      TETHER_RUNTIME_DIR: join(dir, 'run'),
    },
    uid: process.getuid?.() ?? 1000,
  })
  configureTmuxPaths({
    historicalSocket: join(paths.runtimeDir, 'no-historical-tmux'),
    paneExitMarkerDir: paths.paneExitMarkerDir,
  })
  configureEngine({
    paths,
    events: null,
    env: { HOME: dir, PATH: '/usr/bin:/bin' },
    projectRoot: () => null,
  })
  store.db
    .prepare(
      `INSERT INTO tmux_servers (id, kind, phase, socket_path, scope_unit, control_group,
         invocation_id, server_pid, proc_starttime, created_at, dead_at)
       VALUES (?, 'managed', 'active', ?, ?, ?, ?, ?, ?, 100, NULL)`,
    )
    .run(SERVER, SOCKET, SERVER_UNIT, SERVER_CGROUP, SERVER_INVOCATION, SERVER_PID, START_TIME)
})

afterAll(() => {
  setLifecycleInstance(DEFAULT_INSTANCE)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => vi.restoreAllMocks())

beforeEach(() => {
  vi.resetAllMocks()
  roster(`${SERVER_PID}\t$3\taico-4369c029\t100`)
  mocks.readFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
    if (path === `/proc/${SERVER_PID}/stat`) {
      return `${SERVER_PID} (tmux: server) ${Array.from({ length: 20 }, (_, index) =>
        index === 19 ? START_TIME : '0',
      ).join(' ')}`
    }
    if (path === `/proc/${SERVER_PID}/cgroup`) return `0::${SERVER_CGROUP}\n`
    if (typeof path === 'string' && path.startsWith('/proc/')) {
      throw new Error(`unexpected proc read: ${path}`)
    }
    return mocks.realReadFileSync(path, ...rest)
  })
  mocks.scopeIdentity.mockResolvedValue({
    loadState: 'loaded',
    activeState: 'active',
    controlGroup: SERVER_CGROUP,
    invocationId: SERVER_INVOCATION,
    job: '',
  })
})

describe('engine session state', () => {
  it('uses a surviving gate environment and cwd when checking a recovered launch', async () => {
    const seeded = seed({ tmuxSessionId: '$3' })
    const unit = 'tmux-spawn-00000000-0000-4000-8000-000000000002.scope'
    const group = `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`
    const invocation = 'c'.repeat(32)
    store.db
      .prepare(`UPDATE sessions SET tool = 'codex', pane_id = '%7', scope_unit = ?,
        scope_invocation_id = ?, launch_state = 'gated', launch_nonce = ? WHERE id = ?`)
      .run(unit, invocation, 'b'.repeat(32), seeded.id)
    const row = getWidget(seeded.id) as WidgetRow
    const target = { socket: SOCKET, session: '$3' }
    const procRead = mocks.readFileSync.getMockImplementation()
    mocks.readFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
      if (path === '/proc/4321/stat')
        return `4321 (bash) ${Array.from({ length: 20 }, (_, i) => (i === 19 ? '123' : '0')).join(' ')}`
      if (path === '/proc/4321/cgroup') return `0::${group}\n`
      if (path === '/proc/4321/environ')
        return [
          'AICO_OWNER=aico',
          'AICO_WORKLOAD_CLASS=durable-session',
          `AICO_WIDGET_ID=${row.id}`,
          `AICO_SESSION_ID=${row.sessionId}`,
          `AICO_TMUX_SERVER_ID=${SERVER}`,
          'AICO_LIFECYCLE_VERSION=1',
          'AICO_AGENT_SLUG=codex',
          'AICO_PROJECT_ID=',
          'HOME=/retained/home',
          'PATH=/retained/missing-bin',
          'XDG_CONFIG_HOME=/retained/config',
          '',
        ].join('\0')
      if (path === '/proc/4321/cmdline') return '/bin/bash\0--noprofile\0--norc\0'
      return procRead?.(path, ...rest)
    })
    mocks.readlinkSync.mockReturnValue('/retained/cwd')
    mocks.cgroupProcessIds.mockReturnValue([4321])
    mocks.scopeIdentity.mockImplementation(async (name: string) => ({
      loadState: 'loaded',
      activeState: 'active',
      job: '',
      controlGroup: name === unit ? group : SERVER_CGROUP,
      invocationId: name === unit ? invocation : SERVER_INVOCATION,
    }))
    mocks.execFile.mockImplementation(async (_file: string, args: string[]) => {
      if (JSON.stringify(args) === JSON.stringify(serverRosterArgs(SOCKET)))
        return { stdout: `${SERVER_PID}\t$3\taico-${row.id}\t100\n` }
      if (JSON.stringify(args) === JSON.stringify(listSessionPanesTargetArgs(target)))
        return { stdout: '%7\t4321\n' }
      if (JSON.stringify(args) === JSON.stringify(sessionIdTargetArgs(target)))
        return { stdout: '$3\n' }
      throw new Error('unexpected subprocess')
    })
    const ticket = { commit: vi.fn(), release: vi.fn() }
    vi.spyOn(AgentAdmission.prototype, 'reserve').mockResolvedValue(ticket)
    mocks.resolveLauncher.mockResolvedValue(null)
    expect(await ensureSessionSerialized(row.id, { cols: 80, rows: 24 })).toBe(false)
    expect(mocks.resolveLauncher).toHaveBeenCalledWith(
      'codex',
      expect.anything(),
      expect.objectContaining({
        env: expect.objectContaining({
          HOME: '/retained/home',
          PATH: '/retained/missing-bin',
          XDG_CONFIG_HOME: '/retained/config',
        }),
        cwd: '/retained/cwd',
      }),
    )
    expect(lastEnsureFailure(row.id)?.code).toBe('workload_unavailable')
    expect(getWidget(row.id)?.launchState).toBe('gated')
    expect(ticket.commit).not.toHaveBeenCalled()
    expect(mocks.execFileSync).not.toHaveBeenCalled()
  })

  it('shares only in-flight server probes and never blocks on synchronous tmux reads', async () => {
    const row = seed({ tmuxSessionId: '$3' })
    roster(`${SERVER_PID}\t$3\taico-${row.id}\t100`)
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('synchronous tmux probe blocks the control socket')
    })
    expect(
      await Promise.all([
        internalSessionState(row.id),
        internalSessionState(row.id),
        internalSessionState(row.id),
      ]),
    ).toEqual(['present', 'present', 'present'])
    expect(mocks.execFile).toHaveBeenCalledTimes(1)
    expect(mocks.scopeIdentity).toHaveBeenCalledTimes(1)
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    roster(`4321\t$3\taico-${row.id}\t100`)
    expect(await internalSessionState(row.id)).toBe('unknown')
    expect(mocks.execFile).toHaveBeenCalledTimes(2)
  })

  it('coalesces exact root gate probes while reading pane identity asynchronously and freshly', async () => {
    const seeded = seed({ tmuxSessionId: '$3' })
    const unit = 'tmux-spawn-00000000-0000-4000-8000-000000000001.scope'
    const group = `/user.slice/user-${process.getuid?.()}.slice/user@${process.getuid?.()}.service/app.slice/${unit}`
    const invocation = 'c'.repeat(32)
    store.db
      .prepare(`UPDATE sessions SET pane_id = '%7', scope_unit = ?,
      scope_invocation_id = ? WHERE id = ?`)
      .run(unit, invocation, seeded.id)
    const row = getWidget(seeded.id) as WidgetRow
    const target = { socket: SOCKET, session: '$3' }
    const procRead = mocks.readFileSync.getMockImplementation()
    mocks.readFileSync.mockImplementation((path: unknown, ...rest: unknown[]) => {
      if (path === '/proc/4321/stat')
        return `4321 (codex) ${Array.from({ length: 20 }, (_, i) => (i === 19 ? '123' : '0')).join(' ')}`
      if (path === '/proc/4321/cgroup') return `0::${group}\n`
      if (path === '/proc/4321/environ')
        return [
          'AICO_OWNER=aico',
          'AICO_WORKLOAD_CLASS=durable-session',
          `AICO_WIDGET_ID=${row.id}`,
          `AICO_SESSION_ID=${row.sessionId}`,
          `AICO_TMUX_SERVER_ID=${SERVER}`,
          'AICO_LIFECYCLE_VERSION=1',
          '',
        ].join('\0')
      if (path === '/proc/4321/cmdline') return 'codex\0'
      return procRead?.(path, ...rest)
    })
    mocks.scopeIdentity.mockImplementation(async (name: string) => ({
      loadState: 'loaded',
      activeState: 'active',
      job: '',
      controlGroup: name === unit ? group : SERVER_CGROUP,
      invocationId: name === unit ? invocation : SERVER_INVOCATION,
    }))
    mocks.execFile.mockImplementation(async (_file: string, args: string[]) => {
      const key = JSON.stringify(args)
      if (key === JSON.stringify(serverRosterArgs(SOCKET)))
        return { stdout: `${SERVER_PID}\t$3\taico-${row.id}\t100\n` }
      if (key === JSON.stringify(listSessionPanesTargetArgs(target)))
        return { stdout: '%7\t4321\n' }
      if (key === JSON.stringify(sessionIdTargetArgs(target))) return { stdout: '$3\n' }
      throw new Error('unexpected subprocess')
    })
    mocks.execFileSync.mockImplementation(() => {
      throw new Error('synchronous probe')
    })
    expect(
      await Promise.all([
        rootManagedGateState(row),
        rootManagedGateState(row),
        rootManagedGateState(row),
      ]),
    ).toEqual(['active-workload', 'active-workload', 'active-workload'])
    expect(mocks.execFile).toHaveBeenCalledTimes(3)
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(await rootManagedGateState({ ...row, paneId: '%8' })).toBeNull()
    expect(await rootManagedGateState(row)).toBe('active-workload')
    expect(mocks.execFile).toHaveBeenCalledTimes(9)
    // A healthy workload remains attachable if its executable was removed
    // from PATH after launch. No new launcher is needed for this session.
    store.db.prepare("UPDATE sessions SET tool = 'codex' WHERE id = ?").run(row.id)
    mocks.resolveLauncher.mockResolvedValue(null)
    expect(await ensureSessionSerialized(row.id, { cols: 80, rows: 24 })).toBe(true)
    expect(mocks.resolveLauncher).not.toHaveBeenCalled()
    expect(mocks.execFileSync).not.toHaveBeenCalled()
  })

  it('proves a missing-ID session absent from the exact verified server roster', async () => {
    const row = seed()
    expect(await internalSessionState(row.id)).toBe('absent')
    expect(mocks.execFile).toHaveBeenCalledExactlyOnceWith(
      '/usr/bin/tmux',
      serverRosterArgs(SOCKET),
      expect.objectContaining({ timeout: expect.any(Number) }),
    )
    expect(mocks.scopeIdentity).toHaveBeenCalledExactlyOnceWith(SERVER_UNIT)
  })

  it('finds a missing-ID session by its exact managed name', async () => {
    const row = seed()
    roster(`${SERVER_PID}\t$3\taico-${row.id}\t100`)
    expect(await internalSessionState(row.id)).toBe('present')
  })

  it('does not match a managed-name prefix', async () => {
    const row = seed()
    roster(`${SERVER_PID}\t$3\taico-${row.id}-other\t100`)
    expect(await internalSessionState(row.id)).toBe('absent')
  })

  it.each([
    { id: '$3', name: 'renamed', expected: 'present' },
    { id: '$4', name: 'managed', expected: 'absent' },
  ])('uses a stored session ID instead of the name ($expected)', async ({ id, name, expected }) => {
    const row = seed({ tmuxSessionId: '$3' })
    roster(`${SERVER_PID}\t${id}\t${name === 'managed' ? `aico-${row.id}` : name}\t100`)
    expect(await internalSessionState(row.id)).toBe(expected)
  })

  it.each(['own', 'other'])(
    'keeps state unknown on a socket collision (%s name)',
    async (which) => {
      const row = seed()
      roster(`4321\t$3\t${which === 'own' ? `aico-${row.id}` : 'aico-4369c029'}\t100`)
      expect(await internalSessionState(row.id)).toBe('unknown')
    },
  )

  it('keeps state unknown when the exact live server does not answer', async () => {
    const row = seed()
    mocks.execFile.mockImplementation(() => {
      throw Object.assign(new Error('transport failed'), {
        stderr: `no server running on ${SOCKET}`,
      })
    })
    expect(await internalSessionState(row.id)).toBe('unknown')
    expect(mocks.scopeIdentity).toHaveBeenCalledExactlyOnceWith(SERVER_UNIT)
  })

  it('requires the exact systemd invocation before reading absence', async () => {
    const row = seed()
    mocks.scopeIdentity.mockResolvedValue({
      loadState: 'loaded',
      activeState: 'active',
      controlGroup: SERVER_CGROUP,
      invocationId: 'd'.repeat(32),
      job: '',
    })
    expect(await internalSessionState(row.id)).toBe('unknown')
  })

  it('keeps malformed roster evidence unknown', async () => {
    const row = seed()
    roster(`${SERVER_PID}\tinvalid-id\taico-4369c029\t100`)
    expect(await internalSessionState(row.id)).toBe('unknown')
  })
})

describe('engine retirement operations', () => {
  it('ends a reconciled missing-ID session after verified roster absence without killing work', async () => {
    const row = seed()
    expect(await retireOwnedSession(row.id, engineRetirementOperations)).toEqual({
      status: 'ended',
    })
    expect(getWidget(row.id)).toBeUndefined()
    expect(mocks.execFile.mock.calls.length).toBeGreaterThan(0)
    for (const [, args] of mocks.execFile.mock.calls) {
      expect(args).toEqual(serverRosterArgs(SOCKET))
    }
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.stopOwnedPaneScope).not.toHaveBeenCalled()
  })

  it('does not grant pane verification or stop authority from a name match', async () => {
    const row = seed()
    roster(`${SERVER_PID}\t$3\taico-${row.id}\t100`)
    const named = { ...row, paneId: '%7', scopeUnit: 'x.scope', scopeInvocationId: 'c'.repeat(32) }
    expect(await verifiedCurrentManagedPane(named)).toBeNull()
    await expect(engineRetirementOperations.stopTmuxSession(named)).rejects.toThrow(
      'managed pane identity changed before stop',
    )
    expect(mocks.execFileSync).not.toHaveBeenCalled()
    expect(mocks.execFile).not.toHaveBeenCalled()
  })
})
