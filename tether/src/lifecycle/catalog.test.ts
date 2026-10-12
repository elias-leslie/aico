// Ported from Aico electron/main/store.test.ts. Aico's additive-migration
// cases are replaced by seeding Tether's schema directly with the rows the
// importer copies (a historical `.scope` generation and a v0 widget).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Store } from '../store'
import {
  activateTmuxServer,
  adoptActiveLegacyTmuxServer,
  bindCatalog,
  bindWidgetTmuxServer,
  clearReconciledDeadTmuxServerBinding,
  clearReconciledHistoricalTmuxServerBinding,
  clearWidgetPendingScope,
  compareAndSetWidgetLaunchMetadata,
  compareAndSetWidgetOwnership,
  countTmuxServerReferences,
  getCurrentManagedTmuxServer,
  getTmuxServer,
  getWidget,
  insertLegacyUnclassifiedWidget,
  insertProvisioningTmuxServer,
  insertWidget,
  listTmuxServers,
  markTmuxServerDead,
  removeWidgetIfOwnership,
  setWidgetOwnership,
  setWidgetPendingScope,
} from './catalog'

const store = new Store(':memory:')
const migratedScopeServer = '00000000000000000000000000000000'

beforeAll(() => bindCatalog(store.db))
afterAll(() => store.close())

function ownership(id: string) {
  const row = getWidget(id)
  if (!row) throw new Error(`missing test widget ${id}`)
  return {
    scopeUnit: row.scopeUnit,
    scopeInvocationId: row.scopeInvocationId,
    pendingScopeUnit: row.pendingScopeUnit,
    pendingScopeInvocationId: row.pendingScopeInvocationId,
    lifecycleVersion: row.lifecycleVersion,
    tmuxServerId: row.tmuxServerId,
    tmuxAllocationState: row.tmuxAllocationState,
    tmuxSessionId: row.tmuxSessionId,
    paneId: row.paneId,
    launchState: row.launchState,
    launchNonce: row.launchNonce,
  }
}

