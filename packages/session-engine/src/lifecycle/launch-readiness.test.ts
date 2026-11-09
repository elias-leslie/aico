import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_INSTANCE, resolvePaths } from '../paths'
import { Store } from '../store'
import { bindCatalog, getWidget, insertWidget } from './catalog'
import {
  configureEngine,
  ensureSessionSerialized,
  lastEnsureFailure,
  respawnAndRelaunch,
  startLifecycle,
  stopLifecycle,
} from './engine'
import { isNeverAllocatedWidget } from './lifecycle-guard'
import { setLifecycleInstance } from './ownership'
import { blankSlateBase } from './tui/blank-slate'
import { bindToolSource, getTui } from './tui/registry'

// Only the read-only command lookup may run. A regression must never allocate
// a real tmux server or invoke systemd, even with a valid durability verdict.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const unexpected = () => {
    throw new Error('launch readiness test attempted a managed process')
  }
  return {
    ...actual,
    execFile: Object.assign(
      vi.fn((file: string, ...args: unknown[]) => {
        if (file !== '/bin/sh') return unexpected()
        return Reflect.apply(actual.execFile, undefined, [file, ...args])
      }),
      { [promisify.custom]: unexpected },
    ),
    execFileSync: unexpected,
    spawnSync: unexpected,
  }
})

vi.mock('./lifetime-boundary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lifetime-boundary')>()),
  verifyDurableUserManager: () => ({ durable: true }),
}))

let dir: string
let store: Store

function present<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('missing launch-readiness fixture')
  return value
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tether-launch-readiness-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'available-agent-fixture'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const runnerBin = join(dir, 'runner-bin')
  mkdirSync(runnerBin)
  writeFileSync(join(runnerBin, 'missing-agent-fixture'), '#!/bin/sh\nexit 0\n', {
    mode: 0o700,
  })
  vi.stubEnv('PATH', runnerBin)
  vi.stubEnv('HOME', dir)
  vi.stubEnv('TETHER_LIB_DIR', join(dir, 'tether-lib'))
  store = new Store(':memory:')
  bindCatalog(store.db)
  bindToolSource(store)
  for (const name of ['missing', 'available'])
    store.createTool({
      slug: `${name}-agent-fixture`,
      name: `${name} fixture`,
      argv: [`${name}-agent-fixture`],
      processName: `${name}-agent-fixture`,
      description: null,
      color: null,
      displayOrder: 20,
      isDefault: false,
      enabled: true,
      aliases: [],
      contextHook: null,
    })
  setLifecycleInstance('readinesstest')
  configureEngine({
    paths: resolvePaths({
      instance: 'readinesstest',
      env: {
        HOME: dir,
        TETHER_STATE_DIR: join(dir, 'state'),
        TETHER_RUNTIME_DIR: join(dir, 'run'),
      },
    }),
    events: null,
    env: { HOME: dir, PATH: bin },
    projectRoot: () => null,
  })
  await startLifecycle({ reconcile: false })
})

