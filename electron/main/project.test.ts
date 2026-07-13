import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchProjectRoot,
  fetchProjects,
  invalidateProjectCache,
  listProjects,
  listProjectsFresh,
  PERSONAL_WORKSPACE_ID,
  PERSONAL_WORKSPACE_NAME,
  personalWorkspaceRoot,
  projectRoot,
  readActiveProjectRoot,
  refreshProjects,
  widgetCwd,
} from './project'

describe('active-project pointer', () => {
  let dir: string
  let ptr: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-proj-'))
    ptr = join(dir, 'active-project.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads the project root from the pointer', () => {
    writeFileSync(ptr, JSON.stringify({ project_id: 'aico', project_root: dir }))
    expect(readActiveProjectRoot(ptr)).toBe(dir)
  })

  it('returns null when the pointer is missing', () => {
    expect(readActiveProjectRoot(join(dir, 'nope.json'))).toBeNull()
  })

  it('returns null when the pointer carries no root', () => {
    writeFileSync(ptr, JSON.stringify({ project_id: 'aico', project_root: null }))
    expect(readActiveProjectRoot(ptr)).toBeNull()
  })

  it('returns null for malformed json', () => {
    writeFileSync(ptr, '{not json')
    expect(readActiveProjectRoot(ptr)).toBeNull()
  })

  it('widgetCwd uses the active root when it is an existing directory', () => {
    writeFileSync(ptr, JSON.stringify({ project_id: 'aico', project_root: dir }))
    expect(widgetCwd('/home/me', ptr)).toBe(dir)
  })

  it('widgetCwd falls back to home when the root no longer exists', () => {
    writeFileSync(ptr, JSON.stringify({ project_id: 'aico', project_root: '/gone/missing' }))
    expect(widgetCwd('/home/me', ptr)).toBe('/home/me')
  })

  it('widgetCwd falls back to home when the pointer is unset', () => {
    expect(widgetCwd('/home/me', join(dir, 'nope.json'))).toBe('/home/me')
  })
})

describe('project catalog', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-cat-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('prepends Personal Workspace to `st projects list` results', () => {
    const exec = () =>
      JSON.stringify([
        { id: 'aico', name: 'Aico', root_path: '/opt/aico', current: true },
        { id: 'a-term', name: 'A-Term', root_path: '/opt/a-term', current: false },
      ])
    expect(fetchProjects(exec)).toEqual([
      {
        id: PERSONAL_WORKSPACE_ID,
        name: PERSONAL_WORKSPACE_NAME,
        root: personalWorkspaceRoot(),
        current: false,
      },
      { id: 'aico', name: 'Aico', root: '/opt/aico', current: true },
      { id: 'a-term', name: 'A-Term', root: '/opt/a-term', current: false },
    ])
  })

  it('fetchProjects still returns Personal Workspace when st is unavailable', () => {
    expect(
      fetchProjects(() => {
        throw new Error('command not found: st')
      }),
    ).toEqual([
      {
        id: PERSONAL_WORKSPACE_ID,
        name: PERSONAL_WORKSPACE_NAME,
        root: personalWorkspaceRoot(),
        current: false,
      },
    ])
  })

  it('fetchProjects still returns Personal Workspace for malformed output', () => {
    expect(fetchProjects(() => 'not json')).toEqual([
      {
        id: PERSONAL_WORKSPACE_ID,
        name: PERSONAL_WORKSPACE_NAME,
        root: personalWorkspaceRoot(),
        current: false,
      },
    ])
  })

  it('fetchProjectRoot creates and returns the Personal Workspace root', () => {
    vi.stubEnv('HOME', dir)
    const root = fetchProjectRoot(PERSONAL_WORKSPACE_ID, () => {
      throw new Error('st should not be called for Personal Workspace')
    })
    expect(root).toBe(join(dir, '.local', 'share', 'aico', 'personal-workspace'))
    expect(root && existsSync(root)).toBe(true)
  })

  it('fetchProjectRoot returns the root when it is an existing directory', () => {
    expect(fetchProjectRoot('aico', () => `${dir}\n`)).toBe(dir)
  })

  it('fetchProjectRoot returns null when the root no longer exists', () => {
    expect(fetchProjectRoot('aico', () => '/gone/missing')).toBeNull()
  })

  it('fetchProjectRoot returns null when st fails (unknown slug)', () => {
    expect(
      fetchProjectRoot('nope', () => {
        throw new Error('unknown project')
      }),
    ).toBeNull()
  })
})

describe('cached catalog', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aico-cache-'))
    invalidateProjectCache()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const stOutput = (root: string) =>
    JSON.stringify([{ id: 'aico', name: 'Aico', root_path: root, current: true }])

  it('listProjects serves the refreshed list synchronously', async () => {
    await refreshProjects(async () => stOutput(dir))
    expect(listProjects().map((p) => p.id)).toEqual([PERSONAL_WORKSPACE_ID, 'aico'])
  })

  it('listProjectsFresh waits for the initial catalog instead of serving the seed', async () => {
    let resolveRead!: (value: string) => void
    const read = new Promise<string>((resolve) => {
      resolveRead = resolve
    })
    let settled = false
    const pending = listProjectsFresh(async () => read)
    void pending.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    resolveRead(stOutput(dir))

    await expect(pending).resolves.toEqual([
      expect.objectContaining({ id: PERSONAL_WORKSPACE_ID }),
      expect.objectContaining({ id: 'aico', root: dir }),
    ])
  })

  it('listProjectsFresh shares an in-flight startup read', async () => {
    let calls = 0
    let resolveRead!: (value: string) => void
    const read = new Promise<string>((resolve) => {
      resolveRead = resolve
    })
    const exec = async () => {
      calls++
      return read
    }

    const first = listProjectsFresh(exec)
    const second = listProjectsFresh(exec)
    expect(calls).toBe(1)
    resolveRead(stOutput(dir))

    await Promise.all([first, second])
    expect(calls).toBe(1)
  })

  it('a failed refresh keeps the previous list', async () => {
    await refreshProjects(async () => stOutput(dir))
    invalidateProjectCache()
    await refreshProjects(async () => {
      throw new Error('st broke')
    })
    expect(listProjects().map((p) => p.id)).toEqual([PERSONAL_WORKSPACE_ID, 'aico'])
  })

  it('concurrent refreshes share one st read', async () => {
    let calls = 0
    const exec = async () => {
      calls++
      return stOutput(dir)
    }
    await Promise.all([refreshProjects(exec), refreshProjects(exec)])
    expect(calls).toBe(1)
  })

  it('projectRoot resolves a cached project without spawning st', async () => {
    await refreshProjects(async () => stOutput(dir))
    expect(projectRoot('aico')).toBe(dir)
  })

  it('projectRoot returns null for a cached project whose root vanished', async () => {
    await refreshProjects(async () => stOutput('/gone/missing'))
    expect(projectRoot('aico')).toBeNull()
  })
})