describe('widget ownership persistence', () => {
  it('migrates legacy rows without claiming they already had narrow containment', () => {
    bindCatalog(store.db)
    store.db.exec(`
      INSERT INTO sessions (id, seq, created_at, tool, session_id, tmux_allocation_state)
      VALUES ('d0000001', 1, 1, 'codex', 'aico-widget-d0000001', 'legacy-unclassified');
      INSERT INTO tmux_servers (
        id, kind, phase, socket_path, scope_unit, control_group, invocation_id,
        server_pid, proc_starttime, created_at
      ) VALUES (
        '${migratedScopeServer}', 'managed', 'active',
        '/tmp/aico-test/${migratedScopeServer}/server.sock',
        'aico-tmux-server-${migratedScopeServer}.scope',
        '/user.slice/test/aico-tmux-server-${migratedScopeServer}.scope',
        '${'c'.repeat(32)}', 2222, '1111', 50
      );
    `)
    expect(getWidget('d0000001')).toMatchObject({
      sessionId: 'aico-widget-d0000001',
      tmuxServerId: null,
      tmuxAllocationState: 'legacy-unclassified',
      scopeUnit: null,
      scopeInvocationId: null,
      tmuxSessionId: null,
      paneId: null,
      pendingScopeUnit: null,
      pendingScopeInvocationId: null,
      launchState: 'none',
      launchNonce: null,
      lifecycleVersion: 0,
    })
    const row = insertWidget('a0000001', 'codex')
    expect(row.sessionId).toBe('aico-widget-a0000001')
    expect(row.tmuxAllocationState).toBe('unallocated')
    setWidgetOwnership('a0000001', 'tmux-spawn-123.scope', 1, 'invocation-current', '$3', '%7')
    expect(getWidget('a0000001')).toMatchObject({
      scopeUnit: 'tmux-spawn-123.scope',
      scopeInvocationId: 'invocation-current',
      tmuxSessionId: '$3',
      paneId: '%7',
      lifecycleVersion: 1,
    })

    const observed = insertLegacyUnclassifiedWidget('b0000001', 'shell', 3)
    expect(observed.tmuxAllocationState).toBe('legacy-unclassified')
  })

  it('retains replacement cleanup authority until the exact old scope is cleared', () => {
    expect(
      setWidgetPendingScope(
        'a0000001',
        ownership('a0000001'),
        'tmux-spawn-old.scope',
        'invocation-old',
      ),
    ).toBe(true)
    setWidgetOwnership('a0000001', 'tmux-spawn-new.scope', 1, 'invocation-new', '$3', '%8')
    expect(getWidget('a0000001')).toMatchObject({
      scopeUnit: 'tmux-spawn-new.scope',
      scopeInvocationId: 'invocation-new',
      pendingScopeUnit: 'tmux-spawn-old.scope',
      pendingScopeInvocationId: 'invocation-old',
      tmuxSessionId: '$3',
      paneId: '%8',
    })

    expect(clearWidgetPendingScope('a0000001', 'tmux-spawn-wrong.scope', 'invocation-old')).toBe(
      false,
    )
    expect(removeWidgetIfOwnership('a0000001', ownership('a0000001'))).toBe(false)
    expect(clearWidgetPendingScope('a0000001', 'tmux-spawn-old.scope', 'wrong')).toBe(false)
    expect(clearWidgetPendingScope('a0000001', 'tmux-spawn-old.scope', 'invocation-old')).toBe(true)
    const current = ownership('a0000001')
    expect(
      removeWidgetIfOwnership('a0000001', {
        ...current,
        scopeUnit: 'tmux-spawn-old.scope',
        scopeInvocationId: 'invocation-old',
      }),
    ).toBe(false)
    expect(
      removeWidgetIfOwnership('a0000001', {
        ...current,
        scopeInvocationId: 'wrong-invocation',
      }),
    ).toBe(false)
    expect(removeWidgetIfOwnership('a0000001', current)).toBe(true)
    expect(getWidget('a0000001')).toBeUndefined()
  })

  it('refuses a stale ownership promotion instead of overwriting cleanup evidence', () => {
    const row = insertWidget('a0000002', 'shell')
    const expected = {
      scopeUnit: row.scopeUnit,
      scopeInvocationId: row.scopeInvocationId,
      pendingScopeUnit: row.pendingScopeUnit,
      pendingScopeInvocationId: row.pendingScopeInvocationId,
      lifecycleVersion: row.lifecycleVersion,
      tmuxServerId: row.tmuxServerId,
      tmuxAllocationState: row.tmuxAllocationState,
      tmuxSessionId: row.tmuxSessionId,
      paneId: row.paneId,
      launchState: row.launchState,
      launchNonce: row.launchNonce,
    }
    expect(
      setWidgetPendingScope(
        'a0000002',
        ownership('a0000002'),
        'tmux-spawn-unresolved.scope',
        'old-invocation',
      ),
    ).toBe(true)

    expect(
      compareAndSetWidgetOwnership('a0000002', expected, {
        ...expected,
        scopeUnit: 'tmux-spawn-new.scope',
        scopeInvocationId: 'new-invocation',
        lifecycleVersion: 1,
        tmuxSessionId: '$4',
        paneId: '%9',
      }),
    ).toBe(false)
    expect(getWidget('a0000002')).toMatchObject({
      scopeUnit: null,
      pendingScopeUnit: 'tmux-spawn-unresolved.scope',
      pendingScopeInvocationId: 'old-invocation',
      tmuxSessionId: null,
      paneId: null,
    })
  })
})