afterAll(() => {
  stopLifecycle()
  setLifecycleInstance(DEFAULT_INSTANCE)
  bindToolSource(null)
  vi.unstubAllEnvs()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('direct agent launch readiness', () => {
  it('refuses an enabled missing executable before allocating a session', async () => {
    const id = 'ea000001'
    insertWidget(id, 'missing-agent-fixture')
    expect(await ensureSessionSerialized(id, { cols: 80, rows: 24 })).toBe(false)
    expect(lastEnsureFailure(id)).toEqual({
      code: 'workload_unavailable',
      reason: 'missing fixture cannot start: missing-agent-fixture is not installed or executable.',
    })
    expect(isNeverAllocatedWidget(present(getWidget(id)))).toBe(true)
  })

  it('finds a replacement tool on the configured pane PATH rather than the test runner PATH', async () => {
    const id = 'ea000002'
    insertWidget(id, 'shell')
    store.db.prepare('UPDATE sessions SET lifecycle_version = 1 WHERE id = ?').run(id)
    // It passed executable readiness and reached the existing pane-presence guard.
    expect(await respawnAndRelaunch(id, getTui('available-agent-fixture'))).toEqual({
      status: 'workload_unavailable',
      reason: 'tmux session state is absent',
    })
    expect(isNeverAllocatedWidget(present(getWidget(id)))).toBe(true)
  })

  it('refuses a missing replacement before changing pane ownership or metadata', async () => {
    const id = 'ea000003'
    insertWidget(id, 'shell')
    store.db.prepare('UPDATE sessions SET lifecycle_version = 1 WHERE id = ?').run(id)
    const before = getWidget(id)
    const commitMetadata = vi.fn()
    expect(
      await respawnAndRelaunch(id, getTui('missing-agent-fixture'), { commitMetadata }),
    ).toEqual({
      status: 'workload_unavailable',
      reason: 'missing fixture cannot start: missing-agent-fixture is not installed or executable.',
    })
    expect(getWidget(id)).toEqual(before)
    expect(commitMetadata).not.toHaveBeenCalled()
  })

  it('keeps bare shell replacements on the existing lifecycle path', async () => {
    const id = 'ea000004'
    insertWidget(id, 'shell')
    store.db.prepare('UPDATE sessions SET lifecycle_version = 1 WHERE id = ?').run(id)
    expect(await respawnAndRelaunch(id, getTui('shell'))).toEqual({
      status: 'workload_unavailable',
      reason: 'tmux session state is absent',
    })
  })

  it('rejects a non-executable file or directory used as an absolute command', async () => {
    const id = 'ea000005'
    insertWidget(id, 'shell')
    store.db.prepare('UPDATE sessions SET lifecycle_version = 1 WHERE id = ?').run(id)
    const file = join(dir, 'not-executable')
    writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
    for (const command of [file, dir])
      expect(
        await respawnAndRelaunch(id, {
          ...present(getTui('available-agent-fixture')),
          command: [command],
        }),
      ).toMatchObject({
        status: 'workload_unavailable',
        reason: expect.stringContaining('is not installed or executable'),
      })
  })

  it('uses the replacement cwd for a relative executable', async () => {
    const id = 'ea000006'
    insertWidget(id, 'shell')
    store.db.prepare('UPDATE sessions SET lifecycle_version = 1 WHERE id = ?').run(id)
    expect(
      await respawnAndRelaunch(
        id,
        { ...present(getTui('available-agent-fixture')), command: ['./available-agent-fixture'] },
        { cwd: join(dir, 'bin') },
      ),
    ).toEqual({ status: 'workload_unavailable', reason: 'tmux session state is absent' })
  })

  it('looks through credential shims under the configured home', async () => {
    const id = 'ea000007'
    insertWidget(id, 'shell')
    store.db.prepare('UPDATE sessions SET lifecycle_version = 1 WHERE id = ?').run(id)
    const shims = join(dir, '.local', 'lib', 'aico', 'auth-bin')
    mkdirSync(shims, { recursive: true })
    for (const name of ['missing', 'available'])
      writeFileSync(join(shims, `${name}-agent-fixture`), '#!/bin/sh\nexit 0\n', {
        mode: 0o700,
      })
    const fallbackBin = join(dir, 'fallback-bin')
    const nativeBin = join(dir, 'native-bin')
    const configHome = join(dir, 'pane-config')
    const config = join(configHome, 'aico')
    for (const path of [fallbackBin, nativeBin, config]) mkdirSync(path, { recursive: true })
    writeFileSync(join(fallbackBin, 'missing-agent-fixture'), '#!/bin/sh\nexit 0\n', {
      mode: 0o700,
    })
    const native = join(nativeBin, 'available-native')
    writeFileSync(native, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    writeFileSync(
      join(config, 'tool-commands.json'),
      JSON.stringify([
        {
          tool: 'missing-agent-fixture',
          command: 'missing-agent-fixture',
          executable: join(nativeBin, 'missing-native'),
        },
        { tool: 'available-agent-fixture', command: 'available-agent-fixture', executable: native },
      ]),
    )
    const env = { PATH: `${shims}:${fallbackBin}`, XDG_CONFIG_HOME: configHome }
    expect(
      await respawnAndRelaunch(id, { ...present(getTui('missing-agent-fixture')), env }),
    ).toMatchObject({
      status: 'workload_unavailable',
      reason: expect.stringContaining('is not installed or executable'),
    })
    expect(
      await respawnAndRelaunch(id, { ...present(getTui('available-agent-fixture')), env }),
    ).toEqual({ status: 'workload_unavailable', reason: 'tmux session state is absent' })
  })

  it('accepts an external executable whose name is also a shell builtin', async () => {
    const id = 'ea000008'
    insertWidget(id, 'shell')
    store.db.prepare('UPDATE sessions SET lifecycle_version = 1 WHERE id = ?').run(id)
    expect(
      await respawnAndRelaunch(id, {
        ...present(getTui('available-agent-fixture')),
        command: ['printf'],
        env: { PATH: '/usr/bin:/bin' },
      }),
    ).toEqual({ status: 'workload_unavailable', reason: 'tmux session state is absent' })
  })

  it('leaves executable readiness to an entry that runs its agent elsewhere', async () => {
    const id = 'ea000009'
    insertWidget(id, 'shell')
    store.db.prepare('UPDATE sessions SET lifecycle_version = 1 WHERE id = ?').run(id)
    store.db
      .prepare('INSERT INTO session_entries (session_id, name, arg) VALUES (?, ?, ?)')
      .run(id, 'fixture-entry', 'fixture')
    expect(await respawnAndRelaunch(id, getTui('missing-agent-fixture'))).toEqual({
      status: 'workload_unavailable',
      reason: 'tmux session state is absent',
    })
  })

  it('checks the native Blank Slate target before allocation or replacement', async () => {
    const root = join(blankSlateBase({ HOME: dir }), 'fixture')
    const wrapper = join(dir, 'tether-lib', 'scripts', 'aico-blank-slate')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dir, 'tether-lib', 'scripts'), { recursive: true })
    writeFileSync(wrapper, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const id = 'ea000010'
    insertWidget(id, 'codex')
    store.db.prepare('UPDATE sessions SET project_root = ? WHERE id = ?').run(root, id)
    expect(await ensureSessionSerialized(id, { cols: 80, rows: 24 })).toBe(false)
    expect(lastEnsureFailure(id)).toMatchObject({
      code: 'workload_unavailable',
      reason: expect.stringContaining('codex-real is not installed or executable'),
    })
    expect(isNeverAllocatedWidget(present(getWidget(id)))).toBe(true)
    store.db.prepare('UPDATE sessions SET lifecycle_version = 1 WHERE id = ?').run(id)
    expect(await respawnAndRelaunch(id, getTui('codex'))).toMatchObject({
      status: 'workload_unavailable',
      reason: expect.stringContaining('codex-real is not installed or executable'),
    })
    const native = join(dir, '.local', 'bin', 'codex-real')
    mkdirSync(join(dir, '.local', 'bin'), { recursive: true })
    writeFileSync(native, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    expect(await respawnAndRelaunch(id, getTui('codex'))).toEqual({
      status: 'workload_unavailable',
      reason: 'tmux session state is absent',
    })
    expect(
      await respawnAndRelaunch(id, {
        ...present(getTui('codex')),
        env: { CODEX_REAL: join(dir, 'missing-native-override') },
      }),
    ).toMatchObject({
      status: 'workload_unavailable',
      reason: expect.stringContaining('missing-native-override is not installed or executable'),
    })
  })
})
