// One test per containment invariant Tether inherits from Aico.
//
// Sources: aico docs/INCIDENT-2026-07-PROCESS-ESCAPES.md ("Repair boundary",
// "Safe recovery") and aico CONTEXT.md ("Owner and fleet state"), plus the
// Tether-specific instance rules in docs/compat-contract.md. Each `describe`
// names the invariant; detailed behavior stays in the ported module tests.
//
// Nothing here starts tmux, systemd units or processes.

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_INSTANCE, ownsTmuxServerUnit, resolvePaths, type TetherPaths } from '../config'
import { LegacyATermSessions } from '../legacy-aterm'
import { Store } from '../store'
import {
  allocateWidgetId,
  bindCatalog,
  compareAndSetWidgetOwnership,
  getWidget,
  insertWidget,
  reserveRootRequest,
  setWidgetOwnership,
  type TmuxServerRow,
  type WidgetRow,
} from './catalog'
import {
  configureEngine,
  endSession,
  ensureSessionSerialized,
  lastEnsureFailure,
  lifecycleOwners,
  managedEnvironment,
  ownsServerRow,
  releaseLifecycleOwner,
  respawnAndRelaunch,
  serverEnvironmentPrefix,
} from './engine'
import { decideManagedGateRecovery, isNeverAllocatedWidget } from './lifecycle-guard'
import { ownershipGeneration, retireOwnedSession, sessionGeneration } from './owner-retirement'
import { stopOwnedPaneScope } from './owner-scope'
import {
  durableTmuxServerArgs,
  isOwnedPaneControlGroup,
  paneScopeFromCgroup,
  setLifecycleInstance,
} from './ownership'
import {
  configureTmuxPaths,
  newDetachedTargetArgs,
  PANE_GATE_COMMAND,
  paneExitedHookCommand,
  respawnTargetArgs,
} from './tmux'
import { classifyTmuxServerState } from './tmux-server-state'
import { bindToolSource } from './tui/registry'

const SERVER = 'a'.repeat(32)
const INVOCATION = 'b'.repeat(32)
const uid = process.getuid?.() ?? 1000
let dir: string
let store: Store
let paths: TetherPaths

function configure(instance: string, env: NodeJS.ProcessEnv = {}): void {
  setLifecycleInstance(instance)
  paths = resolvePaths({
    instance,
    env: {
      HOME: dir,
      TETHER_STATE_DIR: join(dir, instance, 'state'),
      TETHER_RUNTIME_DIR: join(dir, instance, 'run'),
    },
    uid,
  })
  configureTmuxPaths({
    historicalSocket: paths.historicalTmuxSocket ?? join(paths.runtimeDir, 'no-historical-tmux'),
    paneExitMarkerDir: paths.paneExitMarkerDir,
  })
  configureEngine({
    paths,
    events: null,
    env: { HOME: dir, PATH: '/usr/bin:/bin', ...env },
    projectRoot: () => null,
  })
}

function server(overrides: Partial<TmuxServerRow>): TmuxServerRow {
  return {
    id: SERVER,
    kind: 'managed',
    phase: 'active',
    socketPath: `/tmp/x/${SERVER}/server.sock`,
    scopeUnit: `aico-tmux-server-${SERVER}.service`,
    controlGroup: '/cg',
    invocationId: INVOCATION,
    serverPid: 10,
    procStartTime: '5',
    createdAt: 1,
    deadAt: null,
    ...overrides,
  } as TmuxServerRow
}