describe('tmux server generation persistence', () => {
  const managedA = '11111111111111111111111111111111'
  const managedB = '22222222222222222222222222222222'
  const legacyA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const invocationA = 'a'.repeat(32)
  const invocationB = 'b'.repeat(32)

  it('migrates the server catalog and enforces one immutable live managed generation', () => {
    const serverTable = store.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = 'tmux_servers'")
      .get() as { name: string; sql: string }
    expect(serverTable.sql).toContain("scope_unit = 'aico-tmux-server-' || id || '.service'")
    expect(getTmuxServer(migratedScopeServer)).toMatchObject({
      kind: 'managed',
      phase: 'active',
      scopeUnit: `aico-tmux-server-${migratedScopeServer}.scope`,
      serverPid: 2222,
      deadAt: null,
    })
    // The historical caller-spawned scope remains observable, but it does not
    // occupy the one allocatable clean-FD service-generation slot.
    expect(getCurrentManagedTmuxServer()).toBeUndefined()

    const provisioning = insertProvisioningTmuxServer({
      id: managedA,
      socketPath: `/tmp/aico-test/${managedA}/server.sock`,
      scopeUnit: `aico-tmux-server-${managedA}.service`,
      createdAt: 100,
    })
    expect(provisioning).toMatchObject({
      id: managedA,
      kind: 'managed',
      phase: 'provisioning',
      serverPid: null,
      procStartTime: null,
    })
    expect(getCurrentManagedTmuxServer()?.id).toBe(managedA)

    expect(() =>
      insertProvisioningTmuxServer({
        id: managedB,
        socketPath: `/tmp/aico-test/${managedB}/wrong-scope.sock`,
        scopeUnit: `aico-tmux-server-${managedB}.scope`,
        createdAt: 101,
      }),
    ).toThrow(/managed tmux server unit does not match generation/)

    expect(() =>
      insertProvisioningTmuxServer({
        id: managedB,
        socketPath: `/tmp/aico-test/${managedB}/server.sock`,
        scopeUnit: `aico-tmux-server-${managedB}.service`,
        createdAt: 101,
      }),
    ).toThrow()

    expect(
      activateTmuxServer(managedA, {
        controlGroup: `/user.slice/test/${provisioning.scopeUnit}`,
        invocationId: invocationA,
        serverPid: 1234,
        procStartTime: '987654',
      }),
    ).toBe(true)
    expect(getTmuxServer(managedA)).toMatchObject({
      phase: 'active',
      controlGroup: `/user.slice/test/${provisioning.scopeUnit}`,
      invocationId: invocationA,
      serverPid: 1234,
      procStartTime: '987654',
      deadAt: null,
    })
    expect(
      activateTmuxServer(managedA, {
        controlGroup: `/wrong/${provisioning.scopeUnit}`,
        invocationId: invocationB,
        serverPid: 9999,
        procStartTime: '1',
      }),
    ).toBe(false)
    expect(getTmuxServer(managedA)?.serverPid).toBe(1234)

    expect(markTmuxServerDead(managedA, 200)).toBe(true)
    expect(markTmuxServerDead(managedA, 201)).toBe(false)
    expect(getTmuxServer(managedA)).toMatchObject({
      phase: 'dead',
      serverPid: 1234,
      procStartTime: '987654',
      deadAt: 200,
    })

    const next = insertProvisioningTmuxServer({
      id: managedB,
      socketPath: `/tmp/aico-test/${managedB}/server.sock`,
      scopeUnit: `aico-tmux-server-${managedB}.service`,
      createdAt: 300,
    })
    expect(next.phase).toBe('provisioning')
    expect(() =>
      insertProvisioningTmuxServer({
        id: '33333333333333333333333333333333',
        socketPath: `/tmp/aico-test/${managedA}/server.sock`,
        scopeUnit: 'aico-tmux-server-33333333333333333333333333333333.service',
        createdAt: 301,
      }),
    ).toThrow()
  })

  it('adopts a fully observed legacy identity without granting managed-current status', () => {
    const adopted = adoptActiveLegacyTmuxServer({
      id: legacyA,
      socketPath: '/tmp/tmux-1000/aico',
      scopeUnit: 'app-aico-9189.scope',
      controlGroup: '/user.slice/user-1000.slice/app.slice/app-aico-9189.scope',
      invocationId: invocationB,
      serverPid: 4321,
      procStartTime: '123456',
      createdAt: 150,
    })
    expect(adopted).toMatchObject({
      kind: 'legacy-observed',
      phase: 'active',
      scopeUnit: 'app-aico-9189.scope',
      serverPid: 4321,
    })
    expect(getCurrentManagedTmuxServer()?.id).toBe(managedB)
    expect(listTmuxServers().map((server) => server.id)).toEqual([
      migratedScopeServer,
      managedA,
      legacyA,
      managedB,
    ])
    expect(() =>
      adoptActiveLegacyTmuxServer({
        id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        socketPath: adopted.socketPath,
        scopeUnit: adopted.scopeUnit,
        controlGroup: adopted.controlGroup as string,
        invocationId: adopted.invocationId as string,
        serverPid: adopted.serverPid as number,
        procStartTime: adopted.procStartTime as string,
        createdAt: 151,
      }),
    ).toThrow()
  })

  it('binds a widget and stable ids only from the exact expected generation', () => {
    expect(
      activateTmuxServer(managedB, {
        controlGroup: `/user.slice/test/aico-tmux-server-${managedB}.service`,
        invocationId: invocationB,
        serverPid: 5678,
        procStartTime: '333333',
      }),
    ).toBe(true)
    const row = insertWidget('a0000003', 'shell')
    expect(bindWidgetTmuxServer(row.id, null, managedB, '$5', '%10')).toBe(true)
    expect(getWidget(row.id)).toMatchObject({
      tmuxServerId: managedB,
      tmuxAllocationState: 'bound',
      tmuxSessionId: '$5',
      paneId: '%10',
    })
    expect(countTmuxServerReferences(managedB)).toBe(1)

    expect(bindWidgetTmuxServer(row.id, null, legacyA, '$6', '%11')).toBe(false)
    expect(bindWidgetTmuxServer(row.id, managedB, legacyA, '$6', '%11')).toBe(false)
    expect(bindWidgetTmuxServer(row.id, managedB, managedB, '$7', '%12')).toBe(false)
    expect(bindWidgetTmuxServer(row.id, managedB, managedB, '$5', '%10')).toBe(true)
    // A generation-only bind confirms the server without clearing its stable ids.
    expect(bindWidgetTmuxServer(row.id, managedB, managedB)).toBe(true)
    expect(getWidget(row.id)).toMatchObject({
      tmuxServerId: managedB,
      tmuxSessionId: '$5',
      paneId: '%10',
    })

    expect(markTmuxServerDead(legacyA, 400)).toBe(true)
    const unbound = insertWidget('a0000004', 'shell')
    expect(bindWidgetTmuxServer(unbound.id, null, legacyA, '$9', '%14')).toBe(false)

    const launchGeneration = ownership(row.id)
    expect(
      compareAndSetWidgetLaunchMetadata(
        row.id,
        launchGeneration,
        'codex',
        'aico',
        '/home/demo/projects/aico',
      ),
    ).toBe(true)
    expect(
      compareAndSetWidgetLaunchMetadata(
        row.id,
        { ...launchGeneration, paneId: '%999' },
        'claude-code',
        null,
        null,
      ),
    ).toBe(false)
    expect(getWidget(row.id)).toMatchObject({
      tool: 'codex',
      projectId: 'aico',
      projectRoot: '/home/demo/projects/aico',
    })

    const beforeGate = ownership(row.id)
    const gated = {
      ...beforeGate,
      launchState: 'gated' as const,
      launchNonce: '0123456789abcdef0123456789abcdef',
    }
    expect(compareAndSetWidgetOwnership(row.id, beforeGate, gated)).toBe(true)
    const dispatched = { ...gated, launchState: 'dispatched' as const }
    expect(compareAndSetWidgetOwnership(row.id, gated, dispatched)).toBe(true)
    // The persisted gated generation is consumed exactly once.
    expect(compareAndSetWidgetOwnership(row.id, gated, dispatched)).toBe(false)
    expect(getWidget(row.id)).toMatchObject({
      launchState: 'dispatched',
      launchNonce: gated.launchNonce,
    })
  })

  it('unbinds only a fully reconciled widget from an active historical managed scope', () => {
    const historical = insertWidget('c0000001', 'shell')
    expect(bindWidgetTmuxServer(historical.id, null, migratedScopeServer, '$6', '%11')).toBe(true)

    // Stable pane identity and either persisted scope generation remain cleanup
    // authority and must block a server migration.
    expect(
      setWidgetPendingScope(
        historical.id,
        ownership(historical.id),
        'tmux-spawn-historical.scope',
        invocationA,
      ),
    ).toBe(true)
    expect(clearReconciledHistoricalTmuxServerBinding(historical.id, migratedScopeServer)).toBe(
      false,
    )
    expect(clearWidgetPendingScope(historical.id, 'tmux-spawn-historical.scope', invocationA)).toBe(
      true,
    )
    expect(clearReconciledHistoricalTmuxServerBinding(historical.id, migratedScopeServer)).toBe(
      false,
    )

    setWidgetOwnership(historical.id, 'tmux-spawn-current.scope', 1, invocationA, null, null)
    expect(clearReconciledHistoricalTmuxServerBinding(historical.id, migratedScopeServer)).toBe(
      false,
    )
    setWidgetOwnership(historical.id, null, 0, null, null, null)
    expect(clearReconciledHistoricalTmuxServerBinding(historical.id, migratedScopeServer)).toBe(
      false,
    )
    setWidgetOwnership(historical.id, null, 1, null, null, null)
    expect(clearReconciledHistoricalTmuxServerBinding(historical.id, managedB)).toBe(false)
    expect(clearReconciledHistoricalTmuxServerBinding(historical.id, migratedScopeServer)).toBe(
      true,
    )
    expect(clearReconciledHistoricalTmuxServerBinding(historical.id, migratedScopeServer)).toBe(
      false,
    )
    expect(getWidget(historical.id)).toMatchObject({
      tmuxServerId: null,
      tmuxAllocationState: 'unallocated',
      tmuxSessionId: null,
      paneId: null,
    })

    // An active clean-FD service generation is never eligible for this escape
    // hatch, even when the widget row otherwise looks fully reconciled.
    const service = insertWidget('c0000002', 'shell')
    expect(bindWidgetTmuxServer(service.id, null, managedB, '$7', '%12')).toBe(true)
    setWidgetOwnership(service.id, null, 1, null, null, null)
    expect(clearReconciledHistoricalTmuxServerBinding(service.id, managedB)).toBe(false)
    expect(getWidget(service.id)).toMatchObject({
      tmuxServerId: managedB,
      tmuxAllocationState: 'bound',
    })
    expect(removeWidgetIfOwnership(service.id, ownership(service.id))).toBe(true)
  })

  it('includes the server generation in ownership compare-and-set authority', () => {
    const row = getWidget('a0000003')
    expect(row).toBeDefined()
    const expected = {
      scopeUnit: row?.scopeUnit ?? null,
      scopeInvocationId: row?.scopeInvocationId ?? null,
      pendingScopeUnit: row?.pendingScopeUnit ?? null,
      pendingScopeInvocationId: row?.pendingScopeInvocationId ?? null,
      lifecycleVersion: row?.lifecycleVersion ?? 0,
      tmuxServerId: row?.tmuxServerId ?? null,
      tmuxAllocationState: row?.tmuxAllocationState ?? 'unallocated',
      tmuxSessionId: row?.tmuxSessionId ?? null,
      paneId: row?.paneId ?? null,
      launchState: row?.launchState ?? 'none',
      launchNonce: row?.launchNonce ?? null,
    }
    expect(
      compareAndSetWidgetOwnership('a0000003', expected, {
        ...expected,
        scopeUnit: 'tmux-spawn-owned.scope',
        scopeInvocationId: invocationA,
        lifecycleVersion: 1,
      }),
    ).toBe(true)

    const promoted = getWidget('a0000003')
    expect(promoted).toBeDefined()
    const promotedGeneration = {
      scopeUnit: promoted?.scopeUnit ?? null,
      scopeInvocationId: promoted?.scopeInvocationId ?? null,
      pendingScopeUnit: promoted?.pendingScopeUnit ?? null,
      pendingScopeInvocationId: promoted?.pendingScopeInvocationId ?? null,
      lifecycleVersion: promoted?.lifecycleVersion ?? 0,
      tmuxServerId: promoted?.tmuxServerId ?? null,
      tmuxAllocationState: promoted?.tmuxAllocationState ?? 'unallocated',
      tmuxSessionId: promoted?.tmuxSessionId ?? null,
      paneId: promoted?.paneId ?? null,
      launchState: promoted?.launchState ?? 'none',
      launchNonce: promoted?.launchNonce ?? null,
    }
    expect(
      compareAndSetWidgetOwnership('a0000003', promotedGeneration, {
        ...promotedGeneration,
        tmuxAllocationState: 'unallocated',
        tmuxServerId: null,
      }),
    ).toBe(false)

    expect(
      compareAndSetWidgetOwnership(
        'a0000003',
        { ...expected, tmuxServerId: legacyA },
        { ...expected, tmuxServerId: legacyA, paneId: '%99' },
      ),
    ).toBe(false)
    expect(getWidget('a0000003')).toMatchObject({
      tmuxServerId: managedB,
      scopeUnit: 'tmux-spawn-owned.scope',
      paneId: '%10',
    })

    // Omitted or null server arguments preserve the binding. Only a guarded
    // reconciled-server API may turn a bound row back into unallocated.
    expect(clearReconciledDeadTmuxServerBinding('a0000003', managedB)).toBe(false)
    setWidgetOwnership('a0000003', null, 1, null, null, null)
    expect(getWidget('a0000003')?.tmuxServerId).toBe(managedB)
    setWidgetOwnership('a0000003', null, 1, null, null, null, null)
    expect(getWidget('a0000003')).toMatchObject({
      tmuxServerId: managedB,
      tmuxAllocationState: 'bound',
      scopeUnit: null,
      scopeInvocationId: null,
      tmuxSessionId: null,
      paneId: null,
    })
    expect(clearReconciledDeadTmuxServerBinding('a0000003', managedB)).toBe(false)

    expect(markTmuxServerDead(managedB, 500)).toBe(true)
    expect(clearReconciledDeadTmuxServerBinding('a0000003', legacyA)).toBe(false)
    expect(clearReconciledDeadTmuxServerBinding('a0000003', managedB)).toBe(true)
    expect(clearReconciledDeadTmuxServerBinding('a0000003', managedB)).toBe(false)
    expect(getWidget('a0000003')).toMatchObject({
      tmuxServerId: null,
      tmuxAllocationState: 'unallocated',
    })
    expect(countTmuxServerReferences(managedB)).toBe(0)
    const provisioningOnly = '44444444444444444444444444444444'
    insertProvisioningTmuxServer({
      id: provisioningOnly,
      socketPath: `/tmp/aico-test/${provisioningOnly}/server.sock`,
      scopeUnit: `aico-tmux-server-${provisioningOnly}.service`,
      createdAt: 501,
    })
    expect(markTmuxServerDead(provisioningOnly, 502)).toBe(true)
    expect(getTmuxServer(provisioningOnly)).toMatchObject({
      phase: 'dead',
      serverPid: null,
      invocationId: null,
      deadAt: 502,
    })
    expect(
      activateTmuxServer(provisioningOnly, {
        controlGroup: `/user.slice/test/aico-tmux-server-${provisioningOnly}.scope`,
        invocationId: invocationA,
        serverPid: 9999,
        procStartTime: '9999',
      }),
    ).toBe(false)
  })
})
