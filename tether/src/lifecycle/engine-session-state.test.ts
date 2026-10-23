// The engine's session-state and pane-verification checks that retirement
// relies on (engineRetirementOperations): presence or absence is read only
// from a roster proven against its exact server tuple, and a name match never
// grants stop authority. Nothing here starts tmux or systemd units.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_INSTANCE, resolvePaths } from '../config'
import { Store } from '../store'
import { bindCatalog, getWidget, insertWidget, type WidgetRow } from './catalog'
import {
  configureEngine,
  engineRetirementOperations,
  internalSessionState,
  verifiedCurrentManagedPane,
} from './engine'
import { retireOwnedSession } from './owner-retirement'
import { setLifecycleInstance } from './ownership'
import { configureTmuxPaths, serverRosterArgs } from './tmux'
import { bindToolSource } from './tui/registry'

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  readFileSync: vi.fn(),
  realReadFileSync: null as unknown as (...args: unknown[]) => unknown,
  scopeIdentity: vi.fn(),
  stopOwnedPaneScope: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: mocks.execFile,
  execFileSync: mocks.execFileSync,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  mocks.realReadFileSync = actual.readFileSync as (...args: unknown[]) => unknown
  return { ...actual, readFileSync: mocks.readFileSync }
})
vi.mock('./owner-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./owner-scope')>()),
  scopeIdentity: mocks.scopeIdentity,
  stopOwnedPaneScope: mocks.stopOwnedPaneScope,
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
  mocks.execFileSync.mockReturnValue(lines.map((line) => `${line}\n`).join(''))
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
  it('proves a missing-ID session absent from the exact verified server roster', async () => {
    const row = seed()
    expect(await internalSessionState(row.id)).toBe('absent')
    expect(mocks.execFileSync).toHaveBeenCalledExactlyOnceWith(
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

  it.each([
    'own',
    'other',
  ])('keeps state unknown on a socket collision (%s name)', async (which) => {
    const row = seed()
    roster(`4321\t$3\t${which === 'own' ? `aico-${row.id}` : 'aico-4369c029'}\t100`)
    expect(await internalSessionState(row.id)).toBe('unknown')
  })

  it('keeps state unknown when the exact live server does not answer', async () => {
    const row = seed()
    mocks.execFileSync.mockImplementation(() => {
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
    expect(mocks.execFileSync.mock.calls.length).toBeGreaterThan(0)
    for (const [, args] of mocks.execFileSync.mock.calls) {
      expect(args).toEqual(serverRosterArgs(SOCKET))
    }
    expect(mocks.execFile).not.toHaveBeenCalled()
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