/** Seed a managed v1 row bound to a dead server (no live tmux needed). */
function seedBound(id: string, lifecycleVersion: number): WidgetRow {
  insertWidget(id, 'shell', 1)
  store.db
    .prepare(
      `INSERT OR IGNORE INTO tmux_servers (id, kind, phase, socket_path, scope_unit, created_at, dead_at)
       VALUES (?, 'managed', 'dead', ?, ?, 1, 2)`,
    )
    .run(SERVER, `/tmp/x/${SERVER}/server.sock`, `aico-tmux-server-${SERVER}.service`)
  store.db
    .prepare(
      `UPDATE sessions SET tmux_server_id = ?, tmux_allocation_state = 'bound',
         tmux_session_id = '$1', pane_id = '%1', lifecycle_version = ? WHERE id = ?`,
    )
    .run(SERVER, lifecycleVersion, id)
  return getWidget(id) as WidgetRow
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tether-inv-'))
  store = new Store(':memory:')
  bindCatalog(store.db)
  bindToolSource(store)
  configure('invtest')
})

afterAll(() => {
  setLifecycleInstance(DEFAULT_INSTANCE)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('INV-01 historical tmux server is adopted read-only, and only by default', () => {
  it('a non-default instance never owns the legacy-observed (historical) server row', () => {
    configure('invtest')
    expect(ownsServerRow(server({ kind: 'legacy-observed', scopeUnit: 'app-x.scope' }))).toBe(false)
    expect(paths.historicalTmuxSocket).toBeNull()
    configure(DEFAULT_INSTANCE)
    expect(ownsServerRow(server({ kind: 'legacy-observed', scopeUnit: 'app-x.scope' }))).toBe(true)
    expect(paths.historicalTmuxSocket).toBe(`/tmp/tmux-${uid}/aico`)
    configure('invtest')
  })
})

describe('INV-02 new servers are manager-spawned services with a clean descriptor table and env', () => {
  it('uses Type=exec, ExitType=cgroup, null stdin, no $ expansion, and env -i with an allow-list', () => {
    configure('invtest', {
      OPENAI_API_KEY: 'sk-test-not-a-secret',
      UNLISTED_VARIABLE: 'x',
      TMUX: '/tmp/tmux-1/default,1,0',
      LANG: 'en_US.UTF-8',
    })
    const argv = durableTmuxServerArgs(SERVER, ['new-session'], serverEnvironmentPrefix(SERVER))
    for (const flag of [
      '--service-type=exec',
      '--property=ExitType=cgroup',
      '--property=StandardInput=null',
      '--expand-environment=no',
      '--slice=app.slice',
    ])
      expect(argv).toContain(flag)
    expect(argv).not.toContain('--pipe')
    expect(argv).not.toContain('--pty')
    const tail = argv.slice(argv.indexOf('--') + 1)
    expect(tail.slice(0, 2)).toEqual(['/usr/bin/env', '-i'])
    expect(tail).toContain('AICO_OWNER=aico')
    expect(tail).toContain('AICO_WORKLOAD_CLASS=durable-tmux-server')
    expect(tail).toContain(`AICO_TMUX_SERVER_ID=${SERVER}`)
    expect(tail).toContain('LANG=en_US.UTF-8')
    expect(tail.some((arg) => arg.startsWith('OPENAI_API_KEY='))).toBe(false)
    expect(tail.some((arg) => arg.startsWith('UNLISTED_VARIABLE='))).toBe(false)
    expect(tail.some((arg) => arg.startsWith('TMUX='))).toBe(false)
    expect(argv.at(-2)).toBe('/usr/bin/tmux')
    configure('invtest')
  })
})

describe('INV-03 server identity is proven before presence or absence is interpreted', () => {
  it('a socket answering as another PID is a collision, and unreadable /proc is never death', () => {
    const row = server({ phase: 'active' })
    const unit = {
      status: 'active' as const,
      scopeUnit: row.scopeUnit,
      controlGroup: '/cg',
      invocationId: INVOCATION,
    }
    const live = { status: 'present' as const, pid: 10, procStartTime: '5', controlGroup: '/cg' }
    expect(
      classifyTmuxServerState(row, {
        process: live,
        unit,
        roster: { status: 'reachable', serverPid: 11 },
      }),
    ).toBe('socket-collision')
    expect(
      classifyTmuxServerState(row, {
        process: { status: 'unavailable', pid: 10 },
        unit,
        roster: { status: 'transport-failure' },
      }),
    ).toBe('ambiguous')
    expect(
      classifyTmuxServerState(row, {
        process: live,
        unit: { ...unit, invocationId: 'c'.repeat(32) },
        roster: { status: 'reachable', serverPid: 10 },
      }),
    ).toBe('ambiguous')
  })
})

describe('INV-04 every pane starts as a bare no-RC gate; the TUI is sent only after containment', () => {
  it('new-session and respawn-pane run only the gate command', () => {
    const target = { socket: '/tmp/x/s.sock', session: '%1' }
    const created = newDetachedTargetArgs(target, 80, 24, '/tmp/conf', '/tmp', { A: 'b' })
    const respawned = respawnTargetArgs(target, '/tmp', { A: 'b' })
    expect(PANE_GATE_COMMAND).toBe('exec /bin/bash --noprofile --norc')
    expect(created.at(-1)).toBe(PANE_GATE_COMMAND)
    expect(respawned.at(-1)).toBe(PANE_GATE_COMMAND)
    expect(respawned).toContain('-k')
  })
})

describe('INV-05 every ownership mutation is a CAS against the generation it read', () => {
  it('a stale snapshot cannot overwrite a newer ownership generation', () => {
    const row = seedBound('e0000005', 1)
    const stale = ownershipGeneration(row)
    expect(compareAndSetWidgetOwnership(row.id, stale, { ...stale, launchState: 'gated' })).toBe(
      true,
    )
    expect(
      compareAndSetWidgetOwnership(row.id, stale, { ...stale, launchState: 'dispatched' }),
    ).toBe(false)
    expect(getWidget(row.id)?.launchState).toBe('gated')
  })
})

describe('INV-06 a dispatched gate is never auto-replayed', () => {
  it('inert gate + dispatched nonce, or equal current/pending scope, blocks replay', () => {
    expect(
      decideManagedGateRecovery({
        gateState: 'inert',
        launchState: 'dispatched',
        pendingMatchesCurrent: false,
        dispatchGate: true,
      }),
    ).toBe('blocked-replay')
    expect(
      decideManagedGateRecovery({
        gateState: 'inert',
        launchState: 'gated',
        pendingMatchesCurrent: true,
        dispatchGate: true,
      }),
    ).toBe('blocked-replay')
    expect(
      decideManagedGateRecovery({
        gateState: 'inert',
        launchState: 'gated',
        pendingMatchesCurrent: false,
        dispatchGate: true,
      }),
    ).toBe('dispatch')
  })
})

describe('INV-07 retirement stops only the exact owned pane scope', () => {
  it('rejects app/session/user scopes and a missing InvocationID before systemctl', async () => {
    expect(await stopOwnedPaneScope('app-gnome-aico-9189.scope', INVOCATION, 'test')).toBe(false)
    expect(await stopOwnedPaneScope('session-2.scope', INVOCATION, 'test')).toBe(false)
    expect(
      await stopOwnedPaneScope(
        'tmux-spawn-00000000-0000-4000-8000-000000000000.scope',
        null,
        'test',
      ),
    ).toBe(false)
    const unit = 'tmux-spawn-00000000-0000-4000-8000-000000000000.scope'
    expect(isOwnedPaneControlGroup(unit, `/user.slice/user-${uid}.slice/${unit}`, uid)).toBe(false)
    expect(
      paneScopeFromCgroup(
        `0::/user.slice/user-${uid}.slice/user@${uid}.service/app.slice/app-x.scope`,
      ),
    ).toBeNull()
  })
})

describe('INV-08 lifecycle-v0 sessions are preserved read-only', () => {
  it('End and replacement both refuse a v0 session', async () => {
    const row = seedBound('e0000008', 0)
    const generation = sessionGeneration(row)
    const retired = await retireOwnedSession(
      row.id,
      {
        sessionState: async () => 'present',
        verifiedCurrentPane: async () => true,
        stopTmuxSession: async () => {
          throw new Error('must not stop')
        },
        settleServer: async () => {},
      },
      generation,
    )
    expect(retired).toEqual({
      status: 'blocked',
      reason: 'legacy containment lacks exact descendant ownership',
    })
    expect(
      await respawnAndRelaunch(row.id, undefined, {
        expectedGeneration: generation,
        generationOf: sessionGeneration,
      }),
    ).toEqual({ status: 'legacy_session' })
    expect(getWidget(row.id)).toBeDefined()
  })
})

describe('INV-09 the pane-exited hook is generation-specific and instance-scoped', () => {
  it('default keeps /run/user/<uid>/aico; other instances use their own directory', () => {
    configure(DEFAULT_INSTANCE)
    expect(paneExitedHookCommand(SERVER, uid)).toBe(
      `run-shell "/usr/bin/touch /run/user/${uid}/aico/pane-exited-${SERVER}"`,
    )
    configure('invtest')
    expect(paneExitedHookCommand(SERVER, uid)).toBe(
      `run-shell "/usr/bin/touch ${paths.paneExitMarkerDir}/pane-exited-${SERVER}"`,
    )
    expect(paths.paneExitMarkerDir.startsWith(`/run/user/${uid}/aico`)).toBe(false)
  })
})

describe('INV-10 durable work requires Linger=yes', () => {
  it('refuses a never-allocated session before allocating anything', async () => {
    insertWidget('e0000010', 'shell', 1)
    expect(await ensureSessionSerialized('e0000010', { cols: 80, rows: 24 })).toBe(false)
    expect(lastEnsureFailure('e0000010')?.code).toBe('linger_required')
    const row = getWidget('e0000010') as WidgetRow
    expect(isNeverAllocatedWidget(row)).toBe(true)
  })
})

describe('INV-11 unknown or absent-after-allocation state fails closed', () => {
  it('an allocated session whose tmux session is gone is never implicitly relaunched', async () => {
    seedBound('e0000011', 1)
    expect(await ensureSessionSerialized('e0000011', { cols: 80, rows: 24 })).toBe(false)
    expect(lastEnsureFailure('e0000011')?.code).toBe('workload_unavailable')
  })
  it('End refuses when tmux state is unknown', async () => {
    const row = seedBound('e0000111', 1)
    const result = await retireOwnedSession(row.id, {
      sessionState: async () => 'unknown',
      verifiedCurrentPane: async () => true,
      stopTmuxSession: async () => {},
      settleServer: async () => {},
    })
    expect(result).toEqual({ status: 'blocked', reason: 'tmux state is unknown' })
  })
})

describe('INV-12 one lifecycle lock serializes every lifecycle operation', () => {
  it('replacement is busy while another operation holds the session', async () => {
    const row = seedBound('e0000012', 1)
    const owner = lifecycleOwners.acquire(row.id)
    expect(owner).not.toBeNull()
    expect(await respawnAndRelaunch(row.id, undefined)).toEqual({ status: 'busy' })
    // A confirmed End is coalesced and runs as soon as the holder releases.
    const ended = endSession(row.id, sessionGeneration(row))
    releaseLifecycleOwner(row.id, owner as NonNullable<typeof owner>)
    const result = await ended
    expect(result.status).not.toBe('busy')
  })
})

describe('INV-13 pane markers follow the compatibility contract', () => {
  it('sets AICO_OWNER, AICO_AGENT_SLUG, ST_SESSION_ID and A_TERM_SESSION_ID; never AICO_TMUX_SOCKET', () => {
    const previous = process.env.AICO_TMUX_SOCKET
    process.env.AICO_TMUX_SOCKET = '/tmp/should-not-leak'
    try {
      insertWidget('e0000013', 'codex', 1, {
        origin: 'a-term',
        aTermSessionId: '11111111-2222-4333-8444-555555555555',
      })
      const env = managedEnvironment('e0000013', 'codex')
      expect(env).toMatchObject({
        AICO_OWNER: 'aico',
        AICO_WORKLOAD_CLASS: 'durable-session',
        AICO_WIDGET_ID: 'e0000013',
        AICO_SESSION_ID: 'aico-widget-e0000013',
        AICO_AGENT_SLUG: 'codex',
        A_TERM_SESSION_ID: '11111111-2222-4333-8444-555555555555',
      })
      expect(env).not.toHaveProperty('AICO_TMUX_SOCKET')
      reserveRootRequest(
        {
          requestId: 'inv-root',
          digest: 'd',
          widgetId: 'e0000113',
          logicalSessionId: 'aico-root-inv',
          role: 'lead',
          leadRootReference: null,
          facetCapsuleRef: null,
          createdAt: 1,
        },
        'codex',
        'p',
        '/tmp',
      )
      const rootEnv = managedEnvironment('e0000113', 'codex')
      expect(rootEnv.ST_SESSION_ID).toBe('aico-root-inv')
      expect(rootEnv).not.toHaveProperty('A_TERM_SESSION_ID')
    } finally {
      if (previous === undefined) delete process.env.AICO_TMUX_SOCKET
      else process.env.AICO_TMUX_SOCKET = previous
    }
  })
})

describe('INV-14 instances never touch each other’s units, sockets or markers', () => {
  it('unit namespaces are disjoint and legacy sockets belong to default only', () => {
    expect(ownsTmuxServerUnit('dev', `aico-tmux-server-${SERVER}.service`)).toBe(false)
    expect(ownsTmuxServerUnit(DEFAULT_INSTANCE, `tether-dev-tmux-server-${SERVER}.service`)).toBe(
      false,
    )
    expect(ownsTmuxServerUnit('dev', `tether-devx-tmux-server-${SERVER}.service`)).toBe(false)
    configure('invtest')
    expect(ownsServerRow(server({}))).toBe(false)
    expect(paths.legacyControlSocket).toBeNull()
    expect(paths.legacyGuiSocket).toBeNull()
  })
})

describe('INV-15 generations are byte-compatible with Aico', () => {
  it('matches Aico sessionGeneration, including its two null external fields', () => {
    const row = seedBound('e0000015', 1)
    setWidgetOwnership(
      row.id,
      'tmux-spawn-00000000-0000-4000-8000-000000000000.scope',
      1,
      INVOCATION,
      '$1',
      '%1',
    )
    const current = getWidget(row.id) as WidgetRow
    const aico = createHash('sha256')
      .update(
        JSON.stringify([
          current.id,
          current.sessionId,
          current.externalTmuxSocket,
          current.externalTmuxSession,
          ownershipGeneration(current),
        ]),
      )
      .digest('hex')
    expect(sessionGeneration(current)).toBe(aico)
  })
})

describe('INV-16 session and root identities are never reused', () => {
  it('skips live, root-tombstoned and retired IDs', () => {
    insertWidget('e0000016', 'shell', 1)
    store.db.prepare('DELETE FROM sessions WHERE id = ?').run('e0000016')
    const candidates = ['e0000016', 'e0000113', 'e0000013', 'e00000ff']
    expect(allocateWidgetId(() => candidates.shift() as string)).toBe('e00000ff')
  })
})

describe('INV-17 A-Term legacy sessions are attach/end only, by exact name', () => {
  it('rejects non-A-Term names and uses exact-match targets', async () => {
    const legacy = new LegacyATermSessions(join(dir, 'no-server', 'default'))
    const name = 'summitflow-11111111-2222-4333-8444-555555555555'
    expect(legacy.attachArgv(name)).toEqual([
      '/usr/bin/tmux',
      '-S',
      join(dir, 'no-server', 'default'),
      'attach-session',
      '-t',
      `=${name}`,
    ])
    expect(() => legacy.attachArgv('summitflow-x')).toThrow()
    expect(() => legacy.attachArgv('aico-e0000001')).toThrow()
    expect(await legacy.list()).toEqual([])
    expect(await legacy.end(name)).toBe(false)
    expect(await legacy.end('summitflow-*')).toBe(false)
  })
})
